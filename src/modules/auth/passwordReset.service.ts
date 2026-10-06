import bcrypt from "bcrypt";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { createSignedToken, verifySignedToken } from "../../utils/signedToken";
import { sendEmail, type EmailMessage } from "../../services/email";
import { audit } from "../../services/audit/audit.service";
import { normalizeEmail } from "./auth.service";
import { lockoutService } from "./lockout.service";
import { passwordProblems } from "./passwordPolicy";
import { escapeHtml } from "../../utils/escapeHtml";

/**
 * Recuperación de contraseña (Fase 5, B7; migración 018).
 *
 *  - Pedirla responde SIEMPRE lo mismo y en el mismo tiempo, exista o no el
 *    correo: el trabajo (buscar la cuenta, crear el token, enviar el correo)
 *    se hace DESPUÉS de responder. Así ni el mensaje ni el tiempo de
 *    respuesta revelan qué correos tienen cuenta.
 *  - Token firmado (propósito "password_reset"), 15 minutos, un solo uso;
 *    en la base solo su hash. Un solo token vigente por cuenta: pedir otro
 *    revoca el anterior. Como máximo un correo por minuto a la misma cuenta.
 *  - Usarlo: cambia la contraseña, revoca TODAS las sesiones (y con ellas
 *    los access tokens, que verifican su sesión en cada petición) y limpia
 *    el bloqueo por intentos fallidos.
 */

export const RESET_TTL_MS = 15 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const RESET_REQUESTED_MESSAGE =
  "Si hay una cuenta activa con ese correo, te enviamos un enlace para crear una contraseña nueva. Vence en 15 minutos.";
export const INVALID_RESET = "El enlace para restablecer la contraseña no es válido o ya venció. Pide uno nuevo.";

export class InvalidResetTokenError extends ApiError {
  constructor() {
    super(410, INVALID_RESET);
  }
}

// Trabajo diferido en curso (las pruebas y el apagado ordenado lo esperan).
const pending = new Set<Promise<void>>();

export function flushPasswordResets(): Promise<void> {
  return Promise.all([...pending]).then(() => undefined);
}

function resetEmail(to: string, name: string, token: string, expiresAt: Date): EmailMessage {
  const link = `${env.appUrl}/#/restablecer/${token}`;
  const until = expiresAt.toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
  });
  return {
    to,
    template: "password_reset",
    subject: "Restablece tu contraseña de Renta IA",
    text: [
      `Hola, ${name}:`,
      "",
      "Pediste crear una contraseña nueva para tu cuenta de Renta IA. Abre este enlace:",
      "",
      link,
      "",
      `Sirve una sola vez y vence a las ${until} (hora de Colombia), 15 minutos después de pedirlo.`,
      "Al usarlo se cerrarán todas tus sesiones abiertas.",
      "Si no lo pediste tú, ignora este correo: tu contraseña no cambia.",
    ].join("\n"),
    html: `<p>Hola, ${escapeHtml(name)}:</p>
<p>Pediste crear una contraseña nueva para tu cuenta de Renta IA.</p>
<p><a href="${escapeHtml(link)}">Crear una contraseña nueva</a></p>
<p>Sirve una sola vez y vence a las ${until} (hora de Colombia). Al usarlo se cerrarán todas tus sesiones abiertas.</p>
<p>Si no lo pediste tú, ignora este correo: tu contraseña no cambia.</p>`,
  };
}

/** Lo que pasa después de responder (ver arriba). Nunca lanza: los errores se registran. */
async function processRequest(rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  const user = await prisma.user.findUnique({ where: { email } });
  // Correo inexistente o cuenta pendiente (sin contraseña): no se hace nada.
  if (!user || user.status !== "active") return;

  const recent = await prisma.passwordResetToken.findFirst({
    where: {
      userId: user.id,
      usedAt: null,
      revokedAt: null,
      createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) },
    },
    select: { id: true },
  });
  if (recent) return; // ya se envió uno hace menos de un minuto: el anterior sigue sirviendo

  const { token, hash } = createSignedToken("password_reset");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + RESET_TTL_MS);
  await prisma.$transaction([
    prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null, revokedAt: null },
      data: { revokedAt: createdAt },
    }),
    prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: hash, createdAt, expiresAt } }),
  ]);
  await sendEmail(resetEmail(user.email, user.name, token, expiresAt));
  audit(null, { action: "auth.password_reset.requested", userId: user.id, entity: "user", entityId: user.id });
}

/** Token vigente (sin usar, sin revocar, sin vencer) para la firma dada, o 410 genérico. */
async function findOpenToken(token: string) {
  const hash = verifySignedToken(token, "password_reset");
  const row = hash
    ? await prisma.passwordResetToken.findFirst({
        where: { tokenHash: hash, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        include: { user: true },
      })
    : null;
  if (!row || row.user.status !== "active") throw new InvalidResetTokenError();
  return row;
}

export const passwordResetService = {
  /** Responde de inmediato; el trabajo queda en segundo plano. */
  request(email: string) {
    const work = processRequest(email)
      .catch((err: unknown) =>
        logger.warn(
          { err: err instanceof Error ? err.message : err },
          "No se pudo procesar una recuperación de contraseña"
        )
      )
      .finally(() => pending.delete(work));
    pending.add(work);
    return { message: RESET_REQUESTED_MESSAGE };
  },

  async lookup(token: string) {
    const row = await findOpenToken(token);
    return { expiresAt: row.expiresAt };
  },

  /** Cambia la contraseña y revoca todas las sesiones de la cuenta. Devuelve el id de la cuenta. */
  async confirm(token: string, password: string): Promise<string> {
    const row = await findOpenToken(token);
    const problems = passwordProblems(password, { email: row.user.email, name: row.user.name });
    if (problems.length) {
      throw new ApiError(
        400,
        "Datos inválidos",
        problems.map((message) => ({ field: "body.password", message }))
      );
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const now = new Date();
    const done = await prisma.$transaction(async (tx) => {
      // Un solo uso: solo gana quien marca como usado el token todavía abierto.
      const { count } = await tx.passwordResetToken.updateMany({
        where: { id: row.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (count === 0) return false;
      await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
      await tx.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: now, revokeReason: "password_reset" },
      });
      return true;
    });
    if (!done) throw new InvalidResetTokenError();
    // Quien recupera su cuenta no debe quedar bloqueado por los intentos fallidos previos.
    await lockoutService.registerSuccess(row.user.email);
    return row.userId;
  },
};
