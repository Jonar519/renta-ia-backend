import bcrypt from "bcrypt";
import { createHash, randomInt } from "crypto";
import type { User } from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { open, seal } from "../../utils/secretBox";
import { createSignedToken, verifySignedToken } from "../../utils/signedToken";
import { AccountLockedError, lockoutService } from "../auth/lockout.service";
import { base32Encode, generateSecret, otpauthUri, verifyTotp } from "./totp";

/**
 * Segundo factor TOTP (Fase 5, B8; migración 019).
 *
 * Configurar: (1) con la contraseña actual se genera un secreto y se guarda
 * CIFRADO, sin activar; (2) con un código de la app se confirma: MFA queda
 * activo, se entregan 10 códigos de recuperación (UNA vez; en la base solo
 * su hash) y se cierran las DEMÁS sesiones de la cuenta, que se abrieron con
 * un solo factor.
 *
 * Login: contraseña correcta + MFA activo → no hay sesión todavía, sino un
 * "paso de verificación" (token firmado, 5 min, 5 intentos). Con el código
 * (o un código de recuperación) se inicia la sesión.
 *
 * Cada código fallido (login, desactivar, regenerar) cuenta en el bloqueo
 * progresivo de la cuenta (lockout.service), igual que una contraseña errada.
 */

export const SETUP_TTL_MS = 10 * 60 * 1000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_CHALLENGE_ATTEMPTS = 5;
export const RECOVERY_CODE_COUNT = 10;

export class MfaNotConfiguredError extends ApiError {
  constructor() {
    super(
      503,
      "La verificación en dos pasos no está disponible: el servidor no tiene configurada MFA_ENCRYPTION_KEY (ver README)."
    );
  }
}

export const INVALID_CHALLENGE = "La verificación venció o ya no es válida. Inicia sesión de nuevo.";
export class InvalidChallengeError extends ApiError {
  constructor() {
    super(401, INVALID_CHALLENGE);
  }
}

/** Código incorrecto en el login (401: es una ruta de /api/auth). Lleva la cuenta para auditar. */
export class MfaCodeError extends ApiError {
  constructor(public readonly userId: string) {
    super(401, "El código no es correcto.");
  }
}

// En las rutas autenticadas (/api/users/me/mfa) un dato incorrecto es 400:
// un 401 ahí significaría "sesión inválida" para el cliente.
const wrongCode = () =>
  new ApiError(400, "El código no es correcto. Revisa la hora de tu teléfono e intenta con el siguiente.");
const wrongPassword = () => new ApiError(400, "La contraseña no es correcta.");

function encryptionKey(): Buffer {
  if (!env.mfaEncryptionKey) throw new MfaNotConfiguredError();
  return env.mfaEncryptionKey;
}

const context = (userId: string) => `renta-ia/mfa/${userId}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// --- Códigos de recuperación: 16 caracteres Crockford base32 (80 bits), "XXXX-XXXX-XXXX-XXXX".
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function newRecoveryCode(): string {
  let raw = "";
  for (let i = 0; i < 16; i++) raw += CROCKFORD[randomInt(32)];
  return raw.match(/.{4}/g)!.join("-");
}

/** Mayúsculas, sin guiones ni espacios; O→0 e I/L→1 (Crockford tolera esas confusiones). */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

const hashRecoveryCode = (code: string) => sha256(normalizeRecoveryCode(code));

function newRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(newRecoveryCode());
  return [...codes];
}

async function loadUser(userId: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== "active") throw new ApiError(404, "Usuario no encontrado");
  return user;
}

async function assertNotLocked(email: string) {
  const remaining = await lockoutService.remainingLockMs(email);
  if (remaining > 0) throw new AccountLockedError(remaining);
}

/** Reconfirmar la contraseña (configurar o desactivar MFA): cuenta en el bloqueo si falla. */
async function checkPassword(user: User, password: string) {
  await assertNotLocked(user.email);
  if (!user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    await lockoutService.registerFailure(user.email);
    throw wrongPassword();
  }
}

/**
 * Verifica un código TOTP (y lo marca como usado: anti-replay atómico) o, si
 * se permite, un código de recuperación (lo gasta). Devuelve qué se usó, o
 * null si no sirvió.
 */
async function consumeSecondFactor(
  userId: string,
  code: string,
  { allowRecovery }: { allowRecovery: boolean }
): Promise<"totp" | "recovery" | null> {
  const mfa = await prisma.userMfa.findUnique({ where: { userId } });
  if (!mfa?.enabledAt) return null;
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const secret = open(mfa.secretCiphertext, encryptionKey(), context(userId));
    const step = verifyTotp(secret, trimmed, mfa.lastUsedStep);
    if (step === null) return null;
    // Condicional: dos peticiones con el mismo código a la vez → solo una gana.
    const { count } = await prisma.userMfa.updateMany({
      where: { userId, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(step) } }] },
      data: { lastUsedStep: BigInt(step) },
    });
    return count === 1 ? "totp" : null;
  }
  if (!allowRecovery || normalizeRecoveryCode(trimmed).length !== 16) return null;
  const { count } = await prisma.mfaRecoveryCode.updateMany({
    where: { userId, codeHash: hashRecoveryCode(trimmed), usedAt: null },
    data: { usedAt: new Date() },
  });
  return count === 1 ? "recovery" : null;
}

export const mfaService = {
  async status(userId: string) {
    const mfa = await prisma.userMfa.findUnique({ where: { userId } });
    const enabled = Boolean(mfa?.enabledAt);
    const recoveryCodesRemaining = enabled
      ? await prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } })
      : 0;
    return { enabled, enabledAt: mfa?.enabledAt ?? null, recoveryCodesRemaining };
  },

  async isEnabled(userId: string): Promise<boolean> {
    const mfa = await prisma.userMfa.findUnique({ where: { userId }, select: { enabledAt: true } });
    return Boolean(mfa?.enabledAt);
  },

  /** Paso 1: secreto nuevo (cifrado, sin activar). Reemplaza una configuración a medias. */
  async beginSetup(userId: string, password: string) {
    const key = encryptionKey();
    const user = await loadUser(userId);
    await checkPassword(user, password);
    if (await this.isEnabled(userId)) {
      throw new ApiError(
        409,
        "La verificación en dos pasos ya está activa. Desactívala antes de configurarla de nuevo."
      );
    }
    const secret = generateSecret();
    const createdAt = new Date();
    const secretCiphertext = seal(secret, key, context(userId));
    await prisma.userMfa.upsert({
      where: { userId },
      create: { userId, secretCiphertext, createdAt },
      update: { secretCiphertext, createdAt, lastUsedStep: null },
    });
    return {
      secret: base32Encode(secret),
      otpauthUri: otpauthUri(secret, user.email),
      expiresAt: new Date(createdAt.getTime() + SETUP_TTL_MS),
    };
  },

  /** Paso 2: confirmar con un código. Activa MFA y cierra las demás sesiones. */
  async enable(userId: string, code: string, currentSid: string) {
    const key = encryptionKey();
    const mfa = await prisma.userMfa.findUnique({ where: { userId } });
    if (mfa?.enabledAt) throw new ApiError(409, "La verificación en dos pasos ya está activa.");
    if (!mfa || Date.now() - mfa.createdAt.getTime() > SETUP_TTL_MS) {
      if (mfa) await prisma.userMfa.deleteMany({ where: { userId, enabledAt: null } });
      throw new ApiError(410, "La configuración venció o no se empezó. Empieza de nuevo.");
    }
    const step = verifyTotp(open(mfa.secretCiphertext, key, context(userId)), code.trim(), null);
    if (step === null) throw wrongCode();

    const recoveryCodes = newRecoveryCodes();
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.userMfa.updateMany({
        where: { userId, enabledAt: null, createdAt: mfa.createdAt },
        data: { enabledAt: now, lastUsedStep: BigInt(step) },
      });
      if (count === 0) throw new ApiError(409, "La configuración cambió mientras tanto. Empieza de nuevo.");
      await tx.mfaRecoveryCode.createMany({
        data: recoveryCodes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })),
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null, familyId: { not: currentSid } },
        data: { revokedAt: now, revokeReason: "mfa_enabled" },
      });
    });
    return { recoveryCodes };
  },

  /** Desactivar: contraseña + código (o código de recuperación). */
  async disable(userId: string, password: string, code: string) {
    encryptionKey();
    const user = await loadUser(userId);
    await checkPassword(user, password);
    if (!(await this.isEnabled(userId))) throw new ApiError(409, "La verificación en dos pasos no está activa.");
    if (!(await consumeSecondFactor(userId, code, { allowRecovery: true }))) {
      await lockoutService.registerFailure(user.email);
      throw wrongCode();
    }
    await prisma.userMfa.delete({ where: { userId } }); // en cascada: códigos y pasos de login
  },

  /** Códigos de recuperación nuevos (invalida todos los anteriores). Pide un código de la app. */
  async regenerateRecoveryCodes(userId: string, code: string) {
    encryptionKey();
    const user = await loadUser(userId);
    await assertNotLocked(user.email);
    if (!(await this.isEnabled(userId))) throw new ApiError(409, "La verificación en dos pasos no está activa.");
    if (!(await consumeSecondFactor(userId, code, { allowRecovery: false }))) {
      await lockoutService.registerFailure(user.email);
      throw wrongCode();
    }
    const recoveryCodes = newRecoveryCodes();
    await prisma.$transaction([
      prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
      prisma.mfaRecoveryCode.createMany({
        data: recoveryCodes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })),
      }),
    ]);
    return { recoveryCodes };
  },

  /**
   * Un admin restablece el MFA de OTRA cuenta (perdió el teléfono y los
   * códigos): se borra su MFA y se cierran todas sus sesiones. La persona
   * entra solo con su contraseña y vuelve a configurarlo.
   */
  async adminReset(actorId: string, targetUserId: string) {
    if (actorId === targetUserId) {
      throw new ApiError(
        403,
        "No puedes restablecer tu propia verificación en dos pasos: pídeselo a otro administrador."
      );
    }
    const now = new Date();
    const removed = await prisma.$transaction(async (tx) => {
      const { count } = await tx.userMfa.deleteMany({ where: { userId: targetUserId, enabledAt: { not: null } } });
      if (count === 0) return false;
      await tx.refreshToken.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: now, revokeReason: "mfa_reset" },
      });
      return true;
    });
    if (!removed) throw new ApiError(404, "Esa cuenta no tiene la verificación en dos pasos activa.");
  },

  /** Login con MFA activo: paso de verificación (sin sesión todavía). */
  async startChallenge(userId: string) {
    encryptionKey();
    const { token, hash } = createSignedToken("mfa_challenge");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + CHALLENGE_TTL_MS);
    await prisma.mfaChallenge.create({ data: { userId, tokenHash: hash, createdAt, expiresAt } });
    return { challengeToken: token, expiresAt };
  },

  /** Completa el login: devuelve la cuenta y qué se usó (app o código de recuperación). */
  async completeChallenge(token: string, code: string): Promise<{ user: User; method: "totp" | "recovery" }> {
    encryptionKey();
    const hash = verifySignedToken(token, "mfa_challenge");
    const challenge = hash
      ? await prisma.mfaChallenge.findFirst({
          where: {
            tokenHash: hash,
            usedAt: null,
            expiresAt: { gt: new Date() },
            attempts: { lt: MAX_CHALLENGE_ATTEMPTS },
          },
        })
      : null;
    if (!challenge) throw new InvalidChallengeError();
    const user = await loadUser(challenge.userId);
    await assertNotLocked(user.email);

    const method = await consumeSecondFactor(user.id, code, { allowRecovery: true });
    if (!method) {
      await prisma.mfaChallenge.updateMany({
        where: { id: challenge.id, attempts: { lt: MAX_CHALLENGE_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      await lockoutService.registerFailure(user.email);
      throw new MfaCodeError(user.id);
    }
    const { count } = await prisma.mfaChallenge.updateMany({
      where: { id: challenge.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (count === 0) throw new InvalidChallengeError();
    await lockoutService.registerSuccess(user.email);
    return { user, method };
  },
};
