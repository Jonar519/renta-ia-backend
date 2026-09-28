import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import type { AppRole, AuthPayload } from "../../middlewares/auth.middleware";

export interface VerifiedToken extends AuthPayload {
  /** Expiración (segundos desde epoch), para cerrar conexiones largas (WebSocket) a tiempo. */
  exp?: number;
}

const ROLES: AppRole[] = ["admin", "accountant", "assistant", "client"];

/**
 * Verifica un token de acceso y devuelve su contenido, o null si es inválido
 * o expiró. Único punto de verificación: lo usan el middleware HTTP y el
 * servidor WebSocket.
 */
export function verifyAccessToken(token: string): VerifiedToken | null {
  try {
    const payload = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
    if (typeof payload !== "object" || typeof payload.userId !== "string" || !ROLES.includes(payload.role)) {
      return null;
    }
    return { userId: payload.userId, role: payload.role as AppRole, exp: payload.exp };
  } catch {
    return null;
  }
}
