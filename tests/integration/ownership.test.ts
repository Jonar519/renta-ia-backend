import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, createClient, createDocument, FAKE_PDF, registerUser } from "../helpers";
import { prisma } from "../../src/config/prisma";

/**
 * Aislamiento entre contadores: B no puede ver, modificar ni borrar nada
 * de los clientes de A. La respuesta es 404 (no 403) para no revelar que
 * el recurso existe.
 */
describe("Autorización por dueño del cliente", () => {
  let tokenA: string;
  let tokenB: string;
  let userAId: string;
  let clientAId: string;
  let documentAId: string;

  beforeAll(async () => {
    const a = await registerUser("Contador A");
    const b = await registerUser("Contador B");
    tokenA = a.token;
    tokenB = b.token;
    userAId = a.user.id;
    clientAId = (await createClient(tokenA)).id;
    documentAId = (await createDocument(clientAId, userAId)).id;
  });

  it("A sí accede a su propio cliente y documento", async () => {
    expect((await request(app).get(`/api/clients/${clientAId}`).set(authHeader(tokenA))).status).toBe(200);
    expect((await request(app).get(`/api/documents/${documentAId}`).set(authHeader(tokenA))).status).toBe(200);
  });

  it.each([
    ["GET", () => `/api/clients/${clientAId}`],
    ["GET", () => `/api/clients/${clientAId}/tax-concepts`],
    ["GET", () => `/api/documents/client/${clientAId}`],
    ["GET", () => `/api/documents/${documentAId}`],
    ["GET", () => `/api/alerts/client/${clientAId}`],
  ])("B recibe 404 en %s %s", async (_method, path) => {
    const res = await request(app).get(path()).set(authHeader(tokenB));
    expect(res.status).toBe(404);
  });

  it("B no puede modificar el cliente de A", async () => {
    const res = await request(app)
      .patch(`/api/clients/${clientAId}`)
      .set(authHeader(tokenB))
      .send({ fullName: "Modificado por B" });
    expect(res.status).toBe(404);
    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientAId } });
    expect(client.fullName).not.toBe("Modificado por B");
  });

  it("B no puede borrar el cliente de A", async () => {
    const res = await request(app).delete(`/api/clients/${clientAId}`).set(authHeader(tokenB));
    expect(res.status).toBe(404);
    expect(await prisma.client.findUnique({ where: { id: clientAId } })).not.toBeNull();
  });

  it("B no puede preguntarle a la IA sobre el cliente de A", async () => {
    const res = await request(app)
      .post("/api/ai/chat")
      .set(authHeader(tokenB))
      .send({ clientId: clientAId, question: "¿Cuál fue el ingreso bruto?" });
    expect(res.status).toBe(404);
  });

  it("B no puede subir documentos al cliente de A", async () => {
    const res = await request(app)
      .post("/api/documents/upload")
      .set(authHeader(tokenB))
      .field("clientId", clientAId)
      .field("docType", "income_certificate")
      .attach("file", FAKE_PDF, { filename: "certificado.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(404);
  });

  it("PATCH ignora accountantUserId (no permite reasignar el cliente)", async () => {
    const b = await registerUser("Otro contador");
    const res = await request(app)
      .patch(`/api/clients/${clientAId}`)
      .set(authHeader(tokenA))
      .send({ fullName: "Nombre actualizado", accountantUserId: b.user.id });
    expect(res.status).toBe(200);
    expect(res.body.accountantUserId).toBe(userAId);
    expect(res.body.fullName).toBe("Nombre actualizado");
  });
});
