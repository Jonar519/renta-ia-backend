import { prisma } from "../../config/prisma";

/**
 * Purga programada de datos vencidos (Fase 5, decidido tras B14; política en
 * docs/data-retention.md). Corre una vez al día en el worker.
 *
 * No se purgan las invitaciones: una vencida es lo que "Usuarios" muestra
 * como "vencida" y mantiene ligada la cuenta pendiente.
 */
const DAY = 24 * 60 * 60 * 1000;
export const RETENTION = {
  auditLogMonths: 12,
  inactiveSessionDays: 30,
  expiredRefreshTokenDays: 7,
  expiredLinkDays: 7,
  expiredMfaChallengeDays: 1,
  emailOutboxDays: 30,
  loginAttemptDays: 30,
} as const;

export const retentionService = {
  async purge(now = new Date()) {
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const auditCutoff = new Date(now);
    auditCutoff.setMonth(auditCutoff.getMonth() - RETENTION.auditLogMonths);

    const [audit, sessions, refreshTokens, resetLinks, emailLinks, mfaChallenges, outbox, loginAttempts] =
      await prisma.$transaction([
        prisma.auditLog.deleteMany({ where: { createdAt: { lt: auditCutoff } } }),
        // Sesiones sin ningún token vigente y sin actividad hace 30 días (en cascada: sus tokens).
        prisma.userSession.deleteMany({
          where: {
            lastSeenAt: { lt: ago(RETENTION.inactiveSessionDays) },
            refreshTokens: { none: { revokedAt: null, expiresAt: { gt: now } } },
          },
        }),
        prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: ago(RETENTION.expiredRefreshTokenDays) } } }),
        prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: ago(RETENTION.expiredLinkDays) } } }),
        prisma.emailChangeToken.deleteMany({ where: { expiresAt: { lt: ago(RETENTION.expiredLinkDays) } } }),
        prisma.mfaChallenge.deleteMany({ where: { expiresAt: { lt: ago(RETENTION.expiredMfaChallengeDays) } } }),
        prisma.emailOutbox.deleteMany({ where: { createdAt: { lt: ago(RETENTION.emailOutboxDays) } } }),
        prisma.loginAttempt.deleteMany({
          where: {
            lastFailure: { lt: ago(RETENTION.loginAttemptDays) },
            OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
          },
        }),
      ]);
    return {
      auditLog: audit.count,
      sessions: sessions.count,
      refreshTokens: refreshTokens.count,
      passwordResetTokens: resetLinks.count,
      emailChangeTokens: emailLinks.count,
      mfaChallenges: mfaChallenges.count,
      emailOutbox: outbox.count,
      loginAttempts: loginAttempts.count,
    };
  },
};
