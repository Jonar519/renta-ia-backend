import path from "path";

/**
 * Tipos de archivo aceptados en la subida de documentos. Se valida:
 *  1. el MIME declarado por el cliente (multer fileFilter),
 *  2. que la extensión coincida con ese MIME,
 *  3. la firma real del contenido ("magic bytes"), porque el MIME lo
 *     declara el navegador/cliente y se puede falsificar.
 */
export const ALLOWED_FILE_TYPES: Record<string, { extensions: string[]; signature: number[] }> = {
  "application/pdf": { extensions: [".pdf"], signature: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  "image/png": { extensions: [".png"], signature: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { extensions: [".jpg", ".jpeg"], signature: [0xff, 0xd8, 0xff] },
};

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB

export function isAllowedMimeAndExtension(mimetype: string, originalName: string): boolean {
  const type = ALLOWED_FILE_TYPES[mimetype];
  return !!type && type.extensions.includes(path.extname(originalName).toLowerCase());
}

export function hasValidSignature(mimetype: string, buffer: Buffer): boolean {
  const type = ALLOWED_FILE_TYPES[mimetype];
  if (!type) return false;
  return type.signature.every((byte, i) => buffer[i] === byte);
}

/**
 * Foto de perfil (B12): solo PNG o JPG, validados con la MISMA tabla de firmas
 * de arriba. El navegador ya la recorta y la reduce a 256×256 (pesa unos KB);
 * 512 KB deja margen sin aceptar archivos grandes.
 */
export const AVATAR_MIME_TYPES = ["image/png", "image/jpeg"] as const;
export const MAX_AVATAR_BYTES = 512 * 1024;

export function isAllowedAvatar(mimetype: string, buffer: Buffer): boolean {
  return (AVATAR_MIME_TYPES as readonly string[]).includes(mimetype) && hasValidSignature(mimetype, buffer);
}
