import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { env } from "../config/env";

/**
 * Tokens de un solo uso que viajan por correo (invitación; luego
 * recuperación de contraseña y cambio de correo).
 *
 *   token = <32 bytes aleatorios, base64url> "." <HMAC-SHA256 de esos bytes>
 *
 *  - FIRMADO con una clave derivada de JWT_SECRET y del PROPÓSITO: un token
 *    de invitación no sirve como token de recuperación, y uno inventado o
 *    alterado se rechaza sin consultar la base.
 *  - En la base se guarda SOLO su SHA-256 (columna token_hash). Quien lea la
 *    base no puede reconstruir el enlace.
 *  - Un solo uso y vencimiento: los impone la tabla de cada propósito.
 */
export type TokenPurpose = "invitation" | "password_reset" | "email_change";

const MAX_TOKEN_LENGTH = 200;

const keyFor = (purpose: TokenPurpose) =>
  createHmac("sha256", env.jwtSecret).update(`renta-ia/signed-token/${purpose}`).digest();

const sign = (purpose: TokenPurpose, body: string) => createHmac("sha256", keyFor(purpose)).update(body).digest();

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function createSignedToken(purpose: TokenPurpose): { token: string; hash: string } {
  const body = randomBytes(32).toString("base64url");
  const token = `${body}.${sign(purpose, body).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

/** Devuelve el hash a buscar en la base, o null si el token está mal formado o la firma no coincide. */
export function verifySignedToken(token: unknown, purpose: TokenPurpose): string | null {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
  const [body, signature, ...rest] = token.split(".");
  if (!body || !signature || rest.length) return null;
  if (!/^[\w-]{43}$/.test(body) || !/^[\w-]{43}$/.test(signature)) return null;
  const expected = sign(purpose, body);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return hashToken(token);
}
