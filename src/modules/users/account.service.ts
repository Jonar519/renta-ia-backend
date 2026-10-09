import type { User } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { storageService } from "../../services/storage";
import { ApiError } from "../../utils/apiError";
import { reconfirmPassword } from "../auth/reauth";
import { lockoutService } from "../auth/lockout.service";
import { sessionsService } from "../auth/sessions.service";
import { mfaService } from "../mfa/mfa.service";
import { flushAudit } from "../../services/audit/audit.service";
import { ipPrefix } from "../../utils/ip";
import { deviceLabel } from "../../utils/userAgent";

/**
 * Exportar y eliminar la propia cuenta (Fase 5, B14; migraciones 023-024).
 * Qué se exporta, qué se borra y qué se conserva (y por qué):
 * docs/data-retention.md.
 *
 *  - Exportar: un JSON con los datos de la PERSONA (su cuenta, sus sesiones,
 *    su actividad, sus conversaciones con la IA, qué documentos subió). Los
 *    datos de los clientes de un contador no son suyos: solo se cuentan.
 *    Exige la contraseña (una sesión robada no basta para llevarse los datos).
 *  - Eliminar: contraseña + segundo factor si lo tiene. La fila de users NO
 *    se borra: queda como lápida anónima ("Cuenta eliminada"), porque los
 *    documentos que subió (documents.uploaded_by, ON DELETE RESTRICT) son del
 *    expediente del cliente y deben seguir teniendo autor. La base exige que
 *    la lápida no tenga datos personales ni sesiones (024).
 */

export const DELETED_NAME = "Cuenta eliminada";
export const deletedEmail = (userId: string) => `eliminada-${userId}@renta-ia.invalid`;

async function loadActiveUser(userId: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== "active") throw new ApiError(404, "Usuario no encontrado");
  return user;
}

async function avatarDataUri(user: User): Promise<string | null> {
  if (!user.avatarKey) return null;
  const buffer = await storageService.readAsBuffer(user.avatarKey).catch(() => null);
  if (!buffer) return null;
  const type = user.avatarKey.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${type};base64,${buffer.toString("base64")}`;
}

/** Por qué no se puede eliminar la cuenta todavía (o null si se puede). */
async function deletionBlocker(user: User): Promise<string | null> {
  const clients = await prisma.client.count({ where: { accountantUserId: user.id } });
  if (clients > 0) {
    return clients === 1
      ? "Tienes 1 cliente a tu cargo. Elimínalo antes de eliminar tu cuenta: Renta IA todavía no permite pasarlo a otro contador."
      : `Tienes ${clients} clientes a tu cargo. Elimínalos antes de eliminar tu cuenta: Renta IA todavía no permite pasarlos a otro contador.`;
  }
  if (user.role === "admin") {
    const otherAdmins = await prisma.user.count({ where: { role: "admin", status: "active", id: { not: user.id } } });
    if (otherAdmins === 0) {
      return "Eres el único administrador activo. Invita a otro administrador antes de eliminar tu cuenta.";
    }
  }
  return null;
}

async function deleteAvatarQuietly(key: string | null) {
  if (!key) return;
  await storageService
    .delete(key)
    .catch((err: unknown) =>
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        "No se pudo borrar la foto de una cuenta eliminada"
      )
    );
}

export const accountService = {
  async exportData(userId: string, currentSid: string, password: string) {
    const user = await loadActiveUser(userId);
    await reconfirmPassword(user, password);

    const [mfa, recoveryLeft, pendingEmail, sessions, activity, conversations, documents, links, portal, clientCount] =
      await Promise.all([
        prisma.userMfa.findUnique({ where: { userId }, select: { enabledAt: true } }),
        prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } }),
        prisma.emailChangeToken.findFirst({
          where: { userId, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
          select: { newEmail: true, expiresAt: true },
        }),
        sessionsService.list(userId, currentSid),
        // Lo que hizo la persona y lo que otros hicieron sobre su cuenta.
        prisma.auditLog.findMany({
          where: { OR: [{ userId }, { entity: "user", entityId: userId }] },
          orderBy: { createdAt: "asc" },
          select: {
            userId: true,
            action: true,
            entity: true,
            entityId: true,
            ip: true,
            userAgent: true,
            createdAt: true,
          },
        }),
        prisma.aiConversation.findMany({
          where: { userId },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            clientId: true,
            createdAt: true,
            messages: { orderBy: { createdAt: "asc" }, select: { role: true, content: true, createdAt: true } },
          },
        }),
        prisma.document.findMany({
          where: { uploadedBy: userId },
          orderBy: { uploadedAt: "asc" },
          select: { id: true, clientId: true, originalName: true, docType: true, status: true, uploadedAt: true },
        }),
        prisma.accountantAssistant.findMany({
          where: { OR: [{ assistantUserId: userId }, { accountantUserId: userId }] },
          select: {
            assistantUserId: true,
            assistant: { select: { name: true } },
            accountant: { select: { name: true } },
          },
        }),
        prisma.client.findFirst({
          where: { portalUserId: userId },
          select: { id: true, fullName: true, documentNumber: true, email: true, phone: true, createdAt: true },
        }),
        prisma.client.count({ where: { accountantUserId: userId } }),
      ]);

    return {
      format: "renta-ia-export-v1",
      exportedAt: new Date(),
      readme:
        "Tus datos en Renta IA. Incluye tu cuenta, tus sesiones activas, tu actividad registrada, tus conversaciones con la IA y qué documentos subiste (sin los archivos). Los datos de los clientes que atiendes no son tuyos y no se incluyen: solo cuántos son.",
      account: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        pendingEmailChange: pendingEmail,
        preferences: { tableDensity: user.tableDensity },
        photo: user.avatarKey ? { updatedAt: user.avatarUpdatedAt, dataUri: await avatarDataUri(user) } : null,
      },
      twoStepVerification: {
        enabled: Boolean(mfa?.enabledAt),
        since: mfa?.enabledAt ?? null,
        recoveryCodesLeft: recoveryLeft,
      },
      activeSessions: sessions,
      // La IP y el navegador solo de lo que hizo la persona: si fue otra cuenta (p. ej. un admin
      // que restableció su MFA), esos datos son de esa otra persona y no se entregan.
      activity: activity.map(({ userId: actor, ip, userAgent, ...entry }) =>
        actor === userId ? { ...entry, byYou: true, ip, userAgent } : { ...entry, byYou: false }
      ),
      aiConversations: conversations,
      uploadedDocuments: documents,
      assists: links.filter((l) => l.assistantUserId === userId).map((l) => ({ accountant: l.accountant.name })),
      assistants: links.filter((l) => l.assistantUserId !== userId).map((l) => ({ assistant: l.assistant.name })),
      portalClient: portal,
      clientsInCharge: clientCount,
    };
  },

  /** ¿Se puede eliminar? Para que la pantalla lo diga antes de pedir la contraseña. */
  async deletionStatus(userId: string) {
    const blocker = await deletionBlocker(await loadActiveUser(userId));
    return { canDelete: blocker === null, reason: blocker };
  },

  /**
   * `client`: IP y User-Agent de la petición, solo para el registro de la
   * eliminación, que se guarda ya recortado (como el resto de su auditoría).
   */
  async deleteAccount(
    userId: string,
    password: string,
    code: string | undefined,
    client: { ip?: string; userAgent?: string }
  ) {
    const user = await loadActiveUser(userId);
    await reconfirmPassword(user, password);
    await mfaService.confirmSecondFactor(user, code);
    const blocker = await deletionBlocker(user);
    if (blocker) throw new ApiError(409, blocker);

    const pending = await prisma.emailChangeToken.findMany({ where: { userId }, select: { newEmail: true } });
    const addresses = [user.email, ...pending.map((p) => p.newEmail)].map((a) => a.toLowerCase());
    // Que no quede ningún registro de auditoría de esta cuenta en vuelo: se
    // escribiría después del recorte, con la IP y el navegador completos.
    await flushAudit();
    await prisma.$transaction(async (tx) => {
      // Primero lo que exige una cuenta activa (FK compuestas de 017-022): sin
      // esto, la base no deja pasar la cuenta a "deleted".
      await tx.userMfa.deleteMany({ where: { userId } }); // en cascada: códigos y pasos del login
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      await tx.emailChangeToken.deleteMany({ where: { userId } });
      await tx.userSession.deleteMany({ where: { userId } }); // en cascada: refresh tokens
      // Vínculos y contenido propio.
      await tx.accountantAssistant.deleteMany({
        where: { OR: [{ assistantUserId: userId }, { accountantUserId: userId }] },
      });
      await tx.client.updateMany({ where: { portalUserId: userId }, data: { portalUserId: null } });
      await tx.aiConversation.deleteMany({ where: { userId } }); // en cascada: mensajes
      // Correos guardados por el proveedor simulado (y el registro de envíos de SES).
      await tx.emailOutbox.deleteMany({ where: { toAddress: { in: addresses, mode: "insensitive" } } });
      // Su auditoría se conserva (12 meses), pero sin datos personales: IP
      // recortada (/24 en IPv4, /48 en IPv6) y "navegador en sistema" en vez
      // del User-Agent completo. Solo sus filas: lo que otras cuentas hicieron
      // sobre la suya es dato de esas otras personas.
      const seen = await tx.auditLog.findMany({
        where: { userId },
        select: { ip: true, userAgent: true },
        distinct: ["ip", "userAgent"],
      });
      for (const ip of new Set(seen.map((r) => r.ip).filter((v): v is string => v !== null))) {
        await tx.auditLog.updateMany({ where: { userId, ip }, data: { ip: ipPrefix(ip) } });
      }
      for (const ua of new Set(seen.map((r) => r.userAgent).filter((v): v is string => v !== null))) {
        await tx.auditLog.updateMany({ where: { userId, userAgent: ua }, data: { userAgent: deviceLabel(ua) } });
      }
      await tx.auditLog.create({
        data: {
          action: "user.account.delete",
          userId,
          entity: "user",
          entityId: userId,
          ip: ipPrefix(client.ip),
          userAgent: deviceLabel(client.userAgent),
        },
      });
      // La lápida (024 exige que no quede nada personal).
      await tx.user.update({
        where: { id: userId },
        data: {
          status: "deleted",
          deletedAt: new Date(),
          name: DELETED_NAME,
          email: deletedEmail(userId),
          phone: null,
          passwordHash: null,
          avatarKey: null,
          avatarUpdatedAt: null,
        },
      });
    });
    await lockoutService.registerSuccess(user.email); // el contador de intentos fallidos de ese correo
    await deleteAvatarQuietly(user.avatarKey);
  },
};
