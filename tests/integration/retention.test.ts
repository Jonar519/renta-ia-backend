import { randomBytes, randomUUID } from "crypto";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Account, app, authHeader, createAccount, TEST_PASSWORD } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { base32Decode, totp } from "../../src/modules/mfa/totp";
import { RETENTION, retentionService } from "../../src/services/retention/retention.service";

/**
 * Purga programada de datos vencidos (docs/data-retention.md): cada categoría
 * con un dato viejo (se borra) y uno reciente o vigente (se queda). Y la tarea
 * diaria registrada junto a la de Web Vitals.
 */

const DAY = 24 * 60 * 60 * 1000;
const hex = () => randomBytes(32).toString("hex");
const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * DAY);
const sql = (query: string, ...params: unknown[]) => prisma.$executeRawUnsafe(query, ...params);

async function enableMfa(a: Account) {
  const setup = await request(app)
    .post("/api/users/me/mfa/setup")
    .set(authHeader(a.token))
    .send({ password: TEST_PASSWORD });
  await request(app)
    .post("/api/users/me/mfa/enable")
    .set(authHeader(a.token))
    .send({ code: totp(base32Decode(setup.body.secret)) });
}

/** Una sesión con un único refresh token creado `days` días atrás (vencido o no, revocado o no). */
async function sessionCreated(userId: string, days: number, opts: { expiresInDays: number; revoked?: boolean }) {
  const familyId = randomUUID();
  await sql(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, created_at, expires_at, revoked_at, revoke_reason)
     VALUES ($1::uuid, $2::uuid, $3, now() - make_interval(days => $4::int),
             now() - make_interval(days => $4::int) + make_interval(days => $5::int),
             CASE WHEN $6::boolean THEN now() - make_interval(days => $4::int) END,
             CASE WHEN $6::boolean THEN 'logout' END)`,
    userId,
    familyId,
    hex(),
    days,
    opts.expiresInDays,
    Boolean(opts.revoked)
  );
  return familyId;
}

describe("purga programada", () => {
  it("borra lo vencido de cada categoría y deja lo vigente", async () => {
    const now = new Date();
    const account = await createAccount("Retención");
    const userId = account.user.id;
    await enableMfa(account);

    // audit_log: 13 meses (se va) y 11 meses (se queda).
    const old = new Date(now);
    old.setMonth(old.getMonth() - 13);
    const recent = new Date(now);
    recent.setMonth(recent.getMonth() - 11);
    const oldAudit = await prisma.auditLog.create({ data: { action: "auth.login.success", userId, createdAt: old } });
    const recentAudit = await prisma.auditLog.create({
      data: { action: "auth.login.success", userId, createdAt: recent },
    });

    // Sesiones: cerrada hace 40 días (se va); cerrada hace 10 (se queda); sin
    // actividad hace 40 días pero con un token aún vigente (se queda).
    const goneSession = await sessionCreated(userId, 40, { expiresInDays: 7, revoked: true });
    const recentClosed = await sessionCreated(userId, 10, { expiresInDays: 7, revoked: true });
    const stillValid = await sessionCreated(userId, 40, { expiresInDays: 60 });
    // Refresh token vencido hace 8 días dentro de una sesión activa: se va el token, no la sesión.
    const live = await sessionCreated(userId, 0, { expiresInDays: 7 });
    await sql(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, created_at, expires_at, revoked_at, revoke_reason)
       VALUES ($1::uuid, $2::uuid, $3, now() - interval '15 days', now() - interval '8 days', now() - interval '14 days', 'rotated')`,
      userId,
      live,
      hex()
    );

    // Enlaces: vencidos hace 8 días (se van) y hace 2 (se quedan).
    const link = (table: string, ttl: string, days: number, extra = "") =>
      sql(
        `INSERT INTO ${table} (user_id, token_hash, created_at, expires_at${extra ? ", new_email" : ""})
         VALUES ($1::uuid, $2, now() - make_interval(days => $3::int) - interval '${ttl}',
                 now() - make_interval(days => $3::int)${extra ? `, '${extra}'` : ""})`,
        userId,
        hex(),
        days
      );
    await link("password_reset_tokens", "10 minutes", 8);
    await sql(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1::uuid`, userId); // uno abierto por cuenta
    await link("password_reset_tokens", "10 minutes", 2);
    await link("email_change_tokens", "1 hour", 8, "viejo@test.local");
    await sql(`UPDATE email_change_tokens SET used_at = now() WHERE user_id = $1::uuid`, userId);
    await link("email_change_tokens", "1 hour", 2, "reciente@test.local");

    // Pasos del login con MFA: vencido hace 2 días (se va) y hace 1 hora (se queda).
    // (El MFA se activa al principio: activarlo cierra las demás sesiones.)
    const challenge = (ago: string) =>
      sql(
        `INSERT INTO mfa_challenges (user_id, token_hash, created_at, expires_at)
         VALUES ($1::uuid, $2, now() - interval '${ago}' - interval '2 minutes', now() - interval '${ago}')`,
        userId,
        hex()
      );
    await challenge("2 days");
    await challenge("1 hour");

    // email_outbox: 31 días (se va) y 29 (se queda).
    const to = `retencion-${Date.now()}@test.local`;
    for (const days of [31, 29]) {
      await prisma.emailOutbox.create({
        data: {
          provider: "mock",
          toAddress: to,
          template: "test",
          subject: "x",
          status: "sent",
          createdAt: daysAgo(now, days),
        },
      });
    }

    // Intentos fallidos: viejo (se va), reciente (se queda), viejo pero bloqueado hoy (se queda).
    const attempts = [
      { keyHash: hex(), lastFailure: daysAgo(now, 31), lockedUntil: null },
      { keyHash: hex(), lastFailure: daysAgo(now, 5), lockedUntil: null },
      { keyHash: hex(), lastFailure: daysAgo(now, 31), lockedUntil: new Date(now.getTime() + DAY) },
    ];
    await prisma.loginAttempt.createMany({ data: attempts.map((a) => ({ ...a, failures: 3 })) });

    const result = await retentionService.purge(now);

    expect(await prisma.auditLog.findUnique({ where: { id: oldAudit.id } })).toBeNull();
    expect(await prisma.auditLog.findUnique({ where: { id: recentAudit.id } })).not.toBeNull();
    expect(await prisma.userSession.findUnique({ where: { id: goneSession } })).toBeNull();
    expect(await prisma.refreshToken.count({ where: { familyId: goneSession } })).toBe(0);
    expect(await prisma.userSession.findUnique({ where: { id: recentClosed } })).not.toBeNull();
    expect(await prisma.userSession.findUnique({ where: { id: stillValid } })).not.toBeNull();
    expect(await prisma.userSession.findUnique({ where: { id: live } })).not.toBeNull();
    expect(await prisma.refreshToken.count({ where: { familyId: live } })).toBe(1); // el vencido se fue
    expect(await prisma.passwordResetToken.count({ where: { userId } })).toBe(1);
    expect(await prisma.emailChangeToken.findMany({ where: { userId }, select: { newEmail: true } })).toEqual([
      { newEmail: "reciente@test.local" },
    ]);
    expect(await prisma.mfaChallenge.count({ where: { userId } })).toBe(1);
    expect(await prisma.emailOutbox.count({ where: { toAddress: to } })).toBe(1);
    const left = await prisma.loginAttempt.findMany({ where: { keyHash: { in: attempts.map((a) => a.keyHash) } } });
    expect(left.map((a) => a.keyHash).sort()).toEqual([attempts[1]!.keyHash, attempts[2]!.keyHash].sort());

    for (const key of Object.keys(result) as (keyof typeof result)[]) expect(result[key]).toBeGreaterThanOrEqual(1);
  });

  it("los plazos son los de docs/data-retention.md", () => {
    expect(RETENTION).toEqual({
      auditLogMonths: 12,
      inactiveSessionDays: 30,
      expiredRefreshTokenDays: 7,
      expiredLinkDays: 7,
      expiredMfaChallengeDays: 1,
      emailOutboxDays: 30,
      loginAttemptDays: 30,
    });
  });

  it("no toca las invitaciones vencidas (Usuarios las muestra como vencidas)", async () => {
    const before = await prisma.userInvitation.count();
    await retentionService.purge(new Date(Date.now() + 400 * DAY));
    expect(await prisma.userInvitation.count()).toBe(before);
  });
});

describe("tarea diaria", () => {
  it("se registra junto a la de Web Vitals y llama a la purga", async () => {
    vi.resetModules();
    const upsert = vi.fn().mockResolvedValue(undefined);
    let processor: ((job: { name: string }) => Promise<unknown>) | undefined;
    vi.doMock("bullmq", () => ({
      Queue: vi.fn(),
      Worker: vi.fn().mockImplementation((_name: string, fn: typeof processor) => {
        processor = fn;
        return { on: vi.fn() };
      }),
    }));
    vi.doMock("../../src/queues/scheduledQueue", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/queues/scheduledQueue")>();
      return { ...actual, scheduledQueue: { upsertJobScheduler: upsert } };
    });
    const purge = vi.fn().mockResolvedValue({ auditLog: 0 });
    vi.doMock("../../src/services/retention/retention.service", () => ({ retentionService: { purge } }));

    const { startScheduledTasks } = await import("../../src/workers/scheduledTasks");
    await startScheduledTasks();
    const ids = upsert.mock.calls.map((c) => c[0]);
    expect(ids).toEqual(expect.arrayContaining(["web-vitals-retention-daily", "data-retention-daily"]));
    const call = upsert.mock.calls.find((c) => c[0] === "data-retention-daily")!;
    expect(call[1]).toMatchObject({ pattern: "45 3 * * *" });
    expect(call[2]).toEqual({ name: "data-retention" });

    await processor!({ name: "data-retention" });
    expect(purge).toHaveBeenCalledTimes(1);
    vi.doUnmock("bullmq");
    vi.doUnmock("../../src/queues/scheduledQueue");
    vi.doUnmock("../../src/services/retention/retention.service");
  });
});
