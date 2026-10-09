import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import {
  Account,
  acceptInvitation,
  app,
  authHeader,
  createAccount,
  createAccountWithRole,
  createClient,
  createDocument,
  invite,
  testAdmin,
  TEST_PASSWORD,
} from "../helpers";
import { prisma } from "../../src/config/prisma";
import { env } from "../../src/config/env";
import { flushAudit } from "../../src/services/audit/audit.service";
import { REFRESH_COOKIE } from "../../src/modules/auth/sessions.service";
import { base32Decode, totp } from "../../src/modules/mfa/totp";
import { REAL_PNG } from "../fixtures/images";

/**
 * Exportar y eliminar la propia cuenta (B14; migraciones 023-024;
 * docs/data-retention.md). La cuenta eliminada queda como lápida anónima:
 * documents.uploaded_by es ON DELETE RESTRICT y los documentos son del
 * expediente del cliente.
 */

const exportData = (a: Account, password = TEST_PASSWORD) =>
  request(app).post("/api/users/me/export").set(authHeader(a.token)).send({ password });
const deletionStatus = (a: Account) => request(app).get("/api/users/me/deletion").set(authHeader(a.token));
const deleteAccount = (a: Account, body: { password?: string; code?: string } = { password: TEST_PASSWORD }) =>
  request(app).post("/api/users/me/deletion").set(authHeader(a.token)).send(body);
const me = (a: Account) => request(app).get("/api/users/me").set(authHeader(a.token));
const onDisk = (key: string) => fs.existsSync(path.join(path.resolve(env.storageLocalPath), key));

/** Activa el MFA de la cuenta por la API; devuelve el secreto y los códigos de recuperación. */
async function enableMfa(a: Account) {
  const setup = await request(app)
    .post("/api/users/me/mfa/setup")
    .set(authHeader(a.token))
    .send({ password: TEST_PASSWORD });
  const secret = base32Decode(setup.body.secret);
  const enable = await request(app)
    .post("/api/users/me/mfa/enable")
    .set(authHeader(a.token))
    .send({ code: totp(secret) });
  expect(enable.status).toBe(200);
  return { secret, recoveryCodes: enable.body.recoveryCodes as string[] };
}

describe("exportar mis datos", () => {
  it("pide la contraseña; descarga un JSON con la cuenta, sesiones, actividad, IA y documentos subidos", async () => {
    const account = await createAccount("Exporta Datos");
    await request(app).patch("/api/users/me").set(authHeader(account.token)).send({ phone: "+57 300 123 4567" });
    await request(app)
      .post("/api/users/me/avatar")
      .set(authHeader(account.token))
      .attach("avatar", REAL_PNG, { filename: "foto.png", contentType: "image/png" });
    const client = await createClient(account.token);
    const doc = await createDocument(client.id, account.user.id);
    await prisma.aiConversation.create({
      data: {
        clientId: client.id,
        userId: account.user.id,
        messages: { create: [{ role: "user", content: "¿Cuánto retuvieron en 2025?" }] },
      },
    });

    expect((await exportData(account, "no-es-la-clave")).status).toBe(400);
    const res = await exportData(account);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="renta-ia-mis-datos-\d{4}-\d{2}-\d{2}\.json"$/
    );
    expect(res.headers["cache-control"]).toBe("no-store");
    const data = res.body;
    expect(data.format).toBe("renta-ia-export-v1");
    expect(data.account).toMatchObject({
      id: account.user.id,
      email: account.email,
      name: "Exporta Datos",
      phone: "+57 300 123 4567",
    });
    expect(data.account.photo.dataUri).toBe(`data:image/png;base64,${REAL_PNG.toString("base64")}`);
    expect(data.activeSessions.length).toBeGreaterThanOrEqual(1);
    expect(data.uploadedDocuments).toEqual([expect.objectContaining({ id: doc.id, clientId: client.id })]);
    expect(data.aiConversations[0].messages[0].content).toBe("¿Cuánto retuvieron en 2025?");
    expect(data.clientsInCharge).toBe(1);
    expect(data.twoStepVerification.enabled).toBe(false);
    // Nada secreto: ni hashes ni el secreto del MFA ni tokens.
    const raw = JSON.stringify(data);
    for (const secret of ["passwordHash", "$2b$", "secretCiphertext", "tokenHash", "keyHash"]) {
      expect(raw.includes(secret), secret).toBe(false);
    }
    // Los datos de los clientes que atiende no son suyos: solo cuántos.
    expect(raw.includes("Cliente de prueba")).toBe(false);

    await flushAudit();
    expect(await prisma.auditLog.count({ where: { action: "user.data.export", userId: account.user.id } })).toBe(1);
  });

  it("la actividad de OTRA cuenta sobre la mía se incluye sin su IP ni su navegador", async () => {
    const account = await createAccount("Actividad Ajena");
    await enableMfa(account);
    const admin = await testAdmin();
    await request(app).delete(`/api/admin/users/${account.user.id}/mfa`).set(authHeader(admin.token));
    // El reset cerró las sesiones: vuelve a entrar.
    const login = await request(app).post("/api/auth/login").send({ email: account.email, password: TEST_PASSWORD });
    const data = (await exportData({ ...account, token: login.body.accessToken })).body;
    const byOther = data.activity.filter((e: { byYou: boolean }) => !e.byYou);
    expect(byOther.length).toBeGreaterThan(0);
    for (const e of byOther) expect(Object.keys(e)).not.toEqual(expect.arrayContaining(["ip"]));
    const mine = data.activity.find((e: { byYou: boolean; action: string }) => e.byYou && e.action === "mfa.enabled");
    expect(mine).toHaveProperty("ip");
  });

  it("el usuario del portal recibe los datos de SU cliente", async () => {
    const accountant = await createAccount("Contador Portal Export");
    const client = await createClient(accountant.token);
    const portal = await createAccountWithRole("client", { clientId: client.id });
    const data = (await exportData(portal)).body;
    expect(data.portalClient).toMatchObject({ id: client.id, fullName: "Cliente de prueba" });
  });

  it("sin sesión: 401", async () => {
    expect((await request(app).post("/api/users/me/export").send({ password: "x" })).status).toBe(401);
  });
});

describe("eliminar mi cuenta", () => {
  it("un contador con clientes no puede: lo dice antes (estado) y al intentarlo (409); nada cambia", async () => {
    const account = await createAccount("Con Clientes");
    await createClient(account.token);
    const status = await deletionStatus(account);
    expect(status.body).toEqual({ canDelete: false, reason: expect.stringContaining("1 cliente a tu cargo") });
    const res = await deleteAccount(account);
    expect(res.status).toBe(409);
    expect((await me(account)).status).toBe(200);
  });

  it("el único administrador activo no puede (409)", async () => {
    const admin = await createAccountWithRole("admin", { name: "Admin Que Se Va" });
    const { recoveryCodes } = await enableMfa(admin);
    // "No hay otros admin activos" en las dos consultas siguientes; después, la real.
    // (Sin restoreAllMocks: restaurar un espía sobre el delegado de Prisma lo rompe.)
    vi.spyOn(prisma.user, "count").mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const status = await deletionStatus(admin);
    expect(status.body).toEqual({ canDelete: false, reason: expect.stringContaining("único administrador") });
    const res = await deleteAccount(admin, { password: TEST_PASSWORD, code: recoveryCodes[0] });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("único administrador");
    expect((await deletionStatus(admin)).body.canDelete).toBe(true); // hay otros admin (el de pruebas)
  });

  it("contraseña incorrecta: 400 y la cuenta sigue intacta", async () => {
    const account = await createAccount("Clave Mala");
    expect((await deleteAccount(account, { password: "otra" })).status).toBe(400);
    expect((await me(account)).body.name).toBe("Clave Mala");
  });

  it("con MFA: falta el código o es incorrecto → 400; con un código de recuperación, se elimina", async () => {
    const account = await createAccount("Con MFA");
    const { recoveryCodes } = await enableMfa(account);
    const missing = await deleteAccount(account);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("código");
    expect((await deleteAccount(account, { password: TEST_PASSWORD, code: "123456" })).status).toBe(400);
    expect((await me(account)).status).toBe(200);
    expect((await deleteAccount(account, { password: TEST_PASSWORD, code: recoveryCodes[0] })).status).toBe(204);
    expect(await prisma.userMfa.count({ where: { userId: account.user.id } })).toBe(0);
  });

  it("elimina: lápida anónima, documentos con su autor, sin sesiones, vínculos, IA, correos ni foto", async () => {
    const accountant = await createAccount("Contador del Asistente");
    const client = await createClient(accountant.token);
    const { email } = await invite({
      role: "assistant",
      name: "Asistente Que Se Va",
      accountantUserId: accountant.user.id,
    });
    const assistant = await acceptInvitation(email);
    const doc = await createDocument(client.id, assistant.user.id);
    await prisma.aiConversation.create({ data: { clientId: client.id, userId: assistant.user.id } });
    await request(app)
      .post("/api/users/me/avatar")
      .set(authHeader(assistant.token))
      .attach("avatar", REAL_PNG, { filename: "foto.png", contentType: "image/png" });
    const avatarKey = (await prisma.user.findUniqueOrThrow({ where: { id: assistant.user.id } })).avatarKey!;
    await request(app)
      .post("/api/users/me/email")
      .set(authHeader(assistant.token))
      .send({ newEmail: `nuevo-${Date.now()}@test.local`, password: TEST_PASSWORD });
    const other = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    expect(await prisma.emailOutbox.count({ where: { toAddress: email } })).toBeGreaterThan(0);

    const res = await deleteAccount(assistant);
    expect(res.status).toBe(204);
    const cleared = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith(REFRESH_COOKIE));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);

    const tomb = await prisma.user.findUniqueOrThrow({ where: { id: assistant.user.id } });
    expect(tomb).toMatchObject({
      status: "deleted",
      name: "Cuenta eliminada",
      email: `eliminada-${assistant.user.id}@renta-ia.invalid`,
      phone: null,
      passwordHash: null,
      avatarKey: null,
    });
    expect(tomb.deletedAt).toBeInstanceOf(Date);
    // El documento sigue en el expediente del cliente, con su autor (la lápida).
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).uploadedBy).toBe(assistant.user.id);
    const id = assistant.user.id;
    expect(await prisma.userSession.count({ where: { userId: id } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId: id } })).toBe(0);
    expect(await prisma.emailChangeToken.count({ where: { userId: id } })).toBe(0);
    expect(await prisma.accountantAssistant.count({ where: { assistantUserId: id } })).toBe(0);
    expect(await prisma.aiConversation.count({ where: { userId: id } })).toBe(0);
    expect(await prisma.emailOutbox.count({ where: { toAddress: { equals: email, mode: "insensitive" } } })).toBe(0);
    expect(onDisk(avatarKey)).toBe(false);
    // Ninguna sesión sirve, ni la de otro dispositivo; tampoco entrar con el correo anterior.
    expect((await me(assistant)).status).toBe(401);
    expect((await request(app).get("/api/users/me").set(authHeader(other.body.accessToken))).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).status).toBe(401);
    // El correo queda libre: se puede volver a invitar.
    expect((await invite({ role: "accountant", email })).email).toBe(email);

    await flushAudit();
    const entry = await prisma.auditLog.findFirst({ where: { action: "user.account.delete", userId: id } });
    expect(entry?.entityId).toBe(id);
  });

  it("el usuario del portal: el cliente queda sin usuario de portal", async () => {
    const accountant = await createAccount("Contador Portal Borra");
    const client = await createClient(accountant.token);
    const portal = await createAccountWithRole("client", { clientId: client.id });
    expect((await deleteAccount(portal)).status).toBe(204);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).portalUserId).toBeNull();
  });

  it("un contador eliminado no sirve para invitar asistentes", async () => {
    const accountant = await createAccount("Contador Que Se Va");
    expect((await deleteAccount(accountant)).status).toBe(204);
    const admin = await testAdmin();
    const res = await request(app)
      .post("/api/admin/invitations")
      .set(authHeader(admin.token))
      .send({
        name: "Asistente",
        email: `asis-${Date.now()}@test.local`,
        role: "assistant",
        accountantUserId: accountant.user.id,
      });
    expect(res.status).toBe(400);
  });
});

describe("024: garantías de la base", () => {
  const sql = (query: string, ...params: unknown[]) => prisma.$executeRawUnsafe(query, ...params);
  /** Pasa la cuenta a eliminada; `overrides` reemplaza el valor SQL de alguna columna de la lápida. */
  const tombstone = (id: string, overrides: Record<string, string> = {}) => {
    const values: Record<string, string> = {
      status: "'deleted'",
      deleted_at: "now()",
      name: "'Cuenta eliminada'",
      email: "'eliminada-' || id || '@renta-ia.invalid'",
      phone: "NULL",
      avatar_key: "NULL",
      avatar_updated_at: "NULL",
      password_hash: "NULL",
      ...overrides,
    };
    const set = Object.entries(values)
      .map(([column, value]) => `${column} = ${value}`)
      .join(", ");
    return sql(`UPDATE users SET ${set} WHERE id = $1::uuid`, id);
  };
  const clearSessions = (id: string) => sql(`DELETE FROM user_sessions WHERE user_id = $1::uuid`, id);

  it("una cuenta con sesiones no puede pasar a eliminada", async () => {
    const a = await createAccount("Con Sesión SQL");
    await expect(tombstone(a.user.id)).rejects.toThrow(/fk_refresh_tokens_active_user|fk_user_sessions_active_user/);
  });

  it("la lápida no puede conservar nombre, correo ni teléfono; ni tener contraseña", async () => {
    const a = await createAccount("Lápida SQL");
    await clearSessions(a.user.id);
    for (const [column, value] of [
      ["name", "'Ana'"],
      ["email", "'ana@test.local'"],
      ["phone", "'+57 300 000 0000'"],
    ]) {
      await expect(tombstone(a.user.id, { [column!]: value! }), column).rejects.toThrow(/chk_users_deleted_scrubbed/);
    }
    await expect(tombstone(a.user.id, { password_hash: "'x'" })).rejects.toThrow(/chk_users_password_by_status/);
    await expect(tombstone(a.user.id, { deleted_at: "NULL" })).rejects.toThrow(/chk_users_deleted_at/);
    await expect(tombstone(a.user.id)).resolves.toBe(1);
  });

  it("deleted_at solo en cuentas eliminadas", async () => {
    const a = await createAccount("Fecha Suelta");
    await expect(sql(`UPDATE users SET deleted_at = now() WHERE id = $1::uuid`, a.user.id)).rejects.toThrow(
      /chk_users_deleted_at/
    );
  });

  it("un contador con clientes no puede pasar a eliminado, ni un cliente apuntar a un contador eliminado", async () => {
    const a = await createAccount("Contador SQL");
    const client = await createClient(a.token);
    await clearSessions(a.user.id);
    await expect(tombstone(a.user.id)).rejects.toThrow(/fk_clients_active_accountant/);
    await sql(`DELETE FROM clients WHERE id = $1::uuid`, client.id);
    await expect(tombstone(a.user.id)).resolves.toBe(1);
    await expect(
      sql(
        `INSERT INTO clients (accountant_user_id, full_name, document_number) VALUES ($1::uuid, 'X', 'CC-sql-024')`,
        a.user.id
      )
    ).rejects.toThrow(/fk_clients_active_accountant/);
  });

  it("un documento no deja borrar la fila de quien lo subió (RESTRICT): por eso la lápida", async () => {
    const a = await createAccount("Autor SQL");
    const client = await createClient(a.token);
    await createDocument(client.id, a.user.id);
    await expect(sql(`DELETE FROM users WHERE id = $1::uuid`, a.user.id)).rejects.toThrow(/foreign key/i);
  });
});
