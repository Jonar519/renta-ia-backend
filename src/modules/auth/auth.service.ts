import bcrypt from "bcrypt";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { AccountLockedError, lockoutService } from "./lockout.service";
import { sessionsService } from "./sessions.service";
import type { SessionClient } from "./sessionClient";
import { mfaService } from "../mfa/mfa.service";

export { AccountLockedError };

interface LoginInput {
  email: string;
  password: string;
}

// Mismo mensaje para "no existe" y "contraseña incorrecta": no se revela
// qué correos tienen cuenta.
const INVALID_CREDENTIALS = "Credenciales inválidas";

// Hash de una contraseña aleatoria: cuando el correo no existe se compara
// igual contra este hash, para que la respuesta tarde lo mismo que con un
// correo real (si no, el tiempo de respuesta revelaría qué cuentas existen).
const DUMMY_HASH = bcrypt.hashSync(`dummy-${Math.random()}`, 10);

/**
 * Los emails se guardan y se buscan siempre en minúsculas (y sin espacios):
 * "Ana@Example.com" y "ana@example.com" son la misma cuenta. La base de
 * datos lo refuerza con un índice único sobre lower(email).
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const authService = {
  async login(input: LoginInput, client: SessionClient) {
    const email = normalizeEmail(input.email);

    const remaining = await lockoutService.remainingLockMs(email);
    if (remaining > 0) throw new AccountLockedError(remaining);

    const user = await prisma.user.findUnique({ where: { email } });
    // Una cuenta pendiente (invitada) no tiene contraseña: se compara contra el
    // hash ficticio y responde EXACTAMENTE igual que un correo inexistente
    // (mismo mensaje y mismo tiempo), sin revelar que la cuenta existe. La
    // base además le impide tener sesiones (migración 017).
    const valid = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || user.status !== "active" || !valid) {
      await lockoutService.registerFailure(email);
      throw new ApiError(401, INVALID_CREDENTIALS);
    }

    // Con MFA activo la contraseña no basta: no hay sesión todavía, sino un
    // paso de verificación (el bloqueo se limpia al completarlo).
    if (await mfaService.isEnabled(user.id)) {
      return { mfaRequired: true as const, userId: user.id, ...(await mfaService.startChallenge(user.id)) };
    }
    await lockoutService.registerSuccess(email);
    return { mfaRequired: false as const, ...(await sessionsService.start(user, client)) };
  },
};
