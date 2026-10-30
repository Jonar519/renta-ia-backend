import fs from "fs";
import path from "path";
import { env } from "../../config/env";
import { ApiError } from "../../utils/apiError";
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
  async save({ key, buffer }: SaveFileInput) {
    // La clave (ruta relativa, portable entre entornos) la arma storageKeys.
    const fullPath = resolveInsideBase(key);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    // "wx": nunca pisa un archivo existente; si una clave se repitiera, falla en vez de
    // sobrescribir en silencio el archivo de otro documento.
    fs.writeFileSync(fullPath, buffer, { flag: "wx" });
    return key;
  },

  async readAsBuffer(storageKey: string) {
    return fs.readFileSync(resolveInsideBase(storageKey));
  },

  async delete(storageKey: string) {
    fs.rmSync(resolveInsideBase(storageKey), { force: true });
  },
};
