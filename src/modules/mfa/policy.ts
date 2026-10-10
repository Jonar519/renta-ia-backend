import type { Request } from "express";

/**
 * MFA obligatorio por rol (Fase 5, B9). Hoy: solo administradores, que pueden
 * invitar cuentas, ver la auditoría y restablecer el MFA de otros.
 *
 * Una cuenta de estos roles SIN MFA activo puede iniciar sesión (con la
 * contraseña), pero la API solo le responde lo necesario para activarlo:
 * GET /api/users/me y /api/users/me/mfa/*. Todo lo demás: 403 con
 * code "mfa_enrollment_required" (el frontend la lleva a "Seguridad").
 * Tampoco puede desactivarlo; si pierde el teléfono y los códigos, otro
 * admin se lo restablece y vuelve a quedar obligada a activarlo.
 */
export const MFA_REQUIRED_ROLES: readonly string[] = ["admin"];

export const mfaRequiredFor = (role: string) => MFA_REQUIRED_ROLES.includes(role);

export const MFA_ENROLLMENT_REQUIRED = "mfa_enrollment_required";
export const MFA_ENROLLMENT_MESSAGE =
  "Como administrador, debes activar la verificación en dos pasos antes de continuar.";

/** ¿Es una de las rutas que se pueden usar antes de activar el MFA obligatorio? */
export function isEnrollmentPath(req: Request): boolean {
  const path = (req.originalUrl.split("?")[0] ?? "").replace(/\/+$/, "");
  return path === "/api/users/me" || path === "/api/users/me/mfa" || path.startsWith("/api/users/me/mfa/");
}
