import { env } from "../../config/env";
import { localStorageService } from "./local-storage.service";
import { createS3Client, createS3StorageService } from "./s3-storage.service";
import { StorageService } from "./storage.interface";

// STORAGE_DRIVER (validado en env.ts al arrancar):
//  - "local": disco (desarrollo, tests y un solo servidor);
//  - "s3": servicio compatible con S3 (Cloudflare R2 en el despliegue), que la API y el
//    worker comparten aunque corran en máquinas distintas.
// El resto del código (documents.service, el worker) nunca importa una implementación
// directamente: siempre importa "storageService" desde este archivo (ADR 0006).
function resolveStorageService(): StorageService {
  if (env.storageDriver === "s3") {
    const s3 = env.s3!;
    return createS3StorageService({
      bucket: s3.bucket,
      client: createS3Client({
        region: s3.region,
        endpoint: s3.endpoint,
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      }),
    });
  }
  return localStorageService;
}

export const storageService: StorageService = resolveStorageService();
