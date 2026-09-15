import { env } from "../../config/env";
import { localStorageService } from "./local-storage.service";
import { StorageService } from "./storage.interface";

// STORAGE_DRIVER=local por ahora (Fase 3). En la Fase 6 (despliegue en AWS)
// se agrega s3-storage.service.ts implementando la misma interfaz, y aquí
// se selecciona según env.storageDriver. El resto del código (documents.service,
// el worker) nunca importa local-storage.service.ts directamente — siempre
// importa "storageService" desde este archivo.
function resolveStorageService(): StorageService {
  if (env.storageDriver === "local") {
    return localStorageService;
  }
  throw new Error(
    `STORAGE_DRIVER="${env.storageDriver}" todavía no está implementado. Usa "local" por ahora.`
  );
}

export const storageService: StorageService = resolveStorageService();
