import { randomBytes, randomUUID } from "crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, createAccount, TEST_PASSWORD } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { flushAudit } from "../../src/services/audit/audit.service";
import { REFRESH_COOKIE } from "../../src/modules/auth/sessions.service";

/**
 * Sesiones activas (B13, migración 022): ver dónde está abierta la cuenta
 * (IP recortada, ubicación aproximada, equipo, fechas) y cerrar una sesión o
 * todas las demás. Ownership: solo las de la propia cuenta.
 */

const CSRF = { "X-Requested-With": "renta-ia" };
const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

interface Login {
  token: string;
  cookie: string;
  sid: string;
}

/** Inicia otra sesión de la cuenta, desde "otro equipo" (User-Agent). */
async function login(email: string, userAgent = CHROME_WINDOWS): Promise<Login> {
  const res = await request(app)
    .post("/api/auth/login")
    .set("User-Agent", userAgent)
    .send({ email, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  const setCookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith(REFRESH_COOKIE));
  const token: string = res.body.accessToken;
  const sid = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sid as string;
  return { token, cookie: setCookie!.split(";")[0]!, sid };
}

const listSessions = (token: string) => request(app).get("/api/users/me/sessions").set(authHeader(token));
const closeSession = (token: string, id: string) =>
  request(app).delete(`/api/users/me/sessions/${id}`).set(authHeader(token));
const closeOthers = (token: string) => request(app).delete("/api/users/me/sessions").set(authHeader(token));
const me = (token: string) => request(app).get("/api/users/me").set(authHeader(token));
const refresh = (cookie: string, userAgent = CHROME_WINDOWS) =>
  request(app).post("/api/auth/refresh").set(CSRF).set("User-Agent", userAgent).set("Cookie", cookie);

describe("ver las sesiones activas", () => {
  it("lista cada sesión con IP recortada, ubicación aproximada, equipo y fechas; la actual primero", async () => {
    const account = await createAccount("Sesiones Lista");
    const desk = await login(account.email, CHROME_WINDOWS);
    const phone = await login(account.email, SAFARI_IPHONE);

    const res = await listSessions(phone.token);
    expect(res.status).toBe(200);
    // La de la invitación (sin User-Agent de navegador), el escritorio y el teléfono.
    expect(res.body).toHaveLength(3);
    const [current, ...others] = res.body;
    expect(current).toMatchObject({ id: phone.sid, current: true, device: "Safari en iOS" });
    expect(others.map((s: { id: string }) => s.id)).toContain(desk.sid);
    const deskRow = res.body.find((s: { id: string }) => s.id === desk.sid);
    expect(deskRow).toMatchObject({ current: false, device: "Chrome en Windows" });
    for (const s of res.body) {
      // supertest llega desde 127.0.0.1: se guarda 127.0.0.0 y se muestra 127.0.0.x; el mock la reconoce como local.
      expect(s.ip).toBe("127.0.0.x");
      expect(s.location).toBe("Red local");
      expect(new Date(s.lastSeenAt).getTime()).toBeGreaterThanOrEqual(new Date(s.createdAt).getTime());
    }
    // Desde la sesión más VIEJA, la actual también va primero (no es el orden por fecha).
    const fromDesk = (await listSessions(desk.token)).body;
    expect(fromDesk[0]).toMatchObject({ id: desk.sid, current: true });
    expect(fromDesk.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    // En la base nunca queda la IP completa.
    const stored = await prisma.userSession.findUniqueOrThrow({ where: { id: desk.sid } });
    expect(stored.ipPrefix).toBe("127.0.0.0");
  });

  it("una sesión anterior a 022 (o creada por una API sin B13) aparece sin IP, ubicación ni equipo", async () => {
    const account = await createAccount("Sesión Antigua");
    const familyId = randomUUID();
    // Como lo haría una versión anterior de la API: solo el refresh token. La base crea la sesión.
    await prisma.$executeRawUnsafe(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1::uuid, $2::uuid, $3, now() + interval '7 days')`,
      account.user.id,
      familyId,
      randomBytes(32).toString("hex")
    );
    const old = (await listSessions(account.token)).body.find((s: { id: string }) => s.id === familyId);
    expect(old).toMatchObject({ current: false, ip: null, location: null, device: null });
  });

  it("renovar el token mueve la última actividad y actualiza de dónde se usa", async () => {
    const account = await createAccount("Sesión Renovada");
    const s = await login(account.email, CHROME_WINDOWS);
    const before = await prisma.userSession.findUniqueOrThrow({ where: { id: s.sid } });
    await new Promise((r) => setTimeout(r, 20));
    expect((await refresh(s.cookie, SAFARI_IPHONE)).status).toBe(200);
    const after = await prisma.userSession.findUniqueOrThrow({ where: { id: s.sid } });
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
    expect(after.createdAt).toEqual(before.createdAt);
    expect(after.device).toBe("Safari en iOS");
  });

  it("no lista sesiones cerradas ni vencidas, ni las de otra cuenta", async () => {
    const account = await createAccount("Sesiones Filtro");
    const other = await createAccount("Otra Cuenta Sesiones");
    const closed = await login(account.email);
    const expired = await login(account.email);
    await request(app).post("/api/auth/logout").set(CSRF).set("Cookie", closed.cookie);
    await prisma.refreshToken.updateMany({
      where: { familyId: expired.sid },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const ids = (await listSessions(account.token)).body.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(closed.sid);
    expect(ids).not.toContain(expired.sid);
    const otherIds = (await listSessions(other.token)).body.map((s: { id: string }) => s.id);
    expect(otherIds.some((id: string) => ids.includes(id))).toBe(false);
  });

  it("sin sesión: 401", async () => {
    expect((await request(app).get("/api/users/me/sessions")).status).toBe(401);
  });
});

describe("cerrar sesiones", () => {
  it("cerrar una: su access token deja de servir AL INSTANTE y su refresh también; se audita", async () => {
    const account = await createAccount("Cierra Una");
    const other = await login(account.email);
    expect((await me(other.token)).status).toBe(200);

    expect((await closeSession(account.token, other.sid)).status).toBe(204);
    expect((await me(other.token)).status).toBe(401);
    expect((await refresh(other.cookie)).status).toBe(401);
    expect((await me(account.token)).status).toBe(200); // la actual sigue
    const ids = (await listSessions(account.token)).body.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(other.sid);

    const reasons = await prisma.refreshToken.findMany({
      where: { familyId: other.sid },
      select: { revokeReason: true },
    });
    expect(reasons.every((r) => r.revokeReason === "session_closed")).toBe(true);
    await flushAudit();
    const entry = await prisma.auditLog.findFirst({ where: { action: "user.session.close", entityId: other.sid } });
    expect(entry?.userId).toBe(account.user.id);
  });

  it("la sesión actual no se cierra aquí (400: para eso está Salir)", async () => {
    const account = await createAccount("Cierra Actual");
    const s = await login(account.email);
    const res = await closeSession(s.token, s.sid);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Salir");
    expect((await me(s.token)).status).toBe(200);
  });

  it("la de otra cuenta, una inexistente o una ya cerrada: 404 sin distinguir; un id inválido: 400", async () => {
    const owner = await createAccount("Dueña Sesión");
    const intruder = await createAccount("Intrusa Sesión");
    const victim = await login(owner.email);

    const foreign = await closeSession(intruder.token, victim.sid);
    expect(foreign.status).toBe(404);
    expect((await me(victim.token)).status).toBe(200); // no se cerró
    expect((await closeSession(intruder.token, randomUUID())).body).toEqual(foreign.body);

    expect((await closeSession(owner.token, victim.sid)).status).toBe(204);
    expect((await closeSession(owner.token, victim.sid)).status).toBe(404);
    expect((await closeSession(owner.token, "no-es-un-uuid")).status).toBe(400);
  });

  it("cerrar todas las demás: responde cuántas, las otras dejan de servir y la actual sigue", async () => {
    const account = await createAccount("Cierra Demás");
    const a = await login(account.email);
    const b = await login(account.email, SAFARI_IPHONE);
    const current = await login(account.email);

    const res = await closeOthers(current.token);
    expect(res.status).toBe(200);
    expect(res.body.closed).toBe(3); // a, b y la de la invitación
    for (const s of [a, b]) expect((await me(s.token)).status).toBe(401);
    expect((await me(current.token)).status).toBe(200);
    const list = (await listSessions(current.token)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: current.sid, current: true });
    expect((await closeOthers(current.token)).body.closed).toBe(0);

    await flushAudit();
    expect(
      await prisma.auditLog.count({ where: { action: "user.session.close_others", userId: account.user.id } })
    ).toBe(2);
  });

  it("cerrar las demás no toca las sesiones de otra cuenta", async () => {
    const account = await createAccount("Demás Propias");
    const bystander = await createAccount("Otra Persona");
    await closeOthers(account.token);
    expect((await me(bystander.token)).status).toBe(200);
  });
});

describe("022: garantías de la base", () => {
  const sql = (query: string, ...params: unknown[]) => prisma.$executeRawUnsafe(query, ...params);

  it("la IP completa no se puede guardar; solo el prefijo (IPv4 /24, IPv6 /48)", async () => {
    const account = await createAccount("IP Completa");
    const sid = (await login(account.email)).sid;
    const setIp = (ip: string) => sql(`UPDATE user_sessions SET ip_prefix = $1 WHERE id = $2::uuid`, ip, sid);
    for (const bad of ["181.49.12.77", "181.49.12.1", "999.1.1.0", "2001:db8:85a3:1::", "2001:db8::7"]) {
      await expect(setIp(bad), bad).rejects.toThrow(/chk_user_sessions_ip_prefix/);
    }
    for (const ok of ["181.49.12.0", "2001:db8:85a3::", "::"]) await expect(setIp(ok)).resolves.toBe(1);
  });

  it("un token no puede pertenecer a la sesión de otra cuenta", async () => {
    const a = await createAccount("Familia A");
    const b = await createAccount("Familia B");
    const sidA = (await login(a.email)).sid;
    await expect(
      sql(
        `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
         VALUES ($1::uuid, $2::uuid, $3, now() + interval '1 day')`,
        b.user.id,
        sidA,
        randomBytes(32).toString("hex")
      )
    ).rejects.toThrow(/fk_refresh_tokens_session/);
  });

  it("la última actividad nunca retrocede (un token con fecha vieja no la mueve hacia atrás)", async () => {
    const account = await createAccount("Actividad");
    const s = await login(account.email);
    const before = await prisma.userSession.findUniqueOrThrow({ where: { id: s.sid } });
    await sql(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3, now() + interval '1 day', now() - interval '3 days')`,
      account.user.id,
      s.sid,
      randomBytes(32).toString("hex")
    );
    const after = await prisma.userSession.findUniqueOrThrow({ where: { id: s.sid } });
    expect(after.lastSeenAt).toEqual(before.lastSeenAt);
  });

  it("borrar la sesión borra sus tokens (no quedan tokens sin sesión)", async () => {
    const account = await createAccount("Borra Sesión");
    const s = await login(account.email);
    await sql(`DELETE FROM user_sessions WHERE id = $1::uuid`, s.sid);
    expect(await prisma.refreshToken.count({ where: { familyId: s.sid } })).toBe(0);
  });
});
