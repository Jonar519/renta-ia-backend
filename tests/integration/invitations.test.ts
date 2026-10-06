import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import {
  app,
  authHeader,
  createAccount,
  createClient,
  invitationTokenFor,
  invite,
  testAdmin,
  TEST_PASSWORD,
  unique,
} from "../helpers";
import { prisma } from "../../src/config/prisma";
import { flushAudit } from "../../src/services/audit/audit.service";
import { createSignedToken, hashToken } from "../../src/utils/signedToken";
import * as email from "../../src/services/email";

/**
 * Alta de cuentas SOLO por invitación (B5): el admin invita, el token firmado
 * viaja solo por correo (email_outbox con el proveedor simulado), la base
 * guarda solo su hash, y la persona activa su cuenta con su contraseña.
 */

const lookup = (token: string) => request(app).post("/api/auth/invitations/lookup").send({ token });
const accept = (token: string, password = TEST_PASSWORD) =>
  request(app).post("/api/auth/invitations/accept").send({ token, password });
const INVALID = /El enlace de invitación no es válido o ya venció/;

afterEach(() => vi.restoreAllMocks());

describe("el token de invitación solo viaja por correo", () => {
  it("NO aparece en ninguna respuesta al admin, ni en sus cabeceras, ni en el registro de auditoría", async () => {
    const admin = await testAdmin();
    const asAdmin = (method: "get" | "post" | "delete", url: string, body?: object) =>
      request(app)[method](url).set(authHeader(admin.token)).send(body);
    const responses: request.Response[] = [];
    const startedAt = new Date();

    // Invitar, listar, reenviar (nuevo token) y cancelar: todo lo que hace el admin.
    const to = `secreto-${unique()}@test.local`;
    const created = await asAdmin("post", "/api/admin/invitations", { name: "Secreto", email: to, role: "accountant" });
    expect(created.status).toBe(201);
    responses.push(created);
    const firstToken = await invitationTokenFor(to);
    responses.push(await asAdmin("get", "/api/admin/invitations"));
    const resent = await asAdmin("post", `/api/admin/invitations/${created.body.userId}/resend`);
    expect(resent.status).toBe(200);
    responses.push(resent);
    const secondToken = await invitationTokenFor(to);
    expect(secondToken).not.toBe(firstToken);
    responses.push(await asAdmin("get", "/api/admin/invitations"));
    responses.push(await asAdmin("get", `/api/admin/audit?limit=100`));
    const cancelled = await asAdmin("delete", `/api/admin/invitations/${created.body.userId}`);
    expect(cancelled.status).toBe(204);
    responses.push(cancelled);
    await flushAudit();

    const secrets = [firstToken, secondToken].flatMap((t) => [t, ...t.split("."), hashToken(t)]);
    for (const res of responses) {
      const visible = JSON.stringify({ body: res.body, text: res.text, headers: res.headers });
      for (const secret of secrets) expect(visible).not.toContain(secret);
      expect(visible).not.toMatch(/invitacion\//);
    }

    // Auditoría: todas las columnas de todas las filas escritas durante el flujo.
    const auditRows = await prisma.auditLog.findMany({ where: { createdAt: { gte: startedAt } } });
    expect(auditRows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["admin.invitation.create", "admin.invitation.resend", "admin.invitation.cancel"])
    );
    const auditDump = JSON.stringify(auditRows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const secret of secrets) expect(auditDump).not.toContain(secret);
  });

  it("la respuesta al admin trae estado y vencimiento (72 h), y nunca campos de token o enlace", async () => {
    const admin = await testAdmin();
    const res = await request(app)
      .post("/api/admin/invitations")
      .set(authHeader(admin.token))
      .send({ name: "Vista", email: `vista-${unique()}@test.local`, role: "accountant" });
    expect(Object.keys(res.body).sort()).toEqual(
      ["accountant", "client", "email", "expiresAt", "invitedAt", "name", "role", "status", "userId"].sort()
    );
    expect(res.body.status).toBe("pending");
    const hours = (Date.parse(res.body.expiresAt) - Date.parse(res.body.invitedAt)) / 3_600_000;
    expect(hours).toBe(72);
  });

  it("la base guarda solo el SHA-256 del token; el correo lleva el enlace con el token en el fragmento (#)", async () => {
    const { email: to, userId } = await invite({ role: "accountant" });
    const token = await invitationTokenFor(to);
    const mail = await prisma.emailOutbox.findFirstOrThrow({ where: { toAddress: to, template: "invitation" } });
    expect(mail.bodyText).toContain(`/#/invitacion/${token}`);
    const [row] = await prisma.userInvitation.findMany({ where: { userId } });
    expect(row!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });
});

describe("pantalla pública 'Completa tu cuenta'", () => {
  it("un enlace válido muestra a quién corresponde; para un admin indica que debe activar MFA", async () => {
    const { email: to } = await invite({ role: "admin", name: "Nueva admin" });
    const res = await lookup(await invitationTokenFor(to));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Nueva admin", email: to, role: "admin", mfaRequired: true });
  });

  it("token inexistente, alterado o de OTRO propósito: 410 con el mismo mensaje", async () => {
    const { email: to } = await invite({ role: "accountant" });
    const token = await invitationTokenFor(to);
    const [body, signature] = token.split(".");
    const tampered = `${body}.${signature!.slice(0, -2)}${signature!.endsWith("AA") ? "BB" : "AA"}`;
    const otherPurpose = createSignedToken("password_reset").token;
    const invented = createSignedToken("invitation").token; // firma válida, pero no está en la base

    const results = await Promise.all([tampered, otherPurpose, invented, "basura"].map((t) => lookup(t)));
    for (const res of results) {
      expect(res.status).toBe(410);
      expect(res.body.error).toMatch(INVALID);
    }
    expect(new Set(results.map((r) => r.text)).size).toBe(1);
  });
});

describe("activar la cuenta", () => {
  it("define la contraseña, inicia sesión y el enlace deja de servir (un solo uso)", async () => {
    const { email: to, userId } = await invite({ role: "accountant" });
    const token = await invitationTokenFor(to);
    const res = await accept(token);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: userId, email: to, role: "accountant" });
    expect(String(res.headers["set-cookie"])).toMatch(/renta_ia_refresh=/);
    expect(await prisma.userInvitation.count({ where: { userId } })).toBe(0);

    const again = await accept(token, "otra frase larga distinta");
    expect(again.status).toBe(410);
    const login = await request(app).post("/api/auth/login").send({ email: to, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
  });

  it("dos activaciones simultáneas con el mismo enlace: solo una gana", async () => {
    const { email: to } = await invite({ role: "accountant" });
    const token = await invitationTokenFor(to);
    const results = await Promise.all([accept(token), accept(token, "segunda frase muy distinta")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
  });

  it("un enlace vencido no sirve (410), aunque la cuenta siga pendiente", async () => {
    const { email: to, userId } = await invite({ role: "accountant" });
    const token = await invitationTokenFor(to);
    await prisma.$executeRawUnsafe(
      `UPDATE user_invitations SET created_at = now() - interval '73 hours', expires_at = now() - interval '1 hour' WHERE user_id = $1::uuid`,
      userId
    );
    expect((await lookup(token)).status).toBe(410);
    expect((await accept(token)).status).toBe(410);
    const list = await request(app)
      .get("/api/admin/invitations")
      .set(authHeader((await testAdmin()).token));
    expect(list.body.items.find((i: { userId: string }) => i.userId === userId).status).toBe("expired");
  });
});

describe("reenviar y cancelar", () => {
  it("reenviar invalida el enlace anterior y deja uno solo vigente", async () => {
    const admin = await testAdmin();
    const { email: to, userId } = await invite({ role: "accountant" });
    const oldToken = await invitationTokenFor(to);
    const res = await request(app).post(`/api/admin/invitations/${userId}/resend`).set(authHeader(admin.token));
    expect(res.status).toBe(200);
    const newToken = await invitationTokenFor(to);
    expect((await lookup(oldToken)).status).toBe(410);
    expect((await lookup(newToken)).status).toBe(200);
    expect(await prisma.userInvitation.count({ where: { userId, revokedAt: null } })).toBe(1);
  });

  it("cancelar elimina la cuenta PENDIENTE y libera el correo; una cuenta activa no se puede cancelar", async () => {
    const admin = await testAdmin();
    const { email: to, userId } = await invite({ role: "accountant" });
    const token = await invitationTokenFor(to);
    const del = await request(app).delete(`/api/admin/invitations/${userId}`).set(authHeader(admin.token));
    expect(del.status).toBe(204);
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
    expect((await lookup(token)).status).toBe(410);
    await expect(invite({ role: "accountant", email: to })).resolves.toMatchObject({ email: to });

    const active = await createAccount("Activa");
    const notPending = await request(app)
      .delete(`/api/admin/invitations/${active.user.id}`)
      .set(authHeader(admin.token));
    expect(notPending.status).toBe(404);
    expect(await prisma.user.findUnique({ where: { id: active.user.id } })).toMatchObject({ status: "active" });
  });
});

describe("relaciones creadas al invitar (cuenta pendiente, sin acceso)", () => {
  it("el asistente queda ligado a su contador y el portal a su expediente desde la invitación", async () => {
    const accountant = await createAccount("Contador con equipo");
    const clientId = (await createClient(accountant.token)).id;

    const assistant = await invite({ role: "assistant", accountantUserId: accountant.user.id });
    expect(assistant.view.accountant).toEqual({ id: accountant.user.id, name: "Contador con equipo" });
    expect(
      await prisma.accountantAssistant.count({
        where: { assistantUserId: assistant.userId, accountantUserId: accountant.user.id },
      })
    ).toBe(1);

    const portal = await invite({ role: "client", clientId });
    expect(portal.view.client).toEqual({ id: clientId, fullName: "Cliente de prueba" });

    // Pendientes: no pueden iniciar sesión con ninguna contraseña.
    for (const to of [assistant.email, portal.email]) {
      const login = await request(app).post("/api/auth/login").send({ email: to, password: TEST_PASSWORD });
      expect(login.status).toBe(401);
    }
  });
});

describe("si el correo no se puede enviar", () => {
  it("responde 502, la invitación queda creada y Reenviar la recupera", async () => {
    const admin = await testAdmin();
    vi.spyOn(email, "sendEmail").mockRejectedValueOnce(new email.EmailDeliveryError("SES caído", "ses"));
    const to = `caido-${unique()}@test.local`;
    const res = await request(app)
      .post("/api/admin/invitations")
      .set(authHeader(admin.token))
      .send({ name: "Caído", email: to, role: "accountant" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Reenviar/);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: to } });
    const resent = await request(app).post(`/api/admin/invitations/${user.id}/resend`).set(authHeader(admin.token));
    expect(resent.status).toBe(200);
    expect((await lookup(await invitationTokenFor(to))).status).toBe(200);
  });
});
