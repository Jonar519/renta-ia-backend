import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import type { AppRole, AuthPayload } from "../../middlewares/auth.middleware";

export interface VerifiedToken extends AuthPayload {
  /** Expiración (segundos desde epoch), para cerrar conexiones largas (WebSocket) a tiempo. */
  exp?: number;
  /**
   * Sesión a la que pertenece (familia de refresh tokens). Quien lo valida
   * comprueba además que siga activa (sessionsService.isActive): cerrar la
   * sesión o restablecer la contraseña invalida el access token AL INSTANTE,
   * no a los 15 minutos.
   */
  sid: string;
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
    if (
      typeof payload !== "object" ||
      typeof payload.userId !== "string" ||
      typeof payload.sid !== "string" ||
      !ROLES.includes(payload.role)
    ) {
      return null;
    }
    return { userId: payload.userId, role: payload.role as AppRole, exp: payload.exp, sid: payload.sid };
  } catch {
    return null;
  }
}
