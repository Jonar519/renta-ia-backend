import { createHash, randomBytes, randomUUID } from "crypto";
import type { CookieOptions } from "express";
import jwt, { SignOptions } from "jsonwebtoken";
import { User } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { ApiError } from "../../utils/apiError";

/**
 * Sesión: access token corto + refresh token rotativo (docs/adr del frontend).
 *
 *  - Access token: JWT de 15 min en el header Authorization. El navegador lo
 *    guarda SOLO en memoria (un XSS no lo encuentra en localStorage y dura poco).
 *  - Refresh token: 32 bytes aleatorios en una cookie httpOnly (JavaScript no
 *    puede leerla), SameSite=Strict, Path=/api/auth, Secure en producción.
 *    En la BD solo se guarda su SHA-256.
 *  - Rotación: cada /refresh entrega un refresh token nuevo y revoca el usado.
 *  - Reutilización: si llega un token YA rotado, alguien más lo tiene (robo):
 *    se revoca la familia completa y el usuario debe volver a iniciar sesión.
 *    Excepción: dentro de REUSE_GRACE_MS se asume una carrera legítima (dos
 *    pestañas refrescando a la vez con la misma cookie) y se pide reintentar.
 */

export const REFRESH_COOKIE = "renta_ia_refresh";
export const REFRESH_COOKIE_PATH = "/api/auth";
export const REUSE_GRACE_MS = 10_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

type SessionUser = Pick<User, "id" | "name" | "email" | "role">;

export function publicUser(user: SessionUser) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

export function issueAccessToken(user: Pick<User, "id" | "role">) {
  return jwt.sign({ userId: user.id, role: user.role }, env.jwtSecret, {
    algorithm: "HS256",
    expiresIn: env.jwtExpiresIn as SignOptions["expiresIn"],
  });
}

export function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: env.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  };
}

async function storeRefreshToken(userId: string, familyId: string) {
  const raw = randomBytes(32).toString("base64url");
  const record = await prisma.refreshToken.create({
    data: {
      userId,
      familyId,
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000),
    },
  });
  return { raw, record };
}

export interface RotationResult {
  accessToken: string;
  refreshToken: string;
  user: ReturnType<typeof publicUser>;
}

export class RefreshReuseError extends ApiError {
  constructor(public readonly userId: string) {
    super(401, "La sesión se cerró por seguridad: el token de sesión ya se había usado. Inicia sesión de nuevo.");
  }
}

export const sessionsService = {
  /** Inicio de sesión: nueva familia de refresh tokens. */
  async start(user: SessionUser): Promise<RotationResult> {
    const { raw } = await storeRefreshToken(user.id, randomUUID());
    return { accessToken: issueAccessToken(user), refreshToken: raw, user: publicUser(user) };
  },

  async rotate(rawToken: string | undefined): Promise<RotationResult> {
    if (!rawToken) throw new ApiError(401, "No hay una sesión activa");
    const current = await prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
      include: { user: true },
    });
    if (!current) throw new ApiError(401, "Sesión inválida");

    if (current.revokedAt) {
      const recentRotation =
        current.revokeReason === "rotated" && Date.now() - current.revokedAt.getTime() < REUSE_GRACE_MS;
      if (recentRotation) {
        // Otra pestaña acaba de rotarlo: la cookie nueva ya está en el navegador.
        throw new ApiError(409, "La sesión se está renovando en otra pestaña; reintenta.");
      }
      if (current.revokeReason === "rotated") {
        await this.revokeFamily(current.familyId, "reuse_detected");
        throw new RefreshReuseError(current.userId);
      }
      throw new ApiError(401, "La sesión ya fue cerrada");
    }
    if (current.expiresAt.getTime() <= Date.now()) {
      throw new ApiError(401, "La sesión expiró. Inicia sesión de nuevo.");
    }

    const next = await prisma.$transaction(async (tx) => {
      // Revocación condicional: si dos peticiones rotan a la vez el mismo
      // token, solo una gana (count = 1); la otra cae en la ventana de gracia.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: "rotated" },
      });
      if (count === 0) throw new ApiError(409, "La sesión se está renovando en otra pestaña; reintenta.");
      const raw = randomBytes(32).toString("base64url");
      const record = await tx.refreshToken.create({
        data: {
          userId: current.userId,
          familyId: current.familyId,
          tokenHash: sha256(raw),
          expiresAt: new Date(Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000),
        },
      });
      await tx.refreshToken.update({ where: { id: current.id }, data: { replacedById: record.id } });
      return raw;
    });

    return { accessToken: issueAccessToken(current.user), refreshToken: next, user: publicUser(current.user) };
  },

  /** Cierre de sesión: revoca la familia del token presentado (todas sus rotaciones). */
  async end(rawToken: string | undefined): Promise<string | null> {
    if (!rawToken) return null;
    const current = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
    if (!current) return null;
    await this.revokeFamily(current.familyId, "logout");
    return current.userId;
  },

  async revokeFamily(familyId: string, reason: "logout" | "reuse_detected") {
    await prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  },
};
