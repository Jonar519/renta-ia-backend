import bcrypt from "bcrypt";
import type { User } from "@prisma/client";
import { ApiError } from "../../utils/apiError";
import { AccountLockedError, lockoutService } from "./lockout.service";

/**
 * Reconfirmar la contraseña actual antes de un cambio sensible con una sesión
 * ya iniciada (configurar o desactivar MFA, cambiar el correo o la contraseña).
 * Así una sesión robada no basta. Un fallo cuenta en el bloqueo progresivo de
 * la cuenta, igual que en el login; con la cuenta bloqueada responde 429.
 *
 * 400 y no 401: en una ruta autenticada, un 401 significaría "sesión inválida".
 */
export const WRONG_CURRENT_PASSWORD = "La contraseña actual no es correcta.";

export async function assertNotLocked(email: string): Promise<void> {
  const remaining = await lockoutService.remainingLockMs(email);
  if (remaining > 0) throw new AccountLockedError(remaining);
}

export async function reconfirmPassword(user: User, password: string): Promise<void> {
  await assertNotLocked(user.email);
  if (!user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    await lockoutService.registerFailure(user.email);
    throw new ApiError(400, WRONG_CURRENT_PASSWORD);
  }
}
