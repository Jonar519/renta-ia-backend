import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ipKeyGenerator } from "express-rate-limit";
import request from "supertest";
import { createHash } from "crypto";
import {
  Account,
  app,
  authHeader,
  createAccount,
  createAccountWithRole,
  invite,
  resetTokenFor,
  TEST_PASSWORD,
  testAdmin,
  unique,
} from "../helpers";
import { prisma } from "../../src/config/prisma";
import { env } from "../../src/config/env";
import { flushAudit } from "../../src/services/audit/audit.service";
import { flushPasswordResets } from "../../src/modules/auth/passwordReset.service";
import { base32Decode, totp } from "../../src/modules/mfa/totp";
import { seal } from "../../src/utils/secretBox";
import { mfaLoginLimiter, mfaManageLimiter } from "../../src/middlewares/rateLimit.middleware";
import { mfaService } from "../../src/modules/mfa/mfa.service";
import { mfaRegenerateSchema } from "../../src/modules/mfa/mfa.schema";
import { createSignedToken, hashToken } from "../../src/utils/signedToken";

/**
 * Verificación en dos pasos (B8, migración 019). Cada regla tiene una prueba
 * que la rompe a propósito: código ajeno o repetido, paso vencido o agotado,
 * sesión robada que intenta cambiar el MFA, clave ausente, secreto copiado de
 * otra cuenta y SQL directo contra las restricciones del esquema.
 */

const ME = "/api/users/me/mfa";

// Todas las pruebas salen de la misma IP: cada una empieza con el limitador
// por IP en cero (el límite se prueba aparte, en mfaRateLimit.test.ts).
beforeEach(async () => {
  for (const ip of ["::ffff:127.0.0.1", "127.0.0.1", "::1"]) {
    await mfaLoginLimiter.resetKey(ipKeyGenerator(ip));
    await mfaManageLimiter.resetKey(ipKeyGenerator(ip));
  }
});
const CSRF = { "X-Requested-With": "renta-ia", Origin: "http://localhost:5173" };
const RECOVERY_FORMAT = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

/** Código de la app para ese secreto (base32), desplazado offset pasos de 30 s. */
const codeFor = (secret: string, offset = 0) => totp(base32Decode(secret), Date.now() + offset * 30_000);
const lockFailures = async (email: string) =>
  (
    await prisma.loginAttempt.findUnique({
      where: { keyHash: createHash("sha256").update(email).digest("hex") },
    })
  )?.failures ?? 0;
/** Olvida el último paso usado: para pruebas que no tratan del anti-replay. */
const forgetLastStep = (userId: string) => prisma.userMfa.update({ where: { userId }, data: { lastUsedStep: null } });

const setup = (account: Account, password = TEST_PASSWORD) =>
  request(app).post(`${ME}/setup`).set(authHeader(account.token)).send({ password });
const enable = (account: Account, code: string) =>
  request(app).post(`${ME}/enable`).set(authHeader(account.token)).send({ code });

async function enableMfa(account: Account) {
  const { secret } = (await setup(account)).body as { secret: string };
  const res = await enable(account, codeFor(secret));
  expect(res.status).toBe(200);
  return { secret, recoveryCodes: res.body.recoveryCodes as string[] };
}

const login = (email: string, password = TEST_PASSWORD) =>
  request(app).post("/api/auth/login").send({ email, password });
const loginMfa = (challengeToken: string, code: string) =>
  request(app).post("/api/auth/login/mfa").send({ challengeToken, code });

async function challengeFor(email: string): Promise<string> {
  const res = await login(email);
  expect(res.body.mfaRequired).toBe(true);
  return res.body.challengeToken;
}

describe("configurar", () => {
  it("empieza desactivado; configurar exige la contraseña actual (y un fallo cuenta en el bloqueo)", async () => {
    const account = await createAccount("Configura");
    const status = await request(app).get(ME).set(authHeader(account.token));
    expect(status.body).toEqual({ enabled: false, enabledAt: null, recoveryCodesRemaining: 0, required: false });

    const wrong = await setup(account, "no es mi contraseña");
    expect(wrong.status).toBe(400);
    expect(await lockFailures(account.email)).toBe(1);

    const res = await setup(account);
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.body.otpauthUri).toContain(`secret=${res.body.secret}`);
    expect(res.body.otpauthUri).toContain(encodeURIComponent(account.email));
    expect(new Date(res.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);

    // En la base: cifrado y sin activar. Ni el secreto en base32 ni sus bytes aparecen.
    const row = await prisma.userMfa.findUniqueOrThrow({ where: { userId: account.user.id } });
    expect(row.enabledAt).toBeNull();
    expect(row.secretCiphertext).not.toContain(res.body.secret);
    expect(row.secretCiphertext).not.toContain(base32Decode(res.body.secret).toString("base64url"));
    // Una configuración a medias no cambia el login.
    expect((await login(account.email)).body.accessToken).toBeDefined();
  });

  it("activar: código incorrecto → 400; correcto → 10 códigos de recuperación (en la base solo su hash)", async () => {
    const account = await createAccount("Activa");
    const { secret } = (await setup(account)).body;
    const wrongCode = String((Number(codeFor(secret)) + 1) % 1_000_000).padStart(6, "0");
    expect((await enable(account, wrongCode)).status).toBe(400);

    const res = await enable(account, codeFor(secret));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const codes: string[] = res.body.recoveryCodes;
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(RECOVERY_FORMAT);

    const stored = await prisma.mfaRecoveryCode.findMany({ where: { userId: account.user.id } });
    const dump = JSON.stringify(stored);
    for (const c of codes) {
      expect(dump).not.toContain(c);
      expect(dump).not.toContain(c.replace(/-/g, ""));
    }
    const status = await request(app).get(ME).set(authHeader(account.token));
    expect(status.body).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
  });

  it("activar cierra las DEMÁS sesiones (abiertas con un solo factor), no la actual", async () => {
    const account = await createAccount("Otras sesiones");
    const other = await login(account.email);
    const otherCookie = String(other.headers["set-cookie"]).split(";")[0]!;
    await enableMfa(account);

    expect((await request(app).get("/api/users/me").set(authHeader(account.token))).status).toBe(200);
    expect((await request(app).get("/api/users/me").set(authHeader(other.body.accessToken))).status).toBe(401);
    expect((await request(app).post("/api/auth/refresh").set(CSRF).set("Cookie", otherCookie)).status).toBe(401);
    const reasons = await prisma.refreshToken.findMany({
      where: { userId: account.user.id, revokedAt: { not: null } },
      select: { revokeReason: true },
    });
    expect(reasons.map((r) => r.revokeReason)).toContain("mfa_enabled");
  });

  it("la configuración vence a los 10 minutos; con MFA activo no se puede configurar otra vez", async () => {
    const account = await createAccount("Vence");
    const { secret } = (await setup(account)).body;
    await prisma.$executeRawUnsafe(
      `UPDATE user_mfa SET created_at = now() - interval '11 minutes' WHERE user_id = $1::uuid`,
      account.user.id
    );
    expect((await enable(account, codeFor(secret))).status).toBe(410);
    expect(await prisma.userMfa.count({ where: { userId: account.user.id } })).toBe(0);

    await enableMfa(account);
    expect((await setup(account)).status).toBe(409);
    expect((await enable(account, "123456")).status).toBe(409);
  });
});

describe("login con MFA activo", () => {
  it("la contraseña sola no da sesión: paso de verificación sin token de acceso ni cookie", async () => {
    const account = await createAccount("Dos pasos");
    const { secret } = await enableMfa(account);
    const step1 = await login(account.email);
    expect(step1.status).toBe(200);
    expect(step1.body.mfaRequired).toBe(true);
    expect(step1.body.accessToken).toBeUndefined();
    expect(step1.headers["set-cookie"]).toBeUndefined();
    expect(new Date(step1.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);

    const step2 = await loginMfa(step1.body.challengeToken, codeFor(secret, 1));
    expect(step2.status).toBe(200);
    expect(step2.body.accessToken).toBeDefined();
    expect(String(step2.headers["set-cookie"])).toContain("renta_ia_refresh=");
    expect((await request(app).get("/api/users/me").set(authHeader(step2.body.accessToken))).status).toBe(200);
  });

  it("anti-replay: el código con que se activó no sirve para entrar; el siguiente sí", async () => {
    const account = await createAccount("Replay");
    const { secret } = await enableMfa(account);
    const usedAtEnable = codeFor(secret);
    const res = await loginMfa(await challengeFor(account.email), usedAtEnable);
    expect(res.status).toBe(401);
    expect((await loginMfa(await challengeFor(account.email), codeFor(secret, 1))).status).toBe(200);
    // Y ese tampoco sirve dos veces.
    expect((await loginMfa(await challengeFor(account.email), codeFor(secret, 1))).status).toBe(401);
  });

  it("código incorrecto: 401, cuenta en el bloqueo; a los 5 fallos el paso muere aunque luego llegue el bueno", async () => {
    const account = await createAccount("Intentos");
    const { secret } = await enableMfa(account);
    await forgetLastStep(account.user.id);
    const challenge = await challengeFor(account.email);
    for (let i = 0; i < 5; i++) {
      const res = await loginMfa(challenge, "000000" === codeFor(secret) ? "111111" : "000000");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("El código no es correcto.");
    }
    expect(await lockFailures(account.email)).toBe(5);
    // El paso agotado ya no sirve, aunque llegue el código bueno.
    const late = await loginMfa(challenge, codeFor(secret));
    expect(late.status).toBe(401);
    expect(late.body.error).toMatch(/venció o ya no es válida/);
    // Y la cuenta quedó bloqueada (bloqueo progresivo): ni la contraseña abre un paso nuevo.
    expect((await login(account.email)).status).toBe(429);
  });

  it("código de recuperación: sirve UNA vez, y lo registra la auditoría", async () => {
    const account = await createAccount("Recupera");
    const { recoveryCodes } = await enableMfa(account);
    const started = new Date();
    // Se acepta en minúsculas y sin guiones.
    const typed = recoveryCodes[0]!.toLowerCase().replace(/-/g, " ");
    expect((await loginMfa(await challengeFor(account.email), typed)).status).toBe(200);
    expect((await loginMfa(await challengeFor(account.email), recoveryCodes[0]!)).status).toBe(401);
    const status = await request(app)
      .get(ME)
      .set(authHeader((await loginMfa(await challengeFor(account.email), recoveryCodes[1]!)).body.accessToken));
    expect(status.body.recoveryCodesRemaining).toBe(8);
    await flushAudit();
    const actions = await prisma.auditLog.findMany({
      where: { userId: account.user.id, createdAt: { gte: started } },
      select: { action: true },
    });
    expect(actions.map((a) => a.action)).toContain("auth.mfa.recovery_code_used");
  });

  it("el paso es de un solo uso, vence a los 5 minutos y exige su propia firma", async () => {
    const account = await createAccount("Paso");
    const { secret } = await enableMfa(account);
    await forgetLastStep(account.user.id);
    const used = await challengeFor(account.email);
    expect((await loginMfa(used, codeFor(secret))).status).toBe(200);
    await forgetLastStep(account.user.id);
    expect((await loginMfa(used, codeFor(secret))).status).toBe(401);

    const expired = await challengeFor(account.email);
    await prisma.$executeRawUnsafe(
      `UPDATE mfa_challenges SET created_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute' WHERE token_hash = $1`,
      hashToken(expired)
    );
    await forgetLastStep(account.user.id);
    expect((await loginMfa(expired, codeFor(secret))).status).toBe(401);

    // Firmado para otro propósito (aunque su hash estuviera en la tabla): no sirve.
    const foreign = createSignedToken("password_reset").token;
    await prisma.mfaChallenge.create({
      data: { userId: account.user.id, tokenHash: hashToken(foreign), expiresAt: new Date(Date.now() + 60_000) },
    });
    expect((await loginMfa(foreign, codeFor(secret))).status).toBe(401);
  });

  it("dos verificaciones simultáneas con el mismo paso y código: solo una inicia sesión", async () => {
    const account = await createAccount("Carrera MFA");
    const { secret } = await enableMfa(account);
    await forgetLastStep(account.user.id);
    const challenge = await challengeFor(account.email);
    const code = codeFor(secret);
    const results = await Promise.all([loginMfa(challenge, code), loginMfa(challenge, code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("el mismo código en dos pasos DISTINTOS a la vez (dos dispositivos): solo uno entra", async () => {
    const account = await createAccount("Dos dispositivos");
    const { secret } = await enableMfa(account);
    await forgetLastStep(account.user.id);
    const [a, b] = [await challengeFor(account.email), await challengeFor(account.email)];
    const code = codeFor(secret);
    const results = await Promise.all([loginMfa(a, code), loginMfa(b, code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("restablecer la contraseña NO quita el MFA: el login sigue pidiendo el código", async () => {
    const account = await createAccount("Reset con MFA");
    await enableMfa(account);
    await request(app).post("/api/auth/password-reset/request").send({ email: account.email });
    await flushPasswordResets();
    const token = await resetTokenFor(account.email);
    const newPassword = "otra frase larga y nueva";
    expect(
      (await request(app).post("/api/auth/password-reset/confirm").send({ token, password: newPassword })).status
    ).toBe(204);
    const res = await login(account.email, newPassword);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.accessToken).toBeUndefined();
  });
});

describe("desactivar y regenerar (con una sesión iniciada)", () => {
  it("desactivar exige contraseña Y código; borra en cascada códigos y pasos abiertos", async () => {
    const account = await createAccount("Desactiva");
    const { secret } = await enableMfa(account);
    await challengeFor(account.email); // un paso de login abierto
    const disable = (password: string, code: string) =>
      request(app).post(`${ME}/disable`).set(authHeader(account.token)).send({ password, code });

    await forgetLastStep(account.user.id);
    expect((await disable("contraseña equivocada", codeFor(secret))).status).toBe(400);
    expect((await disable(TEST_PASSWORD, "000000" === codeFor(secret) ? "111111" : "000000")).status).toBe(400);
    expect(await prisma.userMfa.count({ where: { userId: account.user.id } })).toBe(1);

    expect((await disable(TEST_PASSWORD, codeFor(secret))).status).toBe(204);
    expect(await prisma.userMfa.count({ where: { userId: account.user.id } })).toBe(0);
    expect(await prisma.mfaRecoveryCode.count({ where: { userId: account.user.id } })).toBe(0);
    expect(await prisma.mfaChallenge.count({ where: { userId: account.user.id } })).toBe(0);
    expect((await login(account.email)).body.accessToken).toBeDefined();
  });

  it("desactivar también acepta un código de recuperación (perdí el teléfono)", async () => {
    const account = await createAccount("Sin teléfono");
    const { recoveryCodes } = await enableMfa(account);
    const res = await request(app)
      .post(`${ME}/disable`)
      .set(authHeader(account.token))
      .send({ password: TEST_PASSWORD, code: recoveryCodes[3] });
    expect(res.status).toBe(204);
  });

  it("regenerar exige un código de la app (no uno de recuperación) e invalida los anteriores", async () => {
    const account = await createAccount("Regenera");
    const { secret, recoveryCodes } = await enableMfa(account);
    const regenerate = (code: string) =>
      request(app).post(`${ME}/recovery-codes`).set(authHeader(account.token)).send({ code });
    expect((await regenerate(recoveryCodes[0]!)).status).toBe(400);
    // Dos capas, cada una por su cuenta: el esquema de la ruta y el servicio.
    expect(mfaRegenerateSchema.safeParse({ code: recoveryCodes[1] }).success).toBe(false);
    await expect(mfaService.regenerateRecoveryCodes(account.user.id, recoveryCodes[1]!)).rejects.toThrow(
      /no es correcto/
    );
    expect(await prisma.mfaRecoveryCode.count({ where: { userId: account.user.id, usedAt: null } })).toBe(10);
    const res = await regenerate(codeFor(secret, 1));
    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    expect((await loginMfa(await challengeFor(account.email), recoveryCodes[0]!)).status).toBe(401);
    expect((await loginMfa(await challengeFor(account.email), res.body.recoveryCodes[0])).status).toBe(200);
  });
});

describe("admin: restablecer el MFA de otra cuenta", () => {
  it("borra el MFA y cierra todas sus sesiones; no sobre sí mismo ni sin ser admin", async () => {
    const admin = await testAdmin();
    const account = await createAccount("Perdió todo");
    await enableMfa(account);
    const reset = (token: string, userId: string) =>
      request(app).delete(`/api/admin/users/${userId}/mfa`).set(authHeader(token));

    const assistant = await createAccountWithRole("assistant", { accountantUserId: account.user.id });
    expect((await reset(assistant.token, account.user.id)).status).toBe(403);
    expect((await reset(admin.token, admin.user.id)).status).toBe(403);

    expect((await reset(admin.token, account.user.id)).status).toBe(204);
    expect((await request(app).get("/api/users/me").set(authHeader(account.token))).status).toBe(401);
    expect((await login(account.email)).body.accessToken).toBeDefined();
    expect((await reset(admin.token, account.user.id)).status).toBe(404);
  });
});

describe("sin MFA_ENCRYPTION_KEY", () => {
  const key = env.mfaEncryptionKey;
  afterEach(() => {
    env.mfaEncryptionKey = key;
  });

  it("la API sigue funcionando; solo MFA responde 503 explicando qué falta", async () => {
    const account = await createAccount("Sin clave");
    const withMfa = await createAccount("Con MFA sin clave");
    await enableMfa(withMfa);
    env.mfaEncryptionKey = undefined;
    const res = await setup(account);
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("MFA_ENCRYPTION_KEY");
    expect((await login(account.email)).status).toBe(200); // sin MFA, el login no cambia
    expect((await login(withMfa.email)).status).toBe(503); // con MFA, no se puede entrar sin la clave
  });
});

describe("el secreto cifrado queda atado a su cuenta", () => {
  it("copiar el secreto cifrado de otra cuenta no permite entrar con sus códigos", async () => {
    const victim = await createAccount("Víctima");
    const attacker = await createAccount("Atacante");
    const { secret: attackerSecret } = await enableMfa(attacker);
    await enableMfa(victim);
    const attackerRow = await prisma.userMfa.findUniqueOrThrow({ where: { userId: attacker.user.id } });
    await prisma.userMfa.update({
      where: { userId: victim.user.id },
      data: { secretCiphertext: attackerRow.secretCiphertext, lastUsedStep: null },
    });
    const res = await loginMfa(await challengeFor(victim.email), codeFor(attackerSecret));
    expect(res.status).toBe(500);
    expect(res.body.accessToken).toBeUndefined();
  });
});

describe("auditoría", () => {
  it("registra cada paso sin el secreto, los códigos ni el token del paso", async () => {
    const account = await createAccount("Audita MFA");
    const started = new Date();
    const { secret, recoveryCodes } = await enableMfa(account);
    const challenge = await challengeFor(account.email);
    await loginMfa(challenge, "000000" === codeFor(secret, 1) ? "111111" : "000000");
    await loginMfa(challenge, codeFor(secret, 1));
    await flushAudit();
    const rows = await prisma.auditLog.findMany({ where: { createdAt: { gte: started } } });
    const mine = rows.filter((r) => r.userId === account.user.id).map((r) => r.action);
    expect(mine).toEqual(
      expect.arrayContaining([
        "mfa.setup.started",
        "mfa.enabled",
        "auth.login.mfa_challenge",
        "auth.mfa.failure",
        "auth.login.success",
      ])
    );
    const dump = JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const s of [secret, ...recoveryCodes, challenge, ...challenge.split("."), hashToken(challenge)]) {
      expect(dump).not.toContain(s);
    }
  });
});

describe("019: garantías del esquema", () => {
  const sealedFor = (userId: string) => seal(Buffer.alloc(20, 1), env.mfaEncryptionKey!, `renta-ia/mfa/${userId}`);
  const insertMfa = (userId: string, ciphertext = sealedFor(userId)) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO user_mfa (user_id, secret_ciphertext) VALUES ($1::uuid, $2)`,
      userId,
      ciphertext
    );

  it("una cuenta pendiente no puede tener MFA (FK compuesta) ni, por lo tanto, códigos ni pasos", async () => {
    const { userId } = await invite({ role: "accountant" });
    await expect(insertMfa(userId)).rejects.toThrow(/fk_user_mfa_active_user/);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1::uuid, $2)`,
        userId,
        hashToken(unique())
      )
    ).rejects.toThrow(/mfa_recovery_codes_user_id_fkey/);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO mfa_challenges (user_id, token_hash, expires_at) VALUES ($1::uuid, $2, now() + interval '1 minute')`,
        userId,
        hashToken(unique())
      )
    ).rejects.toThrow(/mfa_challenges_user_id_fkey/);
  });

  it("una cuenta con MFA no puede volver a pendiente", async () => {
    const { user } = await createAccount("Vuelve");
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    await insertMfa(user.id);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE users SET status = 'invited', password_hash = NULL WHERE id = $1::uuid`, user.id)
    ).rejects.toThrow(/fk_user_mfa_active_user/);
  });

  it("el secreto solo se guarda cifrado (formato v1), nunca en claro", async () => {
    const { user } = await createAccount("En claro");
    await expect(insertMfa(user.id, "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")).rejects.toThrow(
      /chk_user_mfa_ciphertext_format/
    );
  });

  it("paso de login: 5 minutos como máximo y 5 intentos como máximo", async () => {
    const { user } = await createAccount("Paso SQL");
    await insertMfa(user.id);
    const insertChallenge = (minutes: number, attempts = 0) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO mfa_challenges (user_id, token_hash, expires_at, attempts) VALUES ($1::uuid, $2, now() + make_interval(mins => $3::int), $4::smallint)`,
        user.id,
        hashToken(unique()),
        minutes,
        attempts
      );
    await expect(insertChallenge(6)).rejects.toThrow(/chk_mfa_challenges_expiry/);
    await expect(insertChallenge(5, 6)).rejects.toThrow(/chk_mfa_challenges_attempts/);
    await expect(insertChallenge(5, 5)).resolves.toBe(1);
  });
});

describe("MFA obligatorio para administradores (B9)", () => {
  const get = (token: string, path: string) => request(app).get(path).set(authHeader(token));

  it("un admin sin MFA solo puede activarlo: el resto de la API responde 403 mfa_enrollment_required", async () => {
    const admin = await createAccountWithRole("admin", { name: "Admin nueva" });
    expect(admin.user.mfaEnabled).toBe(false);
    expect((await get(admin.token, "/api/users/me")).body).toMatchObject({ role: "admin", mfaEnabled: false });
    expect((await get(admin.token, ME)).body).toMatchObject({ enabled: false, required: true });

    for (const path of ["/api/clients", "/api/admin/invitations", "/api/admin/audit", "/api/users/me/mfa-otra"]) {
      const res = await get(admin.token, path);
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe("mfa_enrollment_required");
    }

    // Con la MISMA sesión, al activarlo, se abre todo (la verificación es por petición).
    const { secret } = (await setup(admin)).body;
    expect((await enable(admin, codeFor(secret))).status).toBe(200);
    expect((await get(admin.token, "/api/clients")).status).toBe(200);
    expect((await get(admin.token, "/api/admin/invitations")).status).toBe(200);
    expect((await get(admin.token, "/api/users/me")).body.mfaEnabled).toBe(true);
  });

  it("las rutas para activarlo admiten query string y barra final, pero no prefijos parecidos", async () => {
    const admin = await createAccountWithRole("admin");
    expect((await get(admin.token, "/api/users/me?x=1")).status).toBe(200);
    expect((await get(admin.token, "/api/users/me/mfa/")).status).toBe(200);
    expect((await get(admin.token, "/api/users/mexico")).body.code).toBe("mfa_enrollment_required");
  });

  it("otros roles no están obligados: un contador sin MFA usa la API normalmente", async () => {
    const accountant = await createAccount("Sin obligación");
    expect((await get(accountant.token, "/api/clients")).status).toBe(200);
    expect((await get(accountant.token, ME)).body.required).toBe(false);
  });

  it("un admin no puede desactivar su MFA; si otro admin se lo restablece, vuelve a quedar obligado", async () => {
    const admin = await createAccountWithRole("admin", { name: "Admin con MFA" });
    const { secret } = await enableMfa(admin);
    const disable = await request(app)
      .post(`${ME}/disable`)
      .set(authHeader(admin.token))
      .send({ password: TEST_PASSWORD, code: codeFor(secret, 1) });
    expect(disable.status).toBe(403);
    expect(await prisma.userMfa.count({ where: { userId: admin.user.id, enabledAt: { not: null } } })).toBe(1);

    const other = await testAdmin();
    expect(
      (await request(app).delete(`/api/admin/users/${admin.user.id}/mfa`).set(authHeader(other.token))).status
    ).toBe(204);
    const again = await login(admin.email);
    expect(again.body.user).toMatchObject({ role: "admin", mfaEnabled: false });
    expect((await get(again.body.accessToken, "/api/clients")).body.code).toBe("mfa_enrollment_required");
  });

  it("la sesión renovada (/refresh) también informa mfaEnabled", async () => {
    const account = await createAccount("Refresh MFA");
    const first = await login(account.email);
    const cookie = String(first.headers["set-cookie"]).split(";")[0]!;
    const refreshed = await request(app).post("/api/auth/refresh").set(CSRF).set("Cookie", cookie);
    expect(refreshed.body.user).toMatchObject({ mfaEnabled: false });
  });

  it("configurar entrega el QR como SVG generado en el servidor (sin scripts ni referencias externas)", async () => {
    const account = await createAccount("Con QR");
    const { qrSvg } = (await setup(account)).body as { qrSvg: string };
    expect(qrSvg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d+) \1"/);
    expect(qrSvg).not.toMatch(/<script|href|on\w+=/i);
    expect(qrSvg.length).toBeLessThan(12_000);
  });
});
