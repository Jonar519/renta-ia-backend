import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * TOTP (RFC 6238) sobre HOTP (RFC 4226), con HMAC-SHA1, 6 dígitos y pasos de
 * 30 s: lo que esperan Google Authenticator, Microsoft Authenticator, 1Password,
 * Aegis, etc. Sin dependencias: son ~40 líneas con el módulo crypto de Node,
 * verificadas contra los vectores de prueba de los propios RFC.
 */
export const STEP_SECONDS = 30;
export const DIGITS = 6;
/** Pasos de tolerancia a cada lado (reloj del teléfono desfasado): ±30 s. */
export const WINDOW = 1;
/** 160 bits, el tamaño recomendado por el RFC 4226 para HMAC-SHA1. */
export const SECRET_BYTES = 20;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32 (RFC 4648)

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Carácter inválido en base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateSecret = () => randomBytes(SECRET_BYTES);

/** HOTP(K, C): truncamiento dinámico del HMAC (RFC 4226, sección 5.3). */
export function hotp(secret: Buffer, counter: number, digits = DIGITS, algorithm = "sha1"): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export const stepAt = (timeMs: number) => Math.floor(timeMs / 1000 / STEP_SECONDS);

export function totp(secret: Buffer, timeMs = Date.now(), digits = DIGITS, algorithm = "sha1"): string {
  return hotp(secret, stepAt(timeMs), digits, algorithm);
}

const sameCode = (a: string, b: string) => timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Verifica un código de 6 dígitos dentro de la ventana (±1 paso) y devuelve
 * el paso que coincidió, o null. Solo acepta pasos POSTERIORES a lastUsedStep:
 * un código ya usado (o uno anterior) no vuelve a servir (anti-replay).
 */
export function verifyTotp(secret: Buffer, code: string, lastUsedStep: bigint | null, timeMs = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(timeMs);
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    if (lastUsedStep !== null && BigInt(step) <= lastUsedStep) continue;
    if (sameCode(hotp(secret, step), code)) return step;
  }
  return null;
}

/** URI que leen las apps de autenticación (también es el contenido del QR). */
export function otpauthUri(secret: Buffer, accountName: string, issuer = "Renta IA"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
