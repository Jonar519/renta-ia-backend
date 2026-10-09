import bcrypt from "bcrypt";
import type { User } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { ApiError } from "../../utils/apiError";
import { createSignedToken, verifySignedToken } from "../../utils/signedToken";
import { sendEmail, type EmailMessage } from "../../services/email";
import { normalizeEmail } from "../auth/auth.service";
import { passwordProblems } from "../auth/passwordPolicy";
import { reconfirmPassword } from "../auth/reauth";
import { emailChangeNotice, emailChangeTaken, emailChangeVerification, passwordChangedNotice } from "./profile.email";

/**
 * "Mi perfil" (Fase 5, B11; migración 020).
 *
 *  - Nombre y teléfono: se editan directamente.
 *  - Correo: pedir el cambio exige la contraseña actual; el enlace (token
 *    firmado, 24 h, un solo uso, solo su hash en la base) va al correo NUEVO
 *    y se avisa al ANTERIOR. El correo cambia recién al confirmar. Si el
 *    nuevo ya es de otra cuenta, la respuesta es la misma (no se revela) y a
 *    ese correo llega un aviso sin enlace.
 *  - Contraseña: exige la actual, aplica la política y cierra TODAS las demás
 *    sesiones (las que no son la actual), y avisa por correo.
 */

export const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;
export const INVALID_EMAIL_CHANGE = "El enlace para confirmar el correo no es válido o ya venció.";

export class InvalidEmailChangeError extends ApiError {
  constructor() {
    super(410, INVALID_EMAIL_CHANGE);
  }
}

async function loadUser(userId: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== "active") throw new ApiError(404, "Usuario no encontrado");
  return user;
}

/** Los avisos no deben hacer fallar la operación ya hecha: un error se registra. */
async function notify(message: EmailMessage) {
  await sendEmail(message).catch((err: unknown) =>
    logger.warn(
      { template: message.template, err: err instanceof Error ? err.message : err },
      "No se pudo enviar un aviso"
    )
  );
}

async function pendingEmailChange(userId: string) {
  const row = await prisma.emailChangeToken.findFirst({
    where: { userId, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { newEmail: true, expiresAt: true },
  });
  return row ? { email: row.newEmail, expiresAt: row.expiresAt } : null;
}

export const profileService = {
  async me(userId: string) {
    const user = await loadUser(userId);
    const mfa = await prisma.userMfa.findUnique({ where: { userId }, select: { enabledAt: true } });
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      mfaEnabled: Boolean(mfa?.enabledAt),
      avatarUpdatedAt: user.avatarUpdatedAt,
      pendingEmail: await pendingEmailChange(userId),
    };
  },

  async update(userId: string, input: { name?: string; phone?: string | null }) {
    await loadUser(userId);
    await prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.phone !== undefined && { phone: input.phone }),
      },
    });
    return this.me(userId);
  },

  /** Pide el cambio: enlace al correo nuevo y aviso al anterior. Responde igual aunque el nuevo esté en uso. */
  async requestEmailChange(userId: string, rawNewEmail: string, password: string) {
    const user = await loadUser(userId);
    const newEmail = normalizeEmail(rawNewEmail);
    if (newEmail === user.email) throw new ApiError(400, "Es el mismo correo que ya tienes.");
    await reconfirmPassword(user, password);

    const taken = await prisma.user.findFirst({
      where: { email: newEmail, NOT: { id: userId } },
      select: { id: true },
    });
    const { token, hash } = createSignedToken("email_change");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + EMAIL_CHANGE_TTL_MS);
    // Un solo cambio pendiente por cuenta: el nuevo reemplaza al anterior.
    // También cuando el correo está en uso (así la pantalla no lo delata);
    // en ese caso el enlace nunca se envía y nadie puede confirmarlo.
    await prisma.$transaction([
      prisma.emailChangeToken.updateMany({
        where: { userId, usedAt: null, revokedAt: null },
        data: { revokedAt: createdAt },
      }),
      prisma.emailChangeToken.create({ data: { userId, newEmail, tokenHash: hash, createdAt, expiresAt } }),
    ]);
    await notify(taken ? emailChangeTaken(newEmail) : emailChangeVerification(newEmail, user.name, token, expiresAt));
    await notify(emailChangeNotice(user.email, user.name, newEmail, "requested"));
    return { pendingEmail: { email: newEmail, expiresAt } };
  },

  async cancelEmailChange(userId: string) {
    const { count } = await prisma.emailChangeToken.updateMany({
      where: { userId, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new ApiError(404, "No hay un cambio de correo pendiente.");
  },

  /** Confirma desde el enlace del correo nuevo (no exige sesión: el enlace prueba que el correo es suyo). */
  async confirmEmailChange(token: string): Promise<{ userId: string; email: string }> {
    const hash = verifySignedToken(token, "email_change");
    const row = hash
      ? await prisma.emailChangeToken.findFirst({
          // El vencimiento se verifica una sola vez, en la marca atómica de abajo.
          where: { tokenHash: hash, usedAt: null, revokedAt: null },
          include: { user: true },
        })
      : null;
    if (!row || row.user.status !== "active") throw new InvalidEmailChangeError();
    const oldEmail = row.user.email;
    const now = new Date();
    try {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.emailChangeToken.updateMany({
          where: { id: row.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (count === 0) throw new InvalidEmailChangeError();
        await tx.user.update({ where: { id: row.userId }, data: { email: row.newEmail } });
      });
    } catch (err) {
      // Otra cuenta tomó ese correo mientras tanto (índice único sobre lower(email)).
      if ((err as { code?: string }).code === "P2002") throw new ApiError(409, "Ese correo ya está en uso.");
      throw err;
    }
    await notify(emailChangeNotice(oldEmail, row.user.name, row.newEmail, "completed"));
    return { userId: row.userId, email: row.newEmail };
  },

  /** Cambia la contraseña con la actual y cierra todas las DEMÁS sesiones (la actual sigue). */
  async changePassword(userId: string, currentSid: string, currentPassword: string, newPassword: string) {
    const user = await loadUser(userId);
    await reconfirmPassword(user, currentPassword);
    const problems = passwordProblems(newPassword, { email: user.email, name: user.name });
    if (await bcrypt.compare(newPassword, user.passwordHash!)) problems.unshift("Debe ser distinta de la actual");
    if (problems.length) {
      throw new ApiError(
        400,
        "Datos inválidos",
        problems.map((message) => ({ field: "body.newPassword", message }))
      );
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const now = new Date();
    const { count: closed } = await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      // Un enlace de recuperación pendiente ya no tiene sentido.
      await tx.passwordResetToken.updateMany({
        where: { userId, usedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      return tx.refreshToken.updateMany({
        where: { userId, revokedAt: null, familyId: { not: currentSid } },
        data: { revokedAt: now, revokeReason: "password_change" },
      });
    });
    await notify(passwordChangedNotice(user.email, user.name));
    return { closedSessions: closed };
  },
};
