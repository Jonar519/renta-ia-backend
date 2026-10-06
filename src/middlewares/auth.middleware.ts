import { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/apiError";
import { verifyAccessToken } from "../modules/auth/tokens";
import { sessionsService } from "../modules/auth/sessions.service";

export const SESSION_CLOSED = "La sesión se cerró. Inicia sesión de nuevo.";

export type AppRole = "admin" | "accountant" | "assistant" | "client";

export interface AuthPayload {
  userId: string;
  role: AppRole;
}

/** Lo que queda en req.user: la cuenta y su sesión (sid), p. ej. para cerrar las DEMÁS sesiones. */
export interface RequestUser extends AuthPayload {
  sid: string;
}

// Agrega req.user al tipo Request de Express (module augmentation).
declare module "express-serve-static-core" {
  interface Request {
    user?: RequestUser;
  }
}

export function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new ApiError(401, "Token no proporcionado");
  }

  const payload = verifyAccessToken(header.slice("Bearer ".length));
  if (!payload) {
    throw new ApiError(401, "Token inválido o expirado");
  }
  // La firma no basta: la sesión debe seguir activa (cerrar sesión o
  // restablecer la contraseña invalida el access token al instante).
  sessionsService
    .isActive(payload.sid)
    .then((active) => {
      if (!active) return next(new ApiError(401, SESSION_CLOSED));
      req.user = { userId: payload.userId, role: payload.role, sid: payload.sid };
      next();
    })
    .catch(next);
}
