import path from "path";
import { randomBytes } from "crypto";
import { ApiError } from "../../utils/apiError";
import { isUuid } from "../../utils/uuid";

/**
 * Las claves de almacenamiento se arman SOLO aquí, con ids validados como
 * UUID y nombres saneados: ningún dato del cliente llega tal cual a la ruta.
 * (La implementación local además verifica que la ruta no salga de su carpeta.)
 */
function requireUuid(id: string, what: string) {
  if (!isUuid(id)) throw new ApiError(400, `${what} inválido: debe ser un UUID`);
}

export const AVATAR_EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png" } as const;
export type AvatarMime = keyof typeof AVATAR_EXTENSIONS;

export const storageKeys = {
  /**
   * clients/<clientId>/documents/<timestamp>-<16 hex>-<nombre saneado>. El sufijo aleatorio
   * evita que dos subidas del mismo nombre en el mismo milisegundo compartan archivo (una
   * pisaría o borraría el de la otra). Las claves anteriores, sin sufijo, siguen siendo válidas.
   */
  document(clientId: string, fileName: string): string {
    requireUuid(clientId, "clientId");
    const safeName = `${Date.now()}-${randomBytes(8).toString("hex")}-${path
      .basename(fileName)
      .replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    return ["clients", clientId, "documents", safeName].join("/");
  },

  /**
   * users/<userId>/avatar/<timestamp>-<16 hex>.<jpg|png>. Nombre nuevo en cada
   * cambio (el anterior se borra). La base exige este formato y que el id sea
   * el de la propia cuenta (migración 021).
   */
  avatar(userId: string, mime: AvatarMime): string {
    requireUuid(userId, "userId");
    return [
      "users",
      userId,
      "avatar",
      `${Date.now()}-${randomBytes(8).toString("hex")}.${AVATAR_EXTENSIONS[mime]}`,
    ].join("/");
  },
};
