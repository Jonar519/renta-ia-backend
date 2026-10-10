import { randomBytes } from "crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { Account, app, authHeader, createAccount, createAccountWithRole, createClient, testAdmin } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { flushAudit } from "../../src/services/audit/audit.service";
import { storageService } from "../../src/services/storage";
import { REAL_PNG } from "../fixtures/images";

/**
 * El archivo original de un documento (B17, vista dividida): ownership (el
 * mismo alcance que ver el documento), el tipo REAL por su firma y
 * encabezados que impiden ejecutar nada si se abre la URL directamente.
 */

// PDF único por prueba (la subida rechaza duplicados del mismo cliente).
const pdf = () => Buffer.from(`%PDF-1.4\n% documento ${randomBytes(8).toString("hex")}\n%%EOF\n`);

async function uploaded(
  owner: Account,
  file = pdf(),
  filename = "certificado ingresos 2025.pdf",
  type = "application/pdf"
) {
  const client = await createClient(owner.token);
  const res = await request(app)
    .post("/api/documents/upload")
    .set(authHeader(owner.token))
    .field("clientId", client.id)
    .field("docType", "income_certificate")
    .attach("file", file, { filename, contentType: type });
  expect(res.status).toBe(201);
  return { client, docId: res.body.id as string, file };
}
const getFile = (a: Account, id: string) =>
  request(app)
    .get(`/api/documents/${id}/file`)
    .set(authHeader(a.token))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });

describe("archivo original de un documento", () => {
  it("lo sirve tal cual, con su tipo real y encabezados seguros; se audita", async () => {
    const owner = await createAccount("Dueño Archivo");
    const { docId, file } = await uploaded(owner);
    const res = await getFile(owner, docId);
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, file)).toBe(0);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["content-disposition"]).toBe("inline; filename*=UTF-8''certificado%20ingresos%202025.pdf");
    await flushAudit();
    expect(await prisma.auditLog.count({ where: { action: "document.file.view", entityId: docId } })).toBe(1);
  });

  it("el tipo sale del contenido guardado, no del nombre", async () => {
    const owner = await createAccount("Tipo Real");
    const { docId } = await uploaded(owner, REAL_PNG, "foto-del-certificado.png", "image/png");
    // Aunque alguien cambiara el nombre en la base, el tipo sigue siendo el real.
    await prisma.document.update({ where: { id: docId }, data: { originalName: "engaño.pdf" } });
    expect((await getFile(owner, docId)).headers["content-type"]).toBe("image/png");
  });

  it("ownership: otro contador 404; asistente del contador, portal del cliente y admin sí", async () => {
    const owner = await createAccount("Contador Archivo");
    const { client, docId } = await uploaded(owner);
    const other = await createAccount("Otro Contador Archivo");
    const assistant = await createAccountWithRole("assistant", { accountantUserId: owner.user.id });
    const portal = await createAccountWithRole("client", { clientId: client.id });
    expect((await getFile(other, docId)).status).toBe(404);
    expect((await getFile(assistant, docId)).status).toBe(200);
    expect((await getFile(portal, docId)).status).toBe(200);
    expect((await getFile(await testAdmin(), docId)).status).toBe(200);
    expect((await request(app).get(`/api/documents/${docId}/file`)).status).toBe(401);
  });

  it("id inválido 400; inexistente 404; archivo perdido 404; contenido no admitido 422", async () => {
    const owner = await createAccount("Archivo Casos");
    expect((await getFile(owner, "no-es-uuid")).status).toBe(400);
    expect((await getFile(owner, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const { docId } = await uploaded(owner);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: docId } });
    await storageService.delete(doc.storageKey);
    const lost = await getFile(owner, docId);
    expect(lost.status).toBe(404);
    expect(JSON.stringify(lost.body)).toBeTruthy();
    // Si el contenido guardado no es PDF/PNG/JPG (no debería pasar), no se sirve.
    await storageService.save({ key: doc.storageKey, buffer: Buffer.from("<script>alert(1)</script>") });
    expect((await getFile(owner, docId)).status).toBe(422);
  });
});
