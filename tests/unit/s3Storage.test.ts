import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSafeKey,
  createS3Client,
  createS3StorageService,
  S3Sender,
  StorageKeyExistsError,
} from "../../src/services/storage/s3-storage.service";
import { storageKeys } from "../../src/services/storage/keys";

/**
 * Almacenamiento S3/R2 (ADR 0006). El adaptador se prueba con un doble del cliente:
 * sin red ni credenciales. Lo que se comprueba es lo que manda a S3 y cómo traduce
 * sus respuestas; contra R2 de verdad se verifica en el ensayo de despliegue.
 */
const BUCKET = "renta-ia-pruebas";
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

function fakeS3(handler: (command: unknown) => unknown = () => ({})) {
  const sent: unknown[] = [];
  const client: S3Sender = {
    send: vi.fn(async (command: unknown) => {
      sent.push(command);
      return handler(command);
    }) as unknown as S3Sender["send"],
  };
  return { client, sent };
}

describe("adaptador S3", () => {
  it("save sube el archivo con IfNoneMatch: '*' (nunca sobrescribe) y devuelve la clave", async () => {
    const { client, sent } = fakeS3();
    const storage = createS3StorageService({ bucket: BUCKET, client });
    const key = storageKeys.document(CLIENT_ID, "certificado.pdf");
    const buffer = Buffer.from("%PDF-1.4 prueba");

    await expect(storage.save({ key, buffer })).resolves.toBe(key);

    expect(sent).toHaveLength(1);
    const command = sent[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({ Bucket: BUCKET, Key: key, Body: buffer, IfNoneMatch: "*" });
  });

  it("si la clave ya existe (412 PreconditionFailed) falla en vez de pisar el archivo", async () => {
    const { client } = fakeS3(() => {
      throw Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), {
        name: "PreconditionFailed",
        $metadata: { httpStatusCode: 412 },
      });
    });
    const storage = createS3StorageService({ bucket: BUCKET, client });
    const error = await storage.save({ key: "clients/x/documents/a.pdf", buffer: Buffer.from("x") }).catch((e) => e);
    expect(error).toBeInstanceOf(StorageKeyExistsError);
    expect(error.message).toMatch(/Ya existe un archivo con la clave/);
    expect(error.cause).toMatchObject({ name: "PreconditionFailed" });
  });

  it("también reconoce el 412 cuando el servicio no manda el nombre del error", async () => {
    const { client } = fakeS3(() => {
      throw Object.assign(new Error("Precondition Failed"), { name: "Unknown", $metadata: { httpStatusCode: 412 } });
    });
    const storage = createS3StorageService({ bucket: BUCKET, client });
    await expect(storage.save({ key: "a/b.pdf", buffer: Buffer.from("x") })).rejects.toThrow(/no se sobrescribe/);
  });

  it("otros errores de S3 se propagan tal cual (no se disfrazan de 'ya existe')", async () => {
    const boom = Object.assign(new Error("Access Denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
    const { client } = fakeS3(() => {
      throw boom;
    });
    const storage = createS3StorageService({ bucket: BUCKET, client });
    await expect(storage.save({ key: "a/b.pdf", buffer: Buffer.from("x") })).rejects.toBe(boom);
  });

  it("readAsBuffer pide el objeto y devuelve sus bytes como Buffer", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const { client, sent } = fakeS3(() => ({ Body: { transformToByteArray: async () => bytes } }));
    const storage = createS3StorageService({ bucket: BUCKET, client });

    const buffer = await storage.readAsBuffer("clients/x/documents/a.pdf");

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect([...buffer]).toEqual([...bytes]);
    const command = sent[0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: BUCKET, Key: "clients/x/documents/a.pdf" });
  });

  it("readAsBuffer falla si el objeto no existe (los llamadores ya lo manejan)", async () => {
    const { client } = fakeS3(() => {
      throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
    });
    const storage = createS3StorageService({ bucket: BUCKET, client });
    await expect(storage.readAsBuffer("a/b.pdf")).rejects.toThrow(/does not exist/);
  });

  it("readAsBuffer falla con un mensaje claro si la respuesta llega sin cuerpo", async () => {
    const { client } = fakeS3(() => ({}));
    const storage = createS3StorageService({ bucket: BUCKET, client });
    await expect(storage.readAsBuffer("a/b.pdf")).rejects.toThrow(/sin contenido/);
  });

  it("delete borra el objeto", async () => {
    const { client, sent } = fakeS3();
    const storage = createS3StorageService({ bucket: BUCKET, client });
    await storage.delete("users/x/avatar/1.jpg");
    const command = sent[0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({ Bucket: BUCKET, Key: "users/x/avatar/1.jpg" });
  });

  it("una clave peligrosa se rechaza ANTES de llamar a S3, en las tres operaciones", async () => {
    const { client, sent } = fakeS3();
    const storage = createS3StorageService({ bucket: BUCKET, client });
    for (const key of [
      "../otro-cliente/a.pdf",
      "a/../../b.pdf",
      "/abs/a.pdf",
      "a\\b.pdf",
      "a//b.pdf",
      "./a.pdf",
      "",
      "a/\u0000.pdf",
    ]) {
      await expect(storage.save({ key, buffer: Buffer.from("x") }), key).rejects.toMatchObject({ statusCode: 400 });
      await expect(storage.readAsBuffer(key), key).rejects.toMatchObject({ statusCode: 400 });
      await expect(storage.delete(key), key).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(sent).toHaveLength(0);
  });

  it("las claves que arma storageKeys pasan la validación", () => {
    expect(() => assertSafeKey(storageKeys.document(CLIENT_ID, "Extracto bancario (1).pdf"))).not.toThrow();
    expect(() => assertSafeKey(storageKeys.avatar(CLIENT_ID, "image/png"))).not.toThrow();
  });
});

describe("cliente S3", () => {
  it("con endpoint (R2): estilo de ruta y checksums solo cuando la operación los exige", async () => {
    const client = createS3Client({
      region: "auto",
      endpoint: "https://cuenta.r2.cloudflarestorage.com",
      accessKeyId: "id-de-prueba",
      secretAccessKey: "secreto-de-prueba",
    });
    expect(client.config.forcePathStyle).toBe(true);
    expect(await client.config.requestChecksumCalculation()).toBe("WHEN_REQUIRED");
    expect(await client.config.responseChecksumValidation()).toBe("WHEN_REQUIRED");
    expect(await client.config.region()).toBe("auto");
  });

  it("sin endpoint (AWS): estilo virtual y los valores por defecto del SDK", async () => {
    const client = createS3Client({ region: "us-east-1", accessKeyId: "id", secretAccessKey: "secreto" });
    expect(client.config.forcePathStyle).toBe(false);
    expect(await client.config.requestChecksumCalculation()).toBe("WHEN_SUPPORTED");
  });

  it("usa las credenciales S3_* que recibe, no las AWS_* del entorno (las de SES)", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "clave-de-ses");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secreto-de-ses");
    try {
      const client = createS3Client({
        region: "auto",
        endpoint: "https://r2.example",
        accessKeyId: "id-r2",
        secretAccessKey: "secreto-r2",
      });
      const creds = await client.config.credentials();
      expect(creds).toMatchObject({ accessKeyId: "id-r2", secretAccessKey: "secreto-r2" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("configuración (env.ts) al arrancar", () => {
  const loadEnv = () => import("../../src/config/env");
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("por defecto es 'local' y no exige nada de S3", async () => {
    vi.stubEnv("STORAGE_DRIVER", "");
    vi.resetModules();
    const { env } = await loadEnv();
    expect(env.storageDriver).toBe("local");
    expect(env.s3).toBeUndefined();
  });

  it("un driver desconocido detiene el arranque", async () => {
    vi.stubEnv("STORAGE_DRIVER", "gcs");
    vi.resetModules();
    await expect(loadEnv()).rejects.toThrow(/STORAGE_DRIVER="gcs" no es válido/);
  });

  it("'s3' exige bucket y credenciales propias", async () => {
    for (const missing of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
      vi.stubEnv("STORAGE_DRIVER", "s3");
      vi.stubEnv("S3_BUCKET", "b");
      vi.stubEnv("S3_ACCESS_KEY_ID", "id");
      vi.stubEnv("S3_SECRET_ACCESS_KEY", "secreto");
      vi.stubEnv(missing, "");
      vi.resetModules();
      await expect(loadEnv(), missing).rejects.toThrow(`STORAGE_DRIVER=s3 requiere la variable de entorno ${missing}`);
    }
  });

  it("'s3' con R2: región 'auto' por defecto; sin endpoint, us-east-1", async () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("S3_BUCKET", "renta");
    vi.stubEnv("S3_ACCESS_KEY_ID", "id");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "secreto");
    vi.stubEnv("S3_ENDPOINT", "https://cuenta.r2.cloudflarestorage.com");
    vi.resetModules();
    expect((await loadEnv()).env.s3).toEqual({
      bucket: "renta",
      accessKeyId: "id",
      secretAccessKey: "secreto",
      endpoint: "https://cuenta.r2.cloudflarestorage.com",
      region: "auto",
    });

    vi.stubEnv("S3_ENDPOINT", "");
    vi.resetModules();
    expect((await loadEnv()).env.s3).toMatchObject({ endpoint: undefined, region: "us-east-1" });
  });

  it("S3_ENDPOINT debe ser https y sin ruta", async () => {
    for (const bad of [
      "http://cuenta.r2.cloudflarestorage.com",
      "https://cuenta.r2.cloudflarestorage.com/renta",
      "cuenta.r2",
    ]) {
      vi.stubEnv("STORAGE_DRIVER", "s3");
      vi.stubEnv("S3_BUCKET", "b");
      vi.stubEnv("S3_ACCESS_KEY_ID", "id");
      vi.stubEnv("S3_SECRET_ACCESS_KEY", "secreto");
      vi.stubEnv("S3_ENDPOINT", bad);
      vi.resetModules();
      await expect(loadEnv(), bad).rejects.toThrow(/S3_ENDPOINT=.*debe ser una URL https/);
    }
  });

  it("con STORAGE_DRIVER=s3, services/storage usa el adaptador S3", async () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("S3_BUCKET", "renta");
    vi.stubEnv("S3_ACCESS_KEY_ID", "id");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "secreto");
    vi.stubEnv("S3_ENDPOINT", "https://cuenta.r2.cloudflarestorage.com");
    vi.resetModules();
    const { storageService } = await import("../../src/services/storage");
    const { localStorageService } = await import("../../src/services/storage/local-storage.service");
    expect(storageService).not.toBe(localStorageService);
    // Una clave peligrosa la rechaza el adaptador S3 antes de cualquier llamada de red.
    await expect(storageService.readAsBuffer("../x")).rejects.toMatchObject({ statusCode: 400 });
  });
});
