import { randomUUID } from "crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  Account,
  app,
  authHeader,
  createAccount,
  createAccountWithRole,
  createClient,
  createDocument,
  testAdmin,
  TEST_PASSWORD,
} from "../helpers";
import { prisma } from "../../src/config/prisma";
import { flushAudit } from "../../src/services/audit/audit.service";

/**
 * Reasignar los clientes de un contador a otro (pantalla Usuarios, solo
 * admin): para que un contador pueda eliminar su cuenta sin borrar el
 * trabajo (docs/data-retention.md).
 */

const reassign = (token: string, body: object) =>
  request(app).post("/api/admin/clients/reassign").set(authHeader(token)).send(body);
const accountants = (token: string) => request(app).get("/api/admin/accountants").set(authHeader(token));

async function clientWithDoc(owner: Account, documentNumber?: string) {
  const res = await request(app)
    .post("/api/clients")
    .set(authHeader(owner.token))
    .send({ fullName: "Cliente Reasignable", documentNumber: documentNumber ?? `CC-${randomUUID().slice(0, 8)}` });
  expect(res.status).toBe(201);
  await createDocument(res.body.id, owner.user.id);
  return res.body as { id: string; documentNumber: string };
}

describe("reasignar clientes", () => {
  it("la lista de contadores dice cuántos clientes tiene cada uno", async () => {
    const admin = await testAdmin();
    const a = await createAccount("Contador Con Dos");
    await createClient(a.token);
    await createClient(a.token);
    const res = await accountants(admin.token);
    expect(res.body.items.find((x: { id: string }) => x.id === a.user.id)).toMatchObject({ clientCount: 2 });
  });

  it("mueve TODOS los clientes (con sus documentos); el anterior deja de verlos y el nuevo sí", async () => {
    const admin = await testAdmin();
    const from = await createAccount("Contador Que Se Va");
    const to = await createAccount("Contador Que Recibe");
    const c1 = await clientWithDoc(from);
    const c2 = await clientWithDoc(from);

    const res = await reassign(admin.token, { fromUserId: from.user.id, toUserId: to.user.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ moved: 2 });
    for (const c of [c1, c2]) {
      expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).accountantUserId).toBe(to.user.id);
      expect((await request(app).get(`/api/clients/${c.id}`).set(authHeader(from.token))).status).toBe(404);
      expect((await request(app).get(`/api/clients/${c.id}`).set(authHeader(to.token))).status).toBe(200);
      // Los documentos van con el cliente y conservan quién los subió.
      const docs = await prisma.document.findMany({ where: { clientId: c.id } });
      expect(docs.map((d) => d.uploadedBy)).toEqual([from.user.id]);
    }
    // Ya puede eliminar su cuenta.
    const status = await request(app).get("/api/users/me/deletion").set(authHeader(from.token));
    expect(status.body.canDelete).toBe(true);
    expect(
      (await request(app).post("/api/users/me/deletion").set(authHeader(from.token)).send({ password: TEST_PASSWORD }))
        .status
    ).toBe(204);

    await flushAudit();
    const entry = await prisma.auditLog.findFirst({
      where: { action: "admin.clients.reassign", entityId: from.user.id },
    });
    expect(entry?.userId).toBe(admin.user.id);
  });

  it("si el destino ya tiene un cliente con el mismo documento: 409 y no se mueve ninguno", async () => {
    const admin = await testAdmin();
    const from = await createAccount("Origen Choque");
    const to = await createAccount("Destino Choque");
    const shared = `CC-${randomUUID().slice(0, 8)}`;
    const clash = await clientWithDoc(from, shared);
    const other = await clientWithDoc(from);
    await clientWithDoc(to, shared);
    const res = await reassign(admin.token, { fromUserId: from.user.id, toUserId: to.user.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(shared);
    for (const c of [clash, other]) {
      expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).accountantUserId).toBe(from.user.id);
    }
  });

  it("validaciones: mismos ids, no uuid, sin clientes, no contadores o eliminados", async () => {
    const admin = await testAdmin();
    const a = await createAccount("Validación A");
    const b = await createAccount("Validación B");
    const assistant = await createAccountWithRole("assistant", { accountantUserId: a.user.id });
    const same = await reassign(admin.token, { fromUserId: a.user.id, toUserId: a.user.id });
    expect(same.status).toBe(400);
    expect(JSON.stringify(same.body)).toContain("Elige dos contadores distintos");
    expect((await reassign(admin.token, { fromUserId: "x", toUserId: b.user.id })).status).toBe(400);
    expect((await reassign(admin.token, { fromUserId: a.user.id, toUserId: b.user.id })).status).toBe(409); // a no tiene clientes
    await createClient(a.token);
    expect((await reassign(admin.token, { fromUserId: a.user.id, toUserId: assistant.user.id })).status).toBe(400);
    expect((await reassign(admin.token, { fromUserId: a.user.id, toUserId: randomUUID() })).status).toBe(400);
    // Un contador eliminado no recibe clientes.
    expect(
      (await request(app).post("/api/users/me/deletion").set(authHeader(b.token)).send({ password: TEST_PASSWORD }))
        .status
    ).toBe(204);
    expect((await reassign(admin.token, { fromUserId: a.user.id, toUserId: b.user.id })).status).toBe(400);
  });

  it("solo admin: un contador recibe 403", async () => {
    const a = await createAccount("Contador Sin Permiso");
    const b = await createAccount("Otro Contador");
    await createClient(a.token);
    expect((await reassign(a.token, { fromUserId: a.user.id, toUserId: b.user.id })).status).toBe(403);
    expect((await accountants(a.token)).status).toBe(403);
  });
});
