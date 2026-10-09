import { createHash, randomBytes, randomUUID } from "crypto";
import type { CookieOptions } from "express";
import jwt, { SignOptions } from "jsonwebtoken";
import { User } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { ApiError } from "../../utils/apiError";
import { displayIpPrefix } from "../../utils/ip";
import type { SessionClient } from "./sessionClient";

/**
 * Sesión: access token corto + refresh token rotativo (docs/adr/0007-esquema-de-sesion.md).
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
 *  - Sesiones activas (B13, migración 022): cada familia tiene una fila en
 *    user_sessions (la crea la base con el primer token; cada rotación mueve
 *    su última actividad). Al iniciar y al rotar se guarda de dónde viene
 *    (IP recortada, ubicación aproximada, equipo); la persona puede cerrar
 *    una sesión o todas las demás.
 */

export const REFRESH_COOKIE = "renta_ia_refresh";
export const REFRESH_COOKIE_PATH = "/api/auth";
export const REUSE_GRACE_MS = 10_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

type SessionUser = Pick<User, "id" | "name" | "email" | "role" | "avatarUpdatedAt" | "tableDensity">;

/** mfaEnabled: el cliente lo usa para llevar a "Seguridad" a quien debe activarlo (mfa/policy.ts). */
export function publicUser(user: SessionUser, mfaEnabled: boolean) {
  // avatarUpdatedAt: si hay foto y cuándo cambió (el cliente no muestra una vieja).
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    mfaEnabled,
    avatarUpdatedAt: user.avatarUpdatedAt,
    // B15: la densidad de las tablas llega con la sesión (no hace falta otra petición).
    tableDensity: user.tableDensity,
  };
}

async function mfaEnabledFor(userId: string): Promise<boolean> {
  const mfa = await prisma.userMfa.findUnique({ where: { userId }, select: { enabledAt: true } });
  return Boolean(mfa?.enabledAt);
}

/** sid = familia de refresh tokens de la sesión (ver tokens.ts). */
export function issueAccessToken(user: Pick<User, "id" | "role">, sid: string) {
  return jwt.sign({ userId: user.id, role: user.role, sid }, env.jwtSecret, {
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

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Nuevo refresh token de la familia; la base crea o actualiza la sesión (022). */
async function storeRefreshToken(tx: Tx, userId: string, familyId: string) {
  const raw = randomBytes(32).toString("base64url");
  const record = await tx.refreshToken.create({
    data: {
      userId,
      familyId,
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000),
    },
  });
  return { raw, record };
}

/** De dónde se usa la sesión ahora (IP recortada, ubicación aproximada, equipo). */
async function recordClient(tx: Tx, familyId: string, client: SessionClient) {
  await tx.userSession.update({
    where: { id: familyId },
    data: { ipPrefix: client.ipPrefix, location: client.location, device: client.device },
  });
}

/** Familias con algún refresh token vivo (sin revocar y sin vencer). */
const live = () => ({ revokedAt: null, expiresAt: { gt: new Date() } });

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
  async start(user: SessionUser, client: SessionClient): Promise<RotationResult> {
    const familyId = randomUUID();
    const raw = await prisma.$transaction(async (tx) => {
      const { raw } = await storeRefreshToken(tx, user.id, familyId);
      await recordClient(tx, familyId, client);
      return raw;
    });
    return {
      accessToken: issueAccessToken(user, familyId),
      refreshToken: raw,
      user: publicUser(user, await mfaEnabledFor(user.id)),
    };
  },

  async rotate(rawToken: string | undefined, client: SessionClient): Promise<RotationResult> {
    if (!rawToken) throw new ApiError(401, "No hay una sesión activa");
    const current = await prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
      include: { user: { include: { mfa: { select: { enabledAt: true } } } } },
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
      const { raw, record } = await storeRefreshToken(tx, current.userId, current.familyId);
      await tx.refreshToken.update({ where: { id: current.id }, data: { replacedById: record.id } });
      await recordClient(tx, current.familyId, client);
      return raw;
    });

    return {
      accessToken: issueAccessToken(current.user, current.familyId),
      refreshToken: next,
      user: publicUser(current.user, Boolean(current.user.mfa?.enabledAt)),
    };
  },

  /**
   * ¿Sigue activa la sesión (familia) de un access token? Activa = tiene un
   * refresh token sin revocar y sin vencer. Una consulta por el índice de
   * family_id en cada petición autenticada.
   */
  async isActive(sid: string): Promise<boolean> {
    return (await this.state(sid)) !== null;
  },

  /**
   * Estado de la sesión en UNA consulta: null si ya no está activa; si lo
   * está, además si la cuenta tiene MFA activo (para el MFA obligatorio por
   * rol, sin una segunda consulta por petición).
   */
  async state(sid: string): Promise<{ mfaEnabled: boolean } | null> {
    const live = await prisma.refreshToken.findFirst({
      where: { familyId: sid, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { user: { select: { mfa: { select: { enabledAt: true } } } } },
    });
    return live ? { mfaEnabled: Boolean(live.user.mfa?.enabledAt) } : null;
  },

  /** Cierre de sesión: revoca la familia del token presentado (todas sus rotaciones). */
  async end(rawToken: string | undefined): Promise<string | null> {
    if (!rawToken) return null;
    const current = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
    if (!current) return null;
    await this.revokeFamily(current.familyId, "logout");
    return current.userId;
  },

  /**
   * Sesiones activas de la cuenta, la actual primero y luego por última
   * actividad. Sin IP ni ubicación (sesiones anteriores a 022): null, que la
   * pantalla muestra como "desconocida".
   */
  async list(userId: string, currentSid: string) {
    const sessions = await prisma.userSession.findMany({
      where: { userId, refreshTokens: { some: live() } },
      orderBy: { lastSeenAt: "desc" },
    });
    return sessions
      .map((s) => ({
        id: s.id,
        current: s.id === currentSid,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        ip: displayIpPrefix(s.ipPrefix),
        location: s.location,
        device: s.device,
      }))
      .sort((a, b) => Number(b.current) - Number(a.current));
  },

  /**
   * Cierra UNA sesión de la propia cuenta (no la actual: para esa está
   * "Salir"). Otra cuenta o una sesión ya cerrada: 404, sin distinguir.
   * El efecto es inmediato: cada petición y el WebSocket verifican la sesión.
   */
  async close(userId: string, currentSid: string, sessionId: string) {
    if (sessionId === currentSid)
      throw new ApiError(400, "Esta es la sesión que estás usando: para cerrarla usa «Salir».");
    const { count } = await prisma.refreshToken.updateMany({
      where: { familyId: sessionId, userId, ...live() },
      data: { revokedAt: new Date(), revokeReason: "session_closed" },
    });
    if (count === 0) throw new ApiError(404, "Esa sesión no existe o ya está cerrada.");
  },

  /** Cierra todas las sesiones de la cuenta menos la actual. Devuelve cuántas cerró. */
  async closeOthers(userId: string, currentSid: string): Promise<number> {
    return prisma.$transaction(async (tx) => {
      const others = await tx.refreshToken.findMany({
        where: { userId, familyId: { not: currentSid }, ...live() },
        select: { familyId: true },
        distinct: ["familyId"],
      });
      await tx.refreshToken.updateMany({
        where: { userId, familyId: { not: currentSid }, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: "session_closed" },
      });
      return others.length;
    });
  },

  /** De estas sesiones, cuáles siguen activas (UNA consulta; el WebSocket la usa en su latido). */
  async activeAmong(sids: string[]): Promise<Set<string>> {
    if (sids.length === 0) return new Set();
    const rows = await prisma.refreshToken.findMany({
      where: { familyId: { in: sids }, ...live() },
      select: { familyId: true },
      distinct: ["familyId"],
    });
    return new Set(rows.map((r) => r.familyId));
  },

  async revokeFamily(familyId: string, reason: "logout" | "reuse_detected") {
    await prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  },
};
