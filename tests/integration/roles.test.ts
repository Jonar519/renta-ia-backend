import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import {
  app,
  authHeader,
  createAccount,
  createAccountWithRole,
  createClient,
  FAKE_PDF,
  testAdmin,
  unique,
} from "../helpers";
import { prisma } from "../../src/config/prisma";
import { flushAudit } from "../../src/services/audit/audit.service";
import { clientAudience } from "../../src/services/access/clientAudience";

/**
 * Roles (docs/threat-model.md, "Elevación de privilegios"):
 *  - assistant: trabaja sobre los clientes del contador asignado; no crea ni borra clientes.
 *  - client: solo lectura de su propio expediente; no sube, no edita, no usa la IA.
 */

let adminToken: string;
let accountant: Awaited<ReturnType<typeof createAccount>>;
let otherAccountant: Awaited<ReturnType<typeof createAccount>>;
let ownClientId: string;
let foreignClientId: string;
let assistantToken: string;
let assistantId: string;
let portalToken: string;
let portalId: string;

beforeAll(async () => {
  adminToken = (await testAdmin()).token;

  accountant = await createAccount("Contador titular");
  otherAccountant = await createAccount("Contador ajeno");
  ownClientId = (await createClient(accountant.token)).id;
  foreignClientId = (await createClient(otherAccountant.token)).id;

  // Asistente y portal: por invitación; la relación se crea al invitar.
  const assistant = await createAccountWithRole("assistant", {
    name: "Asistente Uno",
    accountantUserId: accountant.user.id,
  });
  assistantId = assistant.user.id;
  assistantToken = assistant.token;

  const portal = await createAccountWithRole("client", { name: "Contribuyente Portal", clientId: ownClientId });
  portalId = portal.user.id;
  portalToken = portal.token;
});

const as = (token: string) => ({
  get: (url: string) => request(app).get(url).set(authHeader(token)),
  post: (url: string, body: object = {}) => request(app).post(url).set(authHeader(token)).send(body),
  patch: (url: string, body: object) => request(app).patch(url).set(authHeader(token)).send(body),
  delete: (url: string) => request(app).delete(url).set(authHeader(token)),
  upload: (clientId: string) =>
    request(app)
      .post("/api/documents/upload")
      .set(authHeader(token))
      .field("clientId", clientId)
      .field("docType", "income_certificate")
      .attach("file", FAKE_PDF, { filename: `cert-${unique()}.pdf`, contentType: "application/pdf" }),
});

describe("Rol assistant", () => {
  it("ve los clientes de su contador y no los de otros", async () => {
    const list = await as(assistantToken).get("/api/clients");
    expect(list.status).toBe(200);
    const ids = list.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(ownClientId);
    expect(ids).not.toContain(foreignClientId);
    expect((await as(assistantToken).get(`/api/clients/${ownClientId}`)).status).toBe(200);
    expect((await as(assistantToken).get(`/api/clients/${foreignClientId}`)).status).toBe(404);
  });

  it("puede editar clientes y subir documentos de su contador", async () => {
    expect((await as(assistantToken).patch(`/api/clients/${ownClientId}`, { phone: "300 123 4567" })).status).toBe(200);
    expect((await as(assistantToken).upload(ownClientId)).status).toBe(201);
    expect((await as(assistantToken).upload(foreignClientId)).status).toBe(404);
  });

  it("no puede borrar ni crear clientes", async () => {
    expect((await as(assistantToken).delete(`/api/clients/${ownClientId}`)).status).toBe(403);
    expect(
      (await as(assistantToken).post("/api/clients", { fullName: "Nuevo", documentNumber: `CC-${unique()}` })).status
    ).toBe(403);
    expect(await prisma.client.count({ where: { id: ownClientId } })).toBe(1);
  });
});

describe("Rol client (portal del contribuyente)", () => {
  it("solo ve su propio expediente", async () => {
    const list = await as(portalToken).get("/api/clients");
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([ownClientId]);
    expect((await as(portalToken).get(`/api/clients/${ownClientId}`)).status).toBe(200);
    expect((await as(portalToken).get(`/api/documents/client/${ownClientId}`)).status).toBe(200);
    expect((await as(portalToken).get(`/api/alerts/client/${ownClientId}`)).status).toBe(200);
    expect((await as(portalToken).get(`/api/clients/${foreignClientId}`)).status).toBe(404);
  });

  it("es de solo lectura: no edita, no borra, no sube, no usa la IA", async () => {
    const client = as(portalToken);
    expect((await client.patch(`/api/clients/${ownClientId}`, { phone: "300 000 0000" })).status).toBe(403);
    expect((await client.delete(`/api/clients/${ownClientId}`)).status).toBe(403);
    expect((await client.post("/api/clients", { fullName: "Otro", documentNumber: `CC-${unique()}` })).status).toBe(
      403
    );
    expect((await client.upload(ownClientId)).status).toBe(403);
    expect((await client.post("/api/ai/chat", { clientId: ownClientId, question: "¿Cuánto debo?" })).status).toBe(403);
    expect((await client.post(`/api/clients/${ownClientId}/summary`)).status).toBe(403);
  });
});

describe("Notificaciones en tiempo real por rol", () => {
  it("la audiencia de un cliente incluye a su contador, sus asistentes y su usuario de portal", async () => {
    const audience = await clientAudience(ownClientId);
    expect(audience.sort()).toEqual([accountant.user.id, assistantId, portalId].sort());
    expect(await clientAudience(foreignClientId)).toEqual([otherAccountant.user.id]);
  });
});

describe("Administración", () => {
  it("solo el admin invita, gestiona invitaciones y consulta la auditoría", async () => {
    const body = {
      name: "Intento",
      email: `intento-${unique()}@test.local`,
      role: "assistant",
      accountantUserId: accountant.user.id,
    };
    for (const token of [accountant.token, assistantToken, portalToken]) {
      expect((await as(token).post("/api/admin/invitations", body)).status).toBe(403);
      expect((await as(token).get("/api/admin/invitations")).status).toBe(403);
      expect((await as(token).delete(`/api/admin/invitations/${assistantId}`)).status).toBe(403);
    }
    expect((await as(assistantToken).get("/api/admin/audit")).status).toBe(403);
    expect((await as(portalToken).get("/api/admin/audit")).status).toBe(403);
  });

  it("valida los vínculos: el asistente debe ligarse a un contador y el expediente a un solo usuario de portal", async () => {
    const notAccountant = await as(adminToken).post("/api/admin/invitations", {
      name: "Mal ligado",
      email: `mal-${unique()}@test.local`,
      role: "assistant",
      accountantUserId: portalId,
    });
    expect(notAccountant.status).toBe(400);
    const duplicatedPortal = await as(adminToken).post("/api/admin/invitations", {
      name: "Segundo portal",
      email: `dup-${unique()}@test.local`,
      role: "client",
      clientId: ownClientId,
    });
    expect(duplicatedPortal.status).toBe(409);
  });

  it("la auditoría registra accesos y cambios, filtrable y paginada", async () => {
    await as(assistantToken).get(`/api/clients/${ownClientId}`);
    await flushAudit();

    const page = await as(adminToken).get(`/api/admin/audit?userId=${assistantId}&limit=2`);
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.nextCursor).toEqual(expect.any(String));
    expect(page.body.items[0]).toMatchObject({ userId: assistantId, user: { id: assistantId, role: "assistant" } });

    const next = await as(adminToken).get(
      `/api/admin/audit?userId=${assistantId}&limit=2&cursor=${page.body.nextCursor}`
    );
    expect(next.status).toBe(200);
    const firstIds = page.body.items.map((r: { id: string }) => r.id);
    for (const row of next.body.items) expect(firstIds).not.toContain(row.id);

    const views = await as(adminToken).get(`/api/admin/audit?action=client.view&entityId=${ownClientId}`);
    expect(views.body.items.length).toBeGreaterThan(0);
    expect(views.body.items.every((r: { action: string }) => r.action === "client.view")).toBe(true);

    const uploads = await as(adminToken).get(`/api/admin/audit?userId=${assistantId}&action=document.upload`);
    expect(uploads.body.items).toHaveLength(1);
  });
});
