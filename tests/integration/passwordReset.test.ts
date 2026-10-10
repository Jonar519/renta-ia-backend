import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, createAccount, invite, resetTokenFor, TEST_PASSWORD, unique } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { flushAudit } from "../../src/services/audit/audit.service";
import { flushPasswordResets } from "../../src/modules/auth/passwordReset.service";
import { lockoutService } from "../../src/modules/auth/lockout.service";
import { createSignedToken, hashToken } from "../../src/utils/signedToken";

/**
 * Recuperación de contraseña (B7): respuesta idéntica exista o no el correo,
 * token de 15 min y un solo uso (solo su hash en la base), y al usarlo se
 * cierran TODAS las sesiones, incluidos los access tokens ya emitidos.
 */

const CSRF = { "X-Requested-With": "renta-ia", Origin: "http://localhost:5173" };
const requestReset = (email: string) => request(app).post("/api/auth/password-reset/request").send({ email });
const lookup = (token: string) => request(app).post("/api/auth/password-reset/lookup").send({ token });
const confirm = (token: string, password = "nueva frase muy segura") =>
  request(app).post("/api/auth/password-reset/confirm").send({ token, password });
const NEW_PASSWORD = "nueva frase muy segura";

async function requestAndRead(email: string) {
  const res = await requestReset(email);
  await flushPasswordResets();
  return { res, token: await resetTokenFor(email) };
}

describe("pedir la recuperación no revela si el correo existe", () => {
  it("misma respuesta (estado, cuerpo y cabeceras relevantes) para cuenta activa, pendiente o inexistente", async () => {
    const active = await createAccount("Recupera");
    const pending = await invite({ role: "accountant" });
    const missing = `nadie-${unique()}@test.local`;

    const responses = [];
    for (const email of [active.email, pending.email, missing]) responses.push(await requestReset(email));
    const shape = (r: request.Response) => ({
      status: r.status,
      body: r.body,
      type: r.headers["content-type"],
      cookie: r.headers["set-cookie"],
    });
    expect(shape(responses[0]!)).toEqual(shape(responses[1]!));
    expect(shape(responses[1]!)).toEqual(shape(responses[2]!));
    expect(responses[0]!.status).toBe(202);

    await flushPasswordResets();
    expect(await resetTokenFor(active.email)).not.toBeNull();
    expect(await resetTokenFor(pending.email)).toBeNull(); // una cuenta pendiente no tiene contraseña que recuperar
    expect(await resetTokenFor(missing)).toBeNull();
  });

  it("responde ANTES de buscar la cuenta o enviar el correo: el tiempo no depende de si existe", async () => {
    const { email } = await createAccount("Tiempo");
    const res = await requestReset(email);
    expect(res.status).toBe(202);
    // En el momento de responder todavía no hay correo: el trabajo es posterior.
    expect(await prisma.emailOutbox.count({ where: { toAddress: email, template: "password_reset" } })).toBe(0);
    await flushPasswordResets();
    expect(await prisma.emailOutbox.count({ where: { toAddress: email, template: "password_reset" } })).toBe(1);
  });
});

describe("el token", () => {
  it("viaja solo por correo (en el fragmento #); la base guarda su hash y vence a los 15 minutos", async () => {
    const { email, user } = await createAccount("Hash");
    const { token } = await requestAndRead(email);
    const mail = await prisma.emailOutbox.findFirstOrThrow({ where: { toAddress: email, template: "password_reset" } });
    expect(mail.bodyText).toContain(`/#/restablecer/${token}`);
    const row = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.tokenHash).toBe(hashToken(token!));
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(15 * 60 * 1000);
    expect((await lookup(token!)).status).toBe(200);
  });

  it("un token de otro propósito, alterado o inventado: 410 con el mismo mensaje", async () => {
    const { email } = await createAccount("Proposito");
    const { token } = await requestAndRead(email);
    const [body, signature] = token!.split(".");
    const tampered = `${body}.${signature!.slice(0, -2)}${signature!.endsWith("AA") ? "BB" : "AA"}`;
    const results = await Promise.all(
      [tampered, createSignedToken("invitation").token, createSignedToken("password_reset").token, "basura"].map((t) =>
        lookup(t)
      )
    );
    for (const res of results) expect(res.status).toBe(410);
    expect(new Set(results.map((r) => r.text)).size).toBe(1);
  });

  it("la firma ata el token a su propósito: uno de invitación no sirve aunque su hash estuviera en la tabla", async () => {
    const { user } = await createAccount("Firma");
    const foreign = createSignedToken("invitation").token;
    await prisma.$executeRawUnsafe(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1::uuid, $2, now() + interval '10 minutes')`,
      user.id,
      hashToken(foreign)
    );
    expect((await lookup(foreign)).status).toBe(410);
    expect((await confirm(foreign)).status).toBe(410);
  });

  it("pedir otro revoca el anterior (pasado el minuto de espera); dentro del minuto no se manda otro correo", async () => {
    const { email, user } = await createAccount("Reenvio");
    const first = (await requestAndRead(email)).token!;
    // Dentro del minuto: sin correo nuevo, el primero sigue sirviendo.
    await requestAndRead(email);
    expect(await prisma.emailOutbox.count({ where: { toAddress: email, template: "password_reset" } })).toBe(1);
    expect((await lookup(first)).status).toBe(200);

    // Pasado el minuto (se envejece el token en la base): uno nuevo y el anterior deja de servir.
    await prisma.$executeRawUnsafe(
      `UPDATE password_reset_tokens SET created_at = created_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes' WHERE user_id = $1::uuid`,
      user.id
    );
    const second = (await requestAndRead(email)).token!;
    expect(second).not.toBe(first);
    expect((await lookup(first)).status).toBe(410);
    expect((await lookup(second)).status).toBe(200);
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id, usedAt: null, revokedAt: null } })).toBe(
      1
    );
  });

  it("vencido (15 min): 410", async () => {
    const { email, user } = await createAccount("Vencido");
    const { token } = await requestAndRead(email);
    await prisma.$executeRawUnsafe(
      `UPDATE password_reset_tokens SET created_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' WHERE user_id = $1::uuid`,
      user.id
    );
    expect((await lookup(token!)).status).toBe(410);
    expect((await confirm(token!)).status).toBe(410);
  });
});

describe("usar el enlace", () => {
  it("cambia la contraseña, sirve una sola vez y aplica la política (nombre y correo de la cuenta)", async () => {
    const { email } = await createAccount("Mariana Restrepo");
    const { token } = await requestAndRead(email);
    const weak = await confirm(token!, "mariana-restrepo-2026");
    expect(weak.status).toBe(400);
    expect(weak.body.details[0].field).toBe("body.password");

    expect((await confirm(token!, NEW_PASSWORD)).status).toBe(204);
    expect((await confirm(token!, "otra frase distinta larga")).status).toBe(410);
    const oldLogin = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app).post("/api/auth/login").send({ email, password: NEW_PASSWORD });
    expect(newLogin.status).toBe(200);
  });

  it("dos confirmaciones simultáneas con el mismo enlace: solo una gana", async () => {
    const { email } = await createAccount("Carrera");
    const { token } = await requestAndRead(email);
    const results = await Promise.all([confirm(token!), confirm(token!, "segunda frase muy distinta")]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 410]);
  });

  it("cierra TODAS las sesiones: los refresh tokens y también los access tokens ya emitidos", async () => {
    const { email } = await createAccount("Sesiones");
    // Dos sesiones (dos dispositivos).
    const a = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    const b = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    const cookieA = String(a.headers["set-cookie"]).split(";")[0]!;
    expect((await request(app).get("/api/users/me").set(authHeader(b.body.accessToken))).status).toBe(200);

    const { token } = await requestAndRead(email);
    expect((await confirm(token!)).status).toBe(204);

    // El access token de la otra sesión deja de servir AL INSTANTE (no a los 15 minutos).
    const me = await request(app).get("/api/users/me").set(authHeader(b.body.accessToken));
    expect(me.status).toBe(401);
    // Y el refresh token tampoco renueva.
    const refreshed = await request(app).post("/api/auth/refresh").set(CSRF).set("Cookie", cookieA);
    expect(refreshed.status).toBe(401);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const reasons = await prisma.refreshToken.findMany({ where: { userId: user.id }, select: { revokeReason: true } });
    expect(reasons.every((r) => r.revokeReason === "password_reset")).toBe(true);
  });

  it("quita el bloqueo por intentos fallidos de la cuenta", async () => {
    const { email } = await createAccount("Bloqueada");
    for (let i = 0; i < 6; i++) await lockoutService.registerFailure(email);
    expect(await lockoutService.remainingLockMs(email)).toBeGreaterThan(0);
    const { token } = await requestAndRead(email);
    expect((await confirm(token!)).status).toBe(204);
    expect(await lockoutService.remainingLockMs(email)).toBe(0);
  });
});

describe("auditoría", () => {
  it("registra la solicitud y el cambio, sin el correo, el token ni sus partes", async () => {
    const { email, user } = await createAccount("Auditada");
    const started = new Date();
    const { token } = await requestAndRead(email);
    await confirm(token!);
    await lookup(token!); // ya usado: queda como inválido
    await flushAudit();
    const rows = await prisma.auditLog.findMany({ where: { createdAt: { gte: started } } });
    const actions = rows.filter((r) => r.userId === user.id).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.password_reset.requested", "auth.password_reset.completed"]));
    expect(rows.map((r) => r.action)).toContain("auth.password_reset.invalid");
    const dump = JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const secret of [email, token!, ...token!.split("."), hashToken(token!)]) {
      expect(dump).not.toContain(secret);
    }
  });
});

describe("018: garantías del esquema", () => {
  const insert = (userId: string, minutes = 15) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1::uuid, $2, now() + make_interval(mins => $3::int))`,
      userId,
      hashToken(unique()),
      minutes
    );

  it("una cuenta pendiente no puede tener tokens de recuperación (FK compuesta)", async () => {
    const { userId } = await invite({ role: "accountant" });
    await expect(insert(userId)).rejects.toThrow(/fk_password_reset_tokens_active_user/);
  });

  it("vigencia máxima de 15 minutos y un solo token vigente por cuenta", async () => {
    const { user } = await createAccount("Esquema");
    await expect(insert(user.id, 16)).rejects.toThrow(/chk_password_reset_tokens_expiry/);
    await expect(insert(user.id, 15)).resolves.toBe(1);
    await expect(insert(user.id, 15)).rejects.toThrow(/23505[\s\S]*Key \(user_id\)/);
  });

  it("una cuenta con un token de recuperación no puede volver a pendiente", async () => {
    const { user } = await createAccount("Sin sesiones");
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    await insert(user.id);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE users SET status = 'invited', password_hash = NULL WHERE id = $1::uuid`, user.id)
    ).rejects.toThrow(/fk_password_reset_tokens_active_user/);
  });
});
