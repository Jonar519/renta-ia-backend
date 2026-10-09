import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { storageService } from "../../services/storage";
import { storageKeys, type AvatarMime } from "../../services/storage/keys";
import { ApiError } from "../../utils/apiError";
import { isAllowedAvatar, MAX_AVATAR_BYTES } from "../../utils/fileType";

/**
 * Foto de perfil (Fase 5, B12; migración 021). El archivo va al
 * almacenamiento (StorageService); en users solo su clave y la fecha.
 * Ownership por construcción: siempre la cuenta de la sesión.
 */
const NOT_FOUND = "No tienes foto de perfil.";

/** Borrar el archivo anterior no debe hacer fallar la operación ya hecha. */
async function deleteQuietly(key: string | null) {
  if (!key) return;
  await storageService
    .delete(key)
    .catch((err: unknown) =>
      logger.warn({ err: err instanceof Error ? err.message : err }, "No se pudo borrar un avatar anterior")
    );
}

export const avatarService = {
  async set(userId: string, file: { mimetype: string; buffer: Buffer }) {
    // multer ya limita el tamaño; aquí se repite por si la ruta cambia.
    if (file.buffer.length > MAX_AVATAR_BYTES) throw new ApiError(413, "La foto supera el tamaño máximo (512 KB).");
    if (!isAllowedAvatar(file.mimetype, file.buffer)) {
      throw new ApiError(415, "La foto debe ser una imagen PNG o JPG.");
    }
    const previous = await prisma.user.findUnique({ where: { id: userId }, select: { avatarKey: true } });
    const key = await storageService.save({
      key: storageKeys.avatar(userId, file.mimetype as AvatarMime),
      buffer: file.buffer,
    });
    const avatarUpdatedAt = new Date();
    try {
      await prisma.user.update({ where: { id: userId }, data: { avatarKey: key, avatarUpdatedAt } });
    } catch (err) {
      await deleteQuietly(key); // sin fila que lo apunte, el archivo nuevo sobra
      throw err;
    }
    await deleteQuietly(previous?.avatarKey ?? null);
    return { avatarUpdatedAt };
  },

  async remove(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { avatarKey: true } });
    if (!user?.avatarKey) throw new ApiError(404, NOT_FOUND);
    await prisma.user.update({ where: { id: userId }, data: { avatarKey: null, avatarUpdatedAt: null } });
    await deleteQuietly(user.avatarKey);
  },

  async read(userId: string): Promise<{ buffer: Buffer; contentType: string }> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { avatarKey: true } });
    if (!user?.avatarKey) throw new ApiError(404, NOT_FOUND);
    const buffer = await storageService.readAsBuffer(user.avatarKey).catch(() => {
      throw new ApiError(404, NOT_FOUND);
    });
    return { buffer, contentType: user.avatarKey.endsWith(".png") ? "image/png" : "image/jpeg" };
  },
};
