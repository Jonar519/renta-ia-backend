import fs from "fs";
import path from "path";
import { env } from "../../config/env";
import { ApiError } from "../../utils/apiError";
import { isUuid } from "../../utils/uuid";
import { SaveFileInput, StorageService } from "./storage.interface";

/**
 * Resuelve `relativeKey` dentro de la carpeta base y confirma que el
 * resultado no se escape de ella (defensa contra path traversal, p. ej.
 * un storageKey con "../").
 */
function resolveInsideBase(relativeKey: string): string {
  const baseDir = path.resolve(env.storageLocalPath);
  const fullPath = path.resolve(baseDir, relativeKey);
  if (fullPath !== baseDir && !fullPath.startsWith(baseDir + path.sep)) {
    throw new ApiError(400, "Ruta de almacenamiento inválida");
  }
  return fullPath;
}

export const localStorageService: StorageService = {
  async save({ buffer, clientId, fileName }: SaveFileInput) {
    if (!isUuid(clientId)) {
      throw new ApiError(400, "clientId inválido: debe ser un UUID");
    }

    const safeName = `${Date.now()}-${path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    // El storageKey es una ruta relativa, portable entre entornos.
    const storageKey = ["clients", clientId, "documents", safeName].join("/");

    const fullPath = resolveInsideBase(storageKey);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, buffer);

    return storageKey;
  },

  async readAsBuffer(storageKey: string) {
    return fs.readFileSync(resolveInsideBase(storageKey));
  },
};
