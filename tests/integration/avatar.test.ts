import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { Account, app, authHeader, createAccount } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { env } from "../../src/config/env";
import { storageService } from "../../src/services/storage";
import { storageKeys } from "../../src/services/storage/keys";
import { GPS_LATITUDE, jpegWithGps, pngWithMetadata, REAL_JPEG, REAL_PNG } from "../fixtures/images";

/**
 * Foto de perfil (B12, migración 021): validación por "magic bytes" (la misma
 * tabla que los documentos), límite de tamaño, almacenamiento con
 * StorageService (claves que arma el servidor), y servirla solo a su dueña.
 * Se guarda SIN metadatos; lo que no se puede analizar se rechaza (422).
 */

// Imágenes reales (tests/fixtures/images.ts): PNG de 1×1 y JPEG de Chrome.
const PNG = REAL_PNG;
const JPEG = REAL_JPEG;
const PDF = Buffer.from("%PDF-1.4\n%% no es una imagen\n");

const upload = (a: Account, buffer: Buffer, filename = "foto.png", contentType = "image/png") =>
  request(app)
    .post("/api/users/me/avatar")
    .set(authHeader(a.token))
    .attach("avatar", buffer, { filename, contentType });
const getAvatar = (a: Account) =>
  request(app)
    .get("/api/users/me/avatar")
    .set(authHeader(a.token))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
const onDisk = (key: string) => fs.existsSync(path.join(path.resolve(env.storageLocalPath), key));

describe("subir la foto", () => {
  it("guarda el PNG bajo la carpeta de la cuenta y lo sirve solo con los encabezados seguros", async () => {
    const account = await createAccount("Con Foto");
    const res = await upload(account, PNG);
    expect(res.status).toBe(201);
    expect(res.body.avatarUpdatedAt).toBeTruthy();

    const { avatarKey } = await prisma.user.findUniqueOrThrow({ where: { id: account.user.id } });
    expect(avatarKey).toMatch(new RegExp(`^users/${account.user.id}/avatar/\\d{13}-[0-9a-f]{16}\\.png$`));
    expect(onDisk(avatarKey!)).toBe(true);

    const img = await getAvatar(account);
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
    expect(img.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(Buffer.compare(img.body as Buffer, PNG)).toBe(0);

    const me = await request(app).get("/api/users/me").set(authHeader(account.token));
    expect(me.body.avatarUpdatedAt).toBe(res.body.avatarUpdatedAt);
  });

  it("cambiarla guarda la nueva y borra el archivo anterior", async () => {
    const account = await createAccount("Cambia Foto");
    await upload(account, PNG);
    const first = (await prisma.user.findUniqueOrThrow({ where: { id: account.user.id } })).avatarKey!;
    expect((await upload(account, JPEG, "foto.jpg", "image/jpeg")).status).toBe(201);
    const second = (await prisma.user.findUniqueOrThrow({ where: { id: account.user.id } })).avatarKey!;
    expect(second).not.toBe(first);
    expect(second.endsWith(".jpg")).toBe(true);
    expect(onDisk(first)).toBe(false);
    expect(onDisk(second)).toBe(true);
    expect((await getAvatar(account)).headers["content-type"]).toBe("image/jpeg");
  });

  it("valida el contenido real, no el tipo declarado ni la extensión", async () => {
    const account = await createAccount("Foto Falsa");
    const cases: [Buffer, string, string][] = [
      [PDF, "foto.png", "image/png"], // un PDF disfrazado de PNG
      [PNG, "foto.jpg", "image/jpeg"], // un PNG declarado como JPG
      [PDF, "doc.pdf", "application/pdf"], // los documentos no son fotos
      [Buffer.from("GIF89a"), "foto.gif", "image/gif"],
    ];
    for (const [buffer, filename, type] of cases) {
      const res = await upload(account, buffer, filename, type);
      expect(res.status, `${filename} ${type}`).toBe(415);
    }
    const { avatarKey } = await prisma.user.findUniqueOrThrow({ where: { id: account.user.id } });
    expect(avatarKey).toBeNull();
  });

  it("JPEG con EXIF y ubicación GPS: se guarda y se sirve sin metadatos", async () => {
    const account = await createAccount("Foto Con GPS");
    expect((await upload(account, jpegWithGps(), "foto.jpg", "image/jpeg")).status).toBe(201);
    const { avatarKey } = await prisma.user.findUniqueOrThrow({ where: { id: account.user.id } });
    const stored = await storageService.readAsBuffer(avatarKey!);
    const served = (await getAvatar(account)).body as Buffer;
    const latitude = Buffer.alloc(8);
    latitude.writeUInt32LE(GPS_LATITUDE[0]);
    latitude.writeUInt32LE(1, 4);
    for (const bytes of [stored, served]) {
      expect(bytes.includes(Buffer.from("Exif", "latin1"))).toBe(false);
      expect(bytes.includes(Buffer.from("TelefonoX", "latin1"))).toBe(false);
      expect(bytes.includes(latitude)).toBe(false);
      expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    }
  });

  it("PNG con metadatos (textos, eXIf, tIME, iCCP): se guarda el PNG sin ellos", async () => {
    const account = await createAccount("Foto PNG Metadatos");
    expect((await upload(account, pngWithMetadata())).status).toBe(201);
    expect(Buffer.compare((await getAvatar(account)).body as Buffer, PNG)).toBe(0);
  });

  it("truncada o malformada: 422 y no se guarda nada (ni el original)", async () => {
    const account = await createAccount("Foto Ilegible");
    const dir = path.join(path.resolve(env.storageLocalPath), "users", account.user.id, "avatar");
    const cases: [Buffer, string, string][] = [
      [jpegWithGps().subarray(0, 600), "truncada.jpg", "image/jpeg"],
      [Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(40)]), "mala.jpg", "image/jpeg"],
      [Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]), "firma.jpg", "image/jpeg"],
      [pngWithMetadata().subarray(0, 60), "truncada.png", "image/png"],
    ];
    for (const [buffer, filename, type] of cases) {
      const res = await upload(account, buffer, filename, type);
      expect(res.status, filename).toBe(422);
      expect(res.body.error).toBe("No pudimos leer la foto. Elige otra imagen PNG o JPG.");
    }
    const { avatarKey } = await prisma.user.findUniqueOrThrow({ where: { id: account.user.id } });
    expect(avatarKey).toBeNull();
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it("rechaza más de 512 KB (413) y una subida sin archivo (400)", async () => {
    const account = await createAccount("Foto Grande");
    const big = Buffer.concat([PNG, Buffer.alloc(512 * 1024)]);
    const res = await upload(account, big);
    expect(res.status).toBe(413);
    expect(res.body.error).toContain("512 KB");
    expect((await request(app).post("/api/users/me/avatar").set(authHeader(account.token))).status).toBe(400);
  });
});

describe("quitar la foto y ownership", () => {
  it("quitarla borra el archivo; sin foto, GET y DELETE responden 404", async () => {
    const account = await createAccount("Quita Foto");
    await upload(account, PNG);
    const { avatarKey } = await prisma.user.findUniqueOrThrow({ where: { id: account.user.id } });
    const del = () => request(app).delete("/api/users/me/avatar").set(authHeader(account.token));
    expect((await del()).status).toBe(204);
    expect(onDisk(avatarKey!)).toBe(false);
    expect((await getAvatar(account)).status).toBe(404);
    expect((await del()).status).toBe(404);
  });

  it("no hay forma de pedir la foto de otra cuenta", async () => {
    const owner = await createAccount("Dueña Foto");
    const other = await createAccount("Otra Foto");
    await upload(owner, PNG);
    expect((await getAvatar(other)).status).toBe(404);
    const byId = await request(app).get(`/api/users/${owner.user.id}/avatar`).set(authHeader(other.token));
    expect(byId.status).toBe(404);
    expect((await request(app).get("/api/users/me/avatar")).status).toBe(401);
  });
});

describe("StorageService generalizado", () => {
  it("documentos: la clave conserva su formato de siempre; las claves exigen UUID", () => {
    const clientId = "0b6f1f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(storageKeys.document(clientId, "../../Certificado 2025.pdf")).toMatch(
      new RegExp(`^clients/${clientId}/documents/\\d+-Certificado_2025\\.pdf$`)
    );
    expect(() => storageKeys.document("../otro", "x.pdf")).toThrow(/UUID/);
    expect(() => storageKeys.avatar("no-es-uuid", "image/png")).toThrow(/UUID/);
  });

  it("la implementación local no deja salir de su carpeta (path traversal)", async () => {
    await expect(storageService.readAsBuffer("../../etc/passwd")).rejects.toThrow(/inválida/);
    await expect(storageService.save({ key: "../fuera.txt", buffer: Buffer.from("x") })).rejects.toThrow(/inválida/);
  });
});

describe("021: garantías del esquema", () => {
  const setKey = (userId: string, key: string | null, at: string | null = "now()") =>
    prisma.$executeRawUnsafe(
      `UPDATE users SET avatar_key = $2, avatar_updated_at = ${at} WHERE id = $1::uuid`,
      userId,
      key
    );

  it("la clave debe estar bajo la carpeta de ESA cuenta y con el formato de la API", async () => {
    const owner = await createAccount("Esquema Dueña");
    const other = await createAccount("Esquema Otra");
    const ownersKey = storageKeys.avatar(owner.user.id, "image/png");
    await expect(setKey(other.user.id, ownersKey)).rejects.toThrow(/chk_users_avatar_key_owner/);
    await expect(setKey(owner.user.id, `clients/${owner.user.id}/documents/1-x.pdf`)).rejects.toThrow(
      /chk_users_avatar_key_format/
    );
    await expect(setKey(owner.user.id, ownersKey)).resolves.toBe(1);
  });

  it("clave y fecha van juntas", async () => {
    const { user } = await createAccount("Esquema Par");
    await expect(setKey(user.id, storageKeys.avatar(user.id, "image/jpeg"), "NULL")).rejects.toThrow(
      /chk_users_avatar_pair/
    );
  });
});
