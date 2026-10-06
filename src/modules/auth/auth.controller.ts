import { Request, Response } from "express";
import { AccountLockedError, authService } from "./auth.service";
import {
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  RefreshReuseError,
  refreshCookieOptions,
  sessionsService,
} from "./sessions.service";
import { audit } from "../../services/audit/audit.service";
import { ApiError } from "../../utils/apiError";
import { InvalidInvitationError, invitationsService } from "../invitations/invitations.service";
import { InvalidResetTokenError, passwordResetService } from "./passwordReset.service";

/** Audita los enlaces de invitación rechazados (sin el token: solo IP y user agent). */
async function auditingInvalid<T>(req: Request, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof InvalidInvitationError) audit(req, { action: "auth.invitation.invalid" });
    throw err;
  }
}

function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  // Parseo mínimo del header Cookie: solo interesa una cookie conocida.
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== REFRESH_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function clearRefreshCookie(res: Response) {
  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE, { ...options, path: REFRESH_COOKIE_PATH });
}

/** Responde con el access token (en el cuerpo) y el refresh token (solo en la cookie httpOnly). */
function sendSession(res: Response, status: number, session: Awaited<ReturnType<typeof sessionsService.start>>) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions());
  res.status(status).json({ accessToken: session.accessToken, user: session.user });
}

export const authController = {
  async login(req: Request, res: Response) {
    try {
      const session = await authService.login(req.body);
      audit(req, { action: "auth.login.success", userId: session.user.id, entity: "user", entityId: session.user.id });
      sendSession(res, 200, session);
    } catch (err) {
      // Sin el correo: la auditoría de fallos solo guarda IP y user agent.
      if (err instanceof AccountLockedError) audit(req, { action: "auth.login.locked" });
      else if (err instanceof ApiError && err.statusCode === 401) audit(req, { action: "auth.login.failure" });
      throw err;
    }
  },

  /** "Completa tu cuenta": datos de la invitación para un enlace válido. */
  async lookupInvitation(req: Request, res: Response) {
    res.json(await auditingInvalid(req, () => invitationsService.lookup(req.body.token)));
  },

  /** Activa la cuenta invitada con la contraseña elegida por la persona e inicia sesión. */
  async acceptInvitation(req: Request, res: Response) {
    const session = await auditingInvalid(req, () => invitationsService.accept(req.body.token, req.body.password));
    audit(req, {
      action: "auth.invitation.accept",
      userId: session.user.id,
      entity: "user",
      entityId: session.user.id,
    });
    sendSession(res, 200, session);
  },

  /** Siempre 202 con el mismo mensaje: no revela si el correo existe (ver passwordReset.service). */
  async requestPasswordReset(req: Request, res: Response) {
    res.status(202).json(passwordResetService.request(req.body.email));
  },

  async lookupPasswordReset(req: Request, res: Response) {
    try {
      res.json(await passwordResetService.lookup(req.body.token));
    } catch (err) {
      if (err instanceof InvalidResetTokenError) audit(req, { action: "auth.password_reset.invalid" });
      throw err;
    }
  },

  /** Cambia la contraseña y cierra todas las sesiones; hay que volver a iniciar sesión. */
  async confirmPasswordReset(req: Request, res: Response) {
    try {
      const userId = await passwordResetService.confirm(req.body.token, req.body.password);
      audit(req, { action: "auth.password_reset.completed", userId, entity: "user", entityId: userId });
      res.status(204).end();
    } catch (err) {
      if (err instanceof InvalidResetTokenError) audit(req, { action: "auth.password_reset.invalid" });
      throw err;
    }
  },

  async refresh(req: Request, res: Response) {
    try {
      const session = await sessionsService.rotate(readRefreshCookie(req));
      sendSession(res, 200, session);
    } catch (err) {
      if (err instanceof RefreshReuseError) {
        audit(req, { action: "auth.refresh.reuse_detected", userId: err.userId, entity: "session" });
      }
      // 409 = carrera entre pestañas: la cookie del navegador ya es la nueva.
      if (!(err instanceof ApiError && err.statusCode === 409)) clearRefreshCookie(res);
      throw err;
    }
  },

  async logout(req: Request, res: Response) {
    const userId = await sessionsService.end(readRefreshCookie(req));
    if (userId) audit(req, { action: "auth.logout", userId, entity: "user", entityId: userId });
    clearRefreshCookie(res);
    res.status(204).end();
  },
};
