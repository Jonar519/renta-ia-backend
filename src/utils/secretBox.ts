import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * Cifrado autenticado de secretos pequeños (AES-256-GCM) para guardarlos en
 * la base. Formato: "v1.<iv>.<tag>.<cifrado>" (base64url).
 *
 *  - IV aleatorio de 12 bytes por cada cifrado.
 *  - El "contexto" (p. ej. el id de la cuenta) va como datos asociados (AAD):
 *    no se cifra, pero queda atado al resultado. Copiar el secreto cifrado de
 *    una cuenta a la fila de otra hace que el descifrado FALLE.
 *  - La clave nunca está en la base (MFA_ENCRYPTION_KEY, ver env.ts).
 *  - "v1": permite rotar la clave o el algoritmo más adelante sin ambigüedad.
 */
const VERSION = "v1";

export function seal(plaintext: Buffer, key: Buffer, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), encrypted]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

/** Descifra; lanza si la clave, el contexto o el contenido no coinciden (GCM lo detecta). */
export function open(sealed: string, key: Buffer, context: string): Buffer {
  const [version, iv, tag, encrypted, ...rest] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !encrypted || rest.length)
    throw new Error("Formato de secreto cifrado inválido");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]);
}
