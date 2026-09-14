import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { ApiError } from "../../utils/apiError";
import { AppRole } from "../../middlewares/auth.middleware";

interface RegisterInput {
  name: string;
  email: string;
  password: string;
  role?: AppRole;
}

interface LoginInput {
  email: string;
  password: string;
}

function buildAuthResponse(user: Pick<User, "id" | "name" | "email" | "role">) {
  const token = jwt.sign({ userId: user.id, role: user.role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });

  return {
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  };
}

export const authService = {
  async register(input: RegisterInput) {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new ApiError(409, "Ya existe un usuario con ese correo");
    }

    const passwordHash = await bcrypt.hash(input.password, 10);

    const user = await prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash,
        role: input.role ?? "accountant",
      },
    });

    return buildAuthResponse(user);
  },

  async login(input: LoginInput) {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
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
