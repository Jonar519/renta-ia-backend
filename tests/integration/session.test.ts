import { describe, expect, it } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { app, authHeader, TEST_PASSWORD, unique } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { flushAudit } from "../../src/services/audit/audit.service";
import { REFRESH_COOKIE } from "../../src/modules/auth/sessions.service";
import { FREE_ATTEMPTS, lockMinutesFor, lockoutService } from "../../src/modules/auth/lockout.service";

const CSRF = { "X-Requested-With": "renta-ia" };

/** Extrae el Set-Cookie de la cookie de refresh (atributos incluidos). */
function refreshSetCookie(res: request.Response): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
}

function cookieValue(setCookie: string | undefined): string {
  if (!setCookie) throw new Error("No llegó la cookie de refresh");
  return setCookie.split(";")[0];
}

async function registerWithCookie() {
  const email = `sesion-${unique()}@test.local`;
  const res = await request(app).post("/api/auth/register").send({ name: "Sesión", email, password: TEST_PASSWORD });
  expect(res.status).toBe(201);
  return { email, res, cookie: cookieValue(refreshSetCookie(res)), userId: res.body.user.id as string };
}

const refresh = (cookie?: string) => {
  const req = request(app).post("/api/auth/refresh").set(CSRF);
  return cookie ? req.set("Cookie", cookie) : req;
};

describe("Sesión: access token corto + refresh token rotativo", () => {
  it("login entrega access token de 15 min en el cuerpo y el refresh SOLO en cookie httpOnly/SameSite=Strict", async () => {
    const { email } = await registerWithCookie();
    const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["accessToken", "user"]);

    const payload = jwt.decode(res.body.accessToken) as { iat: number; exp: number };
    expect(payload.exp - payload.iat).toBe(15 * 60);

    const setCookie = refreshSetCookie(res)!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/auth/i);
    // En la BD solo se guarda el hash, nunca el token.
    const raw = decodeURIComponent(cookieValue(setCookie).split("=")[1]);
    expect(await prisma.refreshToken.count({ where: { tokenHash: raw } })).toBe(0);
  });

  it("refresh rota el token: entrega uno nuevo y el anterior queda revocado", async () => {
    const { cookie, userId } = await registerWithCookie();
    const res = await refresh(cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(userId);
    const next = cookieValue(refreshSetCookie(res));
    expect(next).not.toBe(cookie);

    // El access token nuevo funciona en la API.
    expect((await request(app).get("/api/clients").set(authHeader(res.body.accessToken))).status).toBe(200);

    const tokens = await prisma.refreshToken.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
    expect(tokens).toHaveLength(2);
    expect(tokens[0].revokeReason).toBe("rotated");
    expect(tokens[0].replacedById).toBe(tokens[1].id);
    expect(tokens[1].revokedAt).toBeNull();
  });

  it("reutilizar un refresh token ya rotado revoca toda la familia (robo detectado) y se audita", async () => {
    const { cookie, userId } = await registerWithCookie();
    const rotated = await refresh(cookie);
    const freshCookie = cookieValue(refreshSetCookie(rotated));

    // Fuera de la ventana de gracia (carreras entre pestañas).
    await prisma.refreshToken.updateMany({
      where: { userId, revokeReason: "rotated" },
      data: { revokedAt: new Date(Date.now() - 60_000) },
    });

    expect((await refresh(cookie)).status).toBe(401);
    // El token más reciente de la familia tampoco sirve ya.
    expect((await refresh(freshCookie)).status).toBe(401);
    expect(await prisma.refreshToken.count({ where: { userId, revokedAt: null } })).toBe(0);

    await flushAudit();
    expect(await prisma.auditLog.count({ where: { userId, action: "auth.refresh.reuse_detected" } })).toBe(1);
  });

  it("dos refresh seguidos con el mismo token (dos pestañas): uno rota y el otro recibe 409, sin revocar la familia", async () => {
    const { cookie, userId } = await registerWithCookie();
    expect((await refresh(cookie)).status).toBe(200);
    expect((await refresh(cookie)).status).toBe(409);
    expect(await prisma.refreshToken.count({ where: { userId, revokedAt: null } })).toBe(1);
  });

  it("logout revoca la sesión en el servidor y borra la cookie", async () => {
    const { cookie, userId } = await registerWithCookie();
    const res = await request(app).post("/api/auth/logout").set(CSRF).set("Cookie", cookie);
    expect(res.status).toBe(204);
    expect(refreshSetCookie(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await refresh(cookie)).status).toBe(401);
    expect(await prisma.refreshToken.count({ where: { userId, revokeReason: "logout" } })).toBe(1);
  });

  it("refresh y logout exigen el encabezado anti-CSRF y un Origin permitido", async () => {
    const { cookie } = await registerWithCookie();
    expect((await request(app).post("/api/auth/refresh").set("Cookie", cookie)).status).toBe(403);
    expect((await request(app).post("/api/auth/logout").set("Cookie", cookie)).status).toBe(403);
    const foreign = await refresh(cookie).set("Origin", "https://atacante.example");
    expect(foreign.status).toBe(403);
    // La sesión sigue viva: los intentos rechazados no la consumieron.
    expect((await refresh(cookie)).status).toBe(200);
  });

  it("CORS permite credenciales solo al origen configurado", async () => {
    const allowed = await request(app)
      .options("/api/auth/refresh")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "x-requested-with");
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");

    const foreign = await request(app)
      .options("/api/auth/refresh")
      .set("Origin", "https://atacante.example")
      .set("Access-Control-Request-Method", "POST");
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refresh sin cookie da 401", async () => {
    expect((await refresh()).status).toBe(401);
  });
});

describe("Bloqueo progresivo por cuenta", () => {
  it("la escala del bloqueo es 1, 2, 4… minutos con tope de 60", () => {
    expect(lockMinutesFor(FREE_ATTEMPTS - 1)).toBe(0);
    expect(lockMinutesFor(FREE_ATTEMPTS)).toBe(1);
    expect(lockMinutesFor(FREE_ATTEMPTS + 1)).toBe(2);
    expect(lockMinutesFor(FREE_ATTEMPTS + 2)).toBe(4);
    expect(lockMinutesFor(FREE_ATTEMPTS + 20)).toBe(60);
  });

  it(`tras ${FREE_ATTEMPTS} fallos la cuenta se bloquea (429) incluso con la contraseña correcta`, async () => {
    const { email } = await registerWithCookie();
    for (let i = 0; i < FREE_ATTEMPTS; i++) {
      const res = await request(app).post("/api/auth/login").send({ email, password: "incorrecta-123" });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Credenciales inválidas");
    }
    const locked = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toMatch(/Intenta de nuevo en 1 minuto/);

    // Pasado el bloqueo, un login correcto funciona y reinicia el contador.
    await prisma.loginAttempt.updateMany({ data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).status).toBe(200);
    expect(await lockoutService.remainingLockMs(email)).toBe(0);

    await flushAudit();
    const actions = await prisma.auditLog.findMany({ where: { userId: null }, select: { action: true } });
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(["auth.login.failure", "auth.login.locked"]));
  });

  it("un correo inexistente se bloquea igual que uno real (no revela qué cuentas existen)", async () => {
    const ghost = `fantasma-${unique()}@test.local`;
    for (let i = 0; i < FREE_ATTEMPTS; i++) await lockoutService.registerFailure(ghost);
    expect(await lockoutService.remainingLockMs(ghost)).toBeGreaterThan(0);
    // Se guarda el hash del correo, no el correo.
    const rows = await prisma.loginAttempt.findMany();
    expect(JSON.stringify(rows)).not.toContain("fantasma");
  });
});

describe("Auditoría", () => {
  it("no guarda datos sensibles: ni correo, ni contraseña, ni tokens", async () => {
    const { email, userId, cookie } = await registerWithCookie();
    await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    await flushAudit();
    const rows = await prisma.auditLog.findMany({ where: { userId } });
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["auth.register", "auth.login.success"]));
    const dump = JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(dump).not.toContain(email);
    expect(dump).not.toContain(TEST_PASSWORD);
    expect(dump).not.toContain(cookie.split("=")[1]);
  });
});
