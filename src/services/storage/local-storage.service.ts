import fs from "fs";
import path from "path";
import { env } from "../../config/env";
import { SaveFileInput, StorageService } from "./storage.interface";

export const localStorageService: StorageService = {
  async save({ buffer, clientId, fileName }: SaveFileInput) {
    const dir = path.join(env.storageLocalPath, "clients", clientId, "documents");
    fs.mkdirSync(dir, { recursive: true });

    const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const fullPath = path.join(dir, safeName);
    fs.writeFileSync(fullPath, buffer);

    // El storageKey es una ruta relativa, portable entre entornos.
    return path.join("clients", clientId, "documents", safeName).replace(/\\/g, "/");
  },

  async readAsBuffer(storageKey: string) {
    const fullPath = path.join(env.storageLocalPath, storageKey);
    return fs.readFileSync(fullPath);
  },
};
