import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { Account, app, authHeader, createAccount, invite, TEST_PASSWORD, unique } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { flushAudit } from "../../src/services/audit/audit.service";
import { createSignedToken, hashToken } from "../../src/utils/signedToken";

/**
 * "Mi perfil" (B11, migración 020): nombre y teléfono; cambio de correo con
 * confirmación en el correo nuevo y aviso al anterior; cambio de contraseña
 * que cierra las demás sesiones. Cada regla, rota a propósito.
 */

const CSRF = { "X-Requested-With": "renta-ia", Origin: "http://localhost:5173" };
const NEW_PASSWORD = "otra frase larga y distinta";
const me = (a: Account) => request(app).get("/api/users/me").set(authHeader(a.token));
const patch = (a: Account, body: object) => request(app).patch("/api/users/me").set(authHeader(a.token)).send(body);
const requestEmail = (a: Account, newEmail: string, password = TEST_PASSWORD) =>
  request(app).post("/api/users/me/email").set(authHeader(a.token)).send({ newEmail, password });
const confirmEmail = (token: string) => request(app).post("/api/auth/email-change/confirm").send({ token });
const changePassword = (a: Account, currentPassword: string, newPassword = NEW_PASSWORD) =>
  request(app).post("/api/users/me/password").set(authHeader(a.token)).send({ currentPassword, newPassword });
const lockFailures = async (email: string) =>
  (await prisma.loginAttempt.findUnique({ where: { keyHash: createHash("sha256").update(email).digest("hex") } }))
    ?.failures ?? 0;

async function lastMail(to: string, template: string) {
  return prisma.emailOutbox.findFirst({ where: { toAddress: to, template }, orderBy: { createdAt: "desc" } });
}
const tokenIn = (text: string | null | undefined) => text?.match(/#\/confirmar-correo\/([\w.-]+)/)?.[1] ?? null;

describe("nombre y teléfono", () => {
  it("GET /me trae teléfono y cambio pendiente; PATCH edita nombre y teléfono, y '' borra el teléfono", async () => {
    const account = await createAccount("Nombre Viejo");
    expect((await me(account)).body).toMatchObject({ phone: null, pendingEmail: null, mfaEnabled: false });

    const res = await patch(account, { name: "  Nombre Nuevo  ", phone: "+57 300 123 4567" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Nombre Nuevo", phone: "+57 300 123 4567" });
    expect((await patch(account, { phone: "" })).body.phone).toBeNull();
  });

  it("rechaza datos inválidos y no deja tocar campos que no son editables (rol, correo)", async () => {
    const account = await createAccount("Validación");
    for (const body of [{}, { name: "A" }, { phone: "abc" }, { phone: "12" }, { phone: "+57 300 123 4567 ext 9" }]) {
      expect((await patch(account, body)).status, JSON.stringify(body)).toBe(400);
    }
    const sneaky = await patch(account, { name: "Validación", role: "admin", email: "otro@test.local" });
    expect(sneaky.status).toBe(200);
    expect(sneaky.body).toMatchObject({ role: "accountant", email: account.email });
  });

  it("la base rechaza un teléfono con otro formato aunque el backend fallara", async () => {
    const { user } = await createAccount("Teléfono SQL");
    await expect(
      prisma.$executeRawUnsafe(`UPDATE users SET phone = 'llámame' WHERE id = $1::uuid`, user.id)
    ).rejects.toThrow(/chk_users_phone_format/);
  });
});

describe("cambiar el correo", () => {
  it("pide la contraseña actual (un fallo cuenta en el bloqueo) y no acepta el mismo correo", async () => {
    const account = await createAccount("Correo");
    expect((await requestEmail(account, `nuevo-${unique()}@test.local`, "no es")).status).toBe(400);
    expect(await lockFailures(account.email)).toBe(1);
    expect((await requestEmail(account, account.email.toUpperCase())).status).toBe(400);
  });

  it("enlace al correo NUEVO (solo su hash en la base), aviso al ANTERIOR; el correo cambia solo al confirmar", async () => {
    const account = await createAccount("Cambia Correo");
    const newEmail = `nuevo-${unique()}@test.local`;
    const res = await requestEmail(account, ` ${newEmail.toUpperCase()} `);
    expect(res.status).toBe(202);
    expect(res.body.pendingEmail.email).toBe(newEmail);

    const token = tokenIn((await lastMail(newEmail, "email_change_verification"))?.bodyText);
    expect(token).not.toBeNull();
    const row = await prisma.emailChangeToken.findFirstOrThrow({ where: { userId: account.user.id } });
    expect(row.tokenHash).toBe(hashToken(token!));
    expect(JSON.stringify(row)).not.toContain(token!.split(".")[0]);
    expect((await lastMail(account.email, "email_change_notice"))?.bodyText).toContain(newEmail);
    // Todavía no cambió.
    expect((await me(account)).body).toMatchObject({ email: account.email, pendingEmail: { email: newEmail } });

    const confirmed = await confirmEmail(token!);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual({ email: newEmail });
    expect((await me(account)).body).toMatchObject({ email: newEmail, pendingEmail: null });
    const notices = await prisma.emailOutbox.count({
      where: { toAddress: account.email, template: "email_change_notice" },
    });
    expect(notices).toBe(2); // pedido y completado

    // Un solo uso; y el login funciona con el nuevo, no con el anterior.
    expect((await confirmEmail(token!)).status).toBe(410);
    const login = (email: string) => request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    expect((await login(newEmail)).status).toBe(200);
    expect((await login(account.email)).status).toBe(401);
  });

  it("si el correo ya es de otra cuenta: misma respuesta, aviso SIN enlace y nada que confirmar", async () => {
    const account = await createAccount("Correo Ocupado");
    const other = await createAccount("Dueña");
    const free = await requestEmail(account, `libre-${unique()}@test.local`);
    const taken = await requestEmail(account, other.email);
    expect(taken.status).toBe(free.status);
    expect(Object.keys(taken.body)).toEqual(Object.keys(free.body));
    const mail = await lastMail(other.email, "email_change_verification");
    expect(mail?.subject).toContain("ya tiene una cuenta");
    expect(tokenIn(mail?.bodyText)).toBeNull();
    expect((await me(account)).body.email).toBe(account.email);
  });

  it("si otra cuenta toma el correo mientras tanto: 409 al confirmar, sin cambiar nada", async () => {
    const account = await createAccount("Carrera Correo");
    const newEmail = `carrera-${unique()}@test.local`;
    await requestEmail(account, newEmail);
    const token = tokenIn((await lastMail(newEmail, "email_change_verification"))?.bodyText)!;
    await prisma.user.create({ data: { name: "Llegó antes", email: newEmail, passwordHash: "x".repeat(60) } });
    expect((await confirmEmail(token)).status).toBe(409);
    expect((await me(account)).body.email).toBe(account.email);
  });

  it("pedir otro reemplaza al anterior; cancelar lo anula; vencido, ajeno o de otro propósito: 410", async () => {
    const account = await createAccount("Reemplaza");
    const first = `primero-${unique()}@test.local`;
    const second = `segundo-${unique()}@test.local`;
    await requestEmail(account, first);
    const firstToken = tokenIn((await lastMail(first, "email_change_verification"))?.bodyText)!;
    await requestEmail(account, second);
    const secondToken = tokenIn((await lastMail(second, "email_change_verification"))?.bodyText)!;
    expect((await confirmEmail(firstToken)).status).toBe(410);

    const cancel = () => request(app).delete("/api/users/me/email").set(authHeader(account.token));
    expect((await cancel()).status).toBe(204);
    expect((await cancel()).status).toBe(404);
    expect((await confirmEmail(secondToken)).status).toBe(410);

    const third = `tercero-${unique()}@test.local`;
    await requestEmail(account, third);
    const thirdToken = tokenIn((await lastMail(third, "email_change_verification"))?.bodyText)!;
    await prisma.$executeRawUnsafe(
      `UPDATE email_change_tokens SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE token_hash = $1`,
      hashToken(thirdToken)
    );
    expect((await confirmEmail(thirdToken)).status).toBe(410);
    expect((await confirmEmail(createSignedToken("password_reset").token)).status).toBe(410);
    expect((await confirmEmail("basura")).status).toBe(410);
  });
});

describe("el enlace de confirmación", () => {
  it("dos confirmaciones simultáneas con el mismo enlace: solo una gana", async () => {
    const account = await createAccount("Carrera Enlace");
    const newEmail = `simultaneo-${unique()}@test.local`;
    await requestEmail(account, newEmail);
    const token = tokenIn((await lastMail(newEmail, "email_change_verification"))?.bodyText)!;
    const results = await Promise.all([confirmEmail(token), confirmEmail(token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
  });

  it("la firma ata el token a su propósito: uno de recuperación no sirve aunque su hash estuviera en la tabla", async () => {
    const { user } = await createAccount("Firma Correo");
    const foreign = createSignedToken("password_reset").token;
    await prisma.emailChangeToken.create({
      data: {
        userId: user.id,
        newEmail: `ajeno-${unique()}@test.local`,
        tokenHash: hashToken(foreign),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect((await confirmEmail(foreign)).status).toBe(410);
  });
});

describe("cambiar la contraseña", () => {
  it("exige la actual (cuenta en el bloqueo), la política y que sea distinta", async () => {
    const account = await createAccount("Clave Nueva");
    expect((await changePassword(account, "no es la actual")).status).toBe(400);
    expect(await lockFailures(account.email)).toBe(1);
    const weak = await changePassword(account, TEST_PASSWORD, "clave-nueva-123");
    expect(weak.status).toBe(400);
    expect(weak.body.details[0].field).toBe("body.newPassword");
    const same = await changePassword(account, TEST_PASSWORD, TEST_PASSWORD);
    expect(same.status).toBe(400);
    expect(same.body.details[0].message).toContain("distinta");
  });

  it("cierra TODAS las demás sesiones (también sus access tokens), no la actual; avisa por correo", async () => {
    const account = await createAccount("Cierra Sesiones");
    const other = await request(app).post("/api/auth/login").send({ email: account.email, password: TEST_PASSWORD });
    const otherCookie = String(other.headers["set-cookie"]).split(";")[0]!;
    // Un enlace de recuperación pendiente deja de servir.
    await request(app).post("/api/auth/password-reset/request").send({ email: account.email });

    const res = await changePassword(account, TEST_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.closedSessions).toBe(1);
    expect((await me(account)).status).toBe(200);
    expect((await request(app).get("/api/users/me").set(authHeader(other.body.accessToken))).status).toBe(401);
    expect((await request(app).post("/api/auth/refresh").set(CSRF).set("Cookie", otherCookie)).status).toBe(401);
    const reasons = await prisma.refreshToken.findMany({
      where: { userId: account.user.id, revokedAt: { not: null } },
      select: { revokeReason: true },
    });
    expect(reasons.map((r) => r.revokeReason)).toContain("password_change");
    expect(await lastMail(account.email, "password_change_notice")).not.toBeNull();
    expect(
      await prisma.passwordResetToken.count({ where: { userId: account.user.id, usedAt: null, revokedAt: null } })
    ).toBe(0);
    const login = await request(app).post("/api/auth/login").send({ email: account.email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
  });
});

describe("auditoría", () => {
  it("registra cada cambio sin correos, teléfonos, contraseñas ni tokens", async () => {
    const account = await createAccount("Audita Perfil");
    const started = new Date();
    const newEmail = `audita-${unique()}@test.local`;
    await patch(account, { phone: "3001234567" });
    await requestEmail(account, newEmail);
    const token = tokenIn((await lastMail(newEmail, "email_change_verification"))?.bodyText)!;
    await confirmEmail(token);
    await confirmEmail(token); // ya usado
    await changePassword(account, TEST_PASSWORD);
    await flushAudit();
    const rows = await prisma.auditLog.findMany({ where: { createdAt: { gte: started } } });
    expect(rows.filter((r) => r.userId === account.user.id).map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "user.profile.update",
        "user.email_change.requested",
        "user.email_change.completed",
        "user.password.change",
      ])
    );
    expect(rows.map((r) => r.action)).toContain("user.email_change.invalid");
    const dump = JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const secret of [newEmail, account.email, "3001234567", NEW_PASSWORD, token, ...token.split(".")]) {
      expect(dump).not.toContain(secret);
    }
  });
});

describe("020: garantías del esquema", () => {
  const insert = (userId: string, newEmail: string, hours = 24) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO email_change_tokens (user_id, new_email, token_hash, expires_at) VALUES ($1::uuid, $2, $3, now() + make_interval(hours => $4::int))`,
      userId,
      newEmail,
      hashToken(unique()),
      hours
    );

  it("una cuenta pendiente no puede tener cambios de correo (FK compuesta)", async () => {
    const { userId } = await invite({ role: "accountant" });
    await expect(insert(userId, `x-${unique()}@test.local`)).rejects.toThrow(/fk_email_change_tokens_active_user/);
  });

  it("24 horas como máximo, uno pendiente por cuenta y el correo siempre normalizado", async () => {
    const { user } = await createAccount("Esquema 020");
    await expect(insert(user.id, `x-${unique()}@test.local`, 25)).rejects.toThrow(/chk_email_change_tokens_expiry/);
    await expect(insert(user.id, `Mayus-${unique()}@Test.local`)).rejects.toThrow(/chk_email_change_tokens_new_email/);
    await expect(insert(user.id, `x-${unique()}@test.local`)).resolves.toBe(1);
    await expect(insert(user.id, `y-${unique()}@test.local`)).rejects.toThrow(/23505[\s\S]*Key \(user_id\)/);
  });
});
