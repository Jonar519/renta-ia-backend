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
