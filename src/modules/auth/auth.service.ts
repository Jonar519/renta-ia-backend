import bcrypt from "bcrypt";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { lockoutService } from "./lockout.service";
import { sessionsService } from "./sessions.service";

interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

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

export class AccountLockedError extends ApiError {
  constructor(remainingMs: number) {
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    super(429, `Demasiados intentos fallidos. Intenta de nuevo en ${minutes} minuto${minutes === 1 ? "" : "s"}.`);
  }
}

export const authService = {
  async register(input: RegisterInput) {
    const email = normalizeEmail(input.email);
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ApiError(409, "Ya existe un usuario con ese correo");
    }

    const passwordHash = await bcrypt.hash(input.password, 10);

    const user = await prisma.user.create({
      data: {
        name: input.name,
        email,
        passwordHash,
        // El registro público SIEMPRE crea contadores. Otros roles (admin,
        // assistant, client) los crea un admin (POST /api/admin/users).
        role: "accountant",
      },
    });

    return sessionsService.start(user);
  },

  async login(input: LoginInput) {
    const email = normalizeEmail(input.email);

    const remaining = await lockoutService.remainingLockMs(email);
    if (remaining > 0) throw new AccountLockedError(remaining);

    const user = await prisma.user.findUnique({ where: { email } });
    const valid = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !valid) {
      await lockoutService.registerFailure(email);
      throw new ApiError(401, INVALID_CREDENTIALS);
    }

    await lockoutService.registerSuccess(email);
    return sessionsService.start(user);
  },
};
