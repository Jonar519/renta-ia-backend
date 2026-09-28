import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, createClient, registerUser } from "../helpers";
import { prisma } from "../../src/config/prisma";

const pdf = fs.readFileSync(path.join(__dirname, "../fixtures/certificado-pequeno.pdf"));
const sha256 = createHash("sha256").update(pdf).digest("hex");
/** Mismo PDF con un byte distinto al final (otro archivo, otra huella). */
const otherPdf = Buffer.concat([pdf, Buffer.from("\n%otro\n")]);

describe("Documentos duplicados (SHA-256 por cliente)", () => {
  let token: string;
  let clientId: string;

  beforeAll(async () => {
    token = (await registerUser()).token;
    clientId = (await createClient(token)).id;
  });

  const upload = (file: Buffer, fields: Record<string, string> = {}, id = clientId) => {
    const req = request(app)
      .post("/api/documents/upload")
      .set(authHeader(token))
      .field("clientId", id)
      .field("docType", "income_certificate");
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    return req.attach("file", file, { filename: "certificado.pdf", contentType: "application/pdf" });
  };

  it("guarda la huella calculada por el backend", async () => {
    const res = await upload(pdf);
    expect(res.status).toBe(201);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(doc.sha256).toBe(sha256);
  });

  it("rechaza con 409 el mismo archivo para el mismo cliente e indica cuál es el original", async () => {
    const res = await upload(pdf);
    expect(res.status).toBe(409);
    expect(res.body.details.duplicateOf).toMatchObject({ originalName: "certificado.pdf" });
  });

  it("el mismo archivo SÍ se puede subir para otro cliente", async () => {
    const other = await createClient(token);
    expect((await upload(pdf, {}, other.id)).status).toBe(201);
  });

  it("rechaza (400) si la huella que envía el navegador no coincide con los bytes recibidos", async () => {
    const res = await upload(otherPdf, { sha256 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/huella SHA-256 es distinta/);
  });

  it("valida el formato de la huella", async () => {
    expect((await upload(otherPdf, { sha256: "ABC" })).status).toBe(400);
  });

  it("GET by-hash permite consultar antes de subir, con verificación de dueño", async () => {
    const found = await request(app).get(`/api/documents/client/${clientId}/by-hash/${sha256}`).set(authHeader(token));
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ exists: true, document: { originalName: "certificado.pdf" } });

    const missing = createHash("sha256").update("nada").digest("hex");
    const notFound = await request(app)
      .get(`/api/documents/client/${clientId}/by-hash/${missing}`)
      .set(authHeader(token));
    expect(notFound.body).toEqual({ exists: false, document: null });

    const intruder = await registerUser();
    const res = await request(app)
      .get(`/api/documents/client/${clientId}/by-hash/${sha256}`)
      .set(authHeader(intruder.token));
    expect(res.status).toBe(404);
  });

  it("dos subidas simultáneas del mismo archivo nuevo: una 201 y una 409, sin archivos huérfanos", async () => {
    const fresh = Buffer.concat([pdf, Buffer.from(`\n%${Date.now()}\n`)]);
    const results = await Promise.all([upload(fresh), upload(fresh)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);

    const freshHash = createHash("sha256").update(fresh).digest("hex");
    expect(await prisma.document.count({ where: { clientId, sha256: freshHash } })).toBe(1);
    const dir = path.join(process.env.STORAGE_LOCAL_PATH!, "clients", clientId, "documents");
    const stored = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f)));
    expect(stored.filter((b) => b.equals(fresh))).toHaveLength(1);
  });
});
