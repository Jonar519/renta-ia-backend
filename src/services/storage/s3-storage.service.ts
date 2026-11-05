import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ApiError } from "../../utils/apiError";
import { SaveFileInput, StorageService } from "./storage.interface";

/**
 * Almacenamiento en un servicio compatible con S3 (Cloudflare R2 en el despliegue; ADR 0006).
 * La API y el worker corren en servicios distintos y no comparten disco: los dos leen y
 * escriben aquí.
 *
 * Mantiene las mismas garantías que el almacenamiento local:
 *  - la clave la arma siempre storageKeys (keys.ts) y aquí se vuelve a validar;
 *  - nunca pisa un objeto existente (IfNoneMatch: "*", el equivalente del flag "wx" local).
 */

/** Lo único que usa el adaptador del cliente: los tests lo reemplazan por un doble, sin red. */
export type S3Sender = Pick<S3Client, "send">;

/**
 * Clave relativa segura: segmentos separados por "/", sin "." ni "..", sin barra
 * inicial ni invertida, y sin caracteres de control. Las claves de storageKeys
 * siempre cumplen esto; es una defensa por si alguna vez llegara otra cosa.
 */
export function assertSafeKey(key: string): void {
  const segments = key.split("/");
  const valid =
    key.length > 0 &&
    key.length <= 1024 &&
    !key.includes("\\") &&
    ![...key].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) &&
    segments.every((s) => s !== "" && s !== "." && s !== "..");
  if (!valid) throw new ApiError(400, "Ruta de almacenamiento inválida");
}

/** La clave ya existe en el bucket: se rechaza en vez de sobrescribir el archivo de otro. */
export class StorageKeyExistsError extends Error {
  readonly cause: unknown;
  constructor(key: string, options: { cause: unknown }) {
    super(`Ya existe un archivo con la clave "${key}": no se sobrescribe.`);
    this.name = "StorageKeyExistsError";
    this.cause = options.cause;
  }
}

function errorName(err: unknown): string | undefined {
  return (err as { name?: string })?.name;
}

function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

export function createS3StorageService(options: { bucket: string; client: S3Sender }): StorageService {
  const { bucket, client } = options;
  return {
    async save({ key, buffer }: SaveFileInput) {
      assertSafeKey(key);
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, IfNoneMatch: "*" }));
      } catch (err) {
        if (errorName(err) === "PreconditionFailed" || httpStatus(err) === 412) {
          throw new StorageKeyExistsError(key, { cause: err });
        }
        throw err;
      }
      return key;
    },

    async readAsBuffer(storageKey: string) {
      assertSafeKey(storageKey);
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
      if (!res.Body) throw new Error(`El objeto "${storageKey}" llegó sin contenido.`);
      return Buffer.from(await res.Body.transformToByteArray());
    },

    async delete(storageKey: string) {
      assertSafeKey(storageKey);
      // En S3 y R2, borrar una clave que no existe no es un error: igual que el local con force.
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
    },
  };
}

/** Cliente real, con las credenciales PROPIAS del almacenamiento (nunca las AWS_* de SES). */
export function createS3Client(config: {
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
}): S3Client {
  const compatible = Boolean(config.endpoint);
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    // R2 y MinIO: rutas del tipo <endpoint>/<bucket>/<clave>.
    forcePathStyle: compatible,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Con un servicio compatible (R2), checksums solo cuando la operación los exige: los
    // checksums por defecto de las versiones nuevas del SDK no los aceptan todos.
    ...(compatible ? { requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" } : {}),
  });
}
