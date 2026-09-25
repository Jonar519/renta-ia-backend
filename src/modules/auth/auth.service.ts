import bcrypt from "bcryptjs";
import jwt, { SignOptions } from "jsonwebtoken";
import { User } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { ApiError } from "../../utils/apiError";

interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

interface LoginInput {
  email: string;
  password: string;
}

function buildAuthResponse(user: Pick<User, "id" | "name" | "email" | "role">) {
  const token = jwt.sign({ userId: user.id, role: user.role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn as SignOptions["expiresIn"],
  });

  return {
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  };
}

/**
 * Los emails se guardan y se buscan siempre en minúsculas (y sin espacios):
 * "Ana@Example.com" y "ana@example.com" son la misma cuenta. La base de
 * datos lo refuerza con un índice único sobre lower(email).
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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
        // assistant) solo pueden asignarse directamente en la base de datos.
        role: "accountant",
      },
    });

    return buildAuthResponse(user);
  },

  async login(input: LoginInput) {
    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(input.email) } });
    if (!user) {
      throw new ApiError(401, "Credenciales inválidas");
    }

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
      throw new ApiError(401, "Credenciales inválidas");
    }

    return buildAuthResponse(user);
  },
};
