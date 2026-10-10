import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import {
  acceptInvitation,
  app,
  authHeader,
  createAccount,
  createClient,
  createDocument,
  invite,
  testAdmin,
  TEST_PASSWORD,
  unique,
} from "../helpers";
import { prisma } from "../../src/config/prisma";

/** Restricciones de la migración 010_hardening.sql, verificadas contra la base real. */
describe("Migración 010: integridad y normalización", () => {
  let token: string;
  let userId: string;
  let clientId: string;
  let documentId: string;

  beforeAll(async () => {
    const user = await createAccount();
    token = user.token;
    userId = user.user.id;
    clientId = (await createClient(token)).id;
    documentId = (await createDocument(clientId, userId)).id;
  });

  const concept = (overrides: object) =>
    prisma.taxConcept.create({
      data: { documentId, clientId, conceptType: "gross_income", amount: 1000, periodYear: 2025, ...overrides },
    });

  it("CHECK: amount no puede ser negativo", async () => {
    await expect(concept({ amount: -1 })).rejects.toThrow(/chk_tax_concepts_amount_non_negative/);
  });

  it("CHECK: period_year debe estar entre 2000 y 2100", async () => {
    await expect(concept({ periodYear: 1999 })).rejects.toThrow(/chk_tax_concepts_period_year/);
    await expect(concept({ periodYear: 2101 })).rejects.toThrow(/chk_tax_concepts_period_year/);
    await expect(concept({ periodYear: 2000 })).resolves.toBeDefined();
  });

  it("UNIQUE (document_id, chunk_index) en document_embeddings", async () => {
    const vector = `[${new Array(1024).fill(0).join(",")}]`;
    const insert = () => prisma.$executeRaw`
      INSERT INTO document_embeddings (document_id, chunk_index, chunk_text, embedding)
      VALUES (${documentId}::uuid, 0, 'x', ${vector}::vector)`;
    await insert();
    // En SQL crudo Prisma envuelve el error de Postgres (P2010); 23505 = unique_violation.
    await expect(insert()).rejects.toMatchObject({
      code: "P2010",
      meta: { code: "23505", message: expect.stringContaining("(document_id, chunk_index)") },
    });
  });

  it("trigger: updated_at se actualiza al modificar un cliente (incluso con SQL directo)", async () => {
    const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // SQL crudo: prueba el trigger de la base, no el @updatedAt de Prisma.
    await prisma.$executeRaw`UPDATE clients SET phone = '3000000000' WHERE id = ${clientId}::uuid`;
    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it("índice único sobre lower(email): la base rechaza el mismo correo con otras mayúsculas", async () => {
    const email = `case-${unique()}@test.local`;
    await prisma.user.create({ data: { name: "A", email, passwordHash: "x" } });
    await expect(
      prisma.user.create({ data: { name: "B", email: email.toUpperCase(), passwordHash: "x" } })
    ).rejects.toThrow(/uq_users_email_lower|Unique constraint/);
  });

  it("el backend normaliza el correo: invitación, activación y login sin distinguir mayúsculas", async () => {
    const mixed = `Mixto-${unique()}@Test.LOCAL`;
    const invited = await invite({ role: "accountant", name: "Mixto", email: mixed });
    expect(invited.view.email).toBe(mixed.toLowerCase());
    const account = await acceptInvitation(mixed.toLowerCase());
    expect(account.user.email).toBe(mixed.toLowerCase());

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: mixed.toUpperCase(), password: TEST_PASSWORD });
    expect(login.status).toBe(200);

    const admin = await testAdmin();
    const dup = await request(app)
      .post("/api/admin/invitations")
      .set(authHeader(admin.token))
      .send({ name: "Otra", email: mixed.toLowerCase(), role: "accountant" });
    expect(dup.status).toBe(409);
  });

  it("PATCH de un cliente sigue funcionando con el trigger y @updatedAt", async () => {
    const res = await request(app)
      .patch(`/api/clients/${clientId}`)
      .set(authHeader(token))
      .send({ fullName: "Actualizado" });
    expect(res.status).toBe(200);
  });
});

/**
 * Regla de tema (Fase 5): el tema lo decide solo el sistema operativo del
 * usuario (prefers-color-scheme, CSS puro). Ninguna tabla guarda una
 * preferencia de tema; si alguien la agrega, este test lo detecta.
 */
describe("Regla de tema: sin preferencia de tema en la base", () => {
  it("ninguna columna de ninguna tabla se llama *theme*, *tema* ni *color_scheme*", async () => {
    const columns = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (column_name ILIKE '%theme%' OR column_name ILIKE '%tema%' OR column_name ILIKE '%color_scheme%'
             OR column_name ILIKE '%dark_mode%')`;
    expect(columns).toEqual([]);
  });
});
