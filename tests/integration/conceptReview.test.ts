import { describe, expect, it, vi } from "vitest";
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
} from "../helpers";
import { prisma } from "../../src/config/prisma";
import { flushAudit } from "../../src/services/audit/audit.service";
import { documentQueue } from "../../src/queues/documentQueue";

/**
 * Revisión de conceptos (B16, migración 026): confirmar o corregir el monto
 * de la IA (queda quién y cuándo; el valor de la IA se conserva), con
 * ownership; y D6: reprocesar un documento con conceptos revisados exige
 * confirmar "descartar revisiones", auditado.
 */

async function setup(name = "Contador Revisa") {
  const owner = await createAccount(name);
  const client = await createClient(owner.token);
  const doc = await createDocument(client.id, owner.user.id);
  const concept = await prisma.taxConcept.create({
    data: { documentId: doc.id, clientId: client.id, conceptType: "withholding", amount: 1500000, periodYear: 2025 },
  });
  return { owner, client, doc, concept };
}
const review = (a: Account, clientId: string, conceptId: string, body: object) =>
  request(app).patch(`/api/clients/${clientId}/tax-concepts/${conceptId}`).set(authHeader(a.token)).send(body);
const list = (a: Account, clientId: string) =>
  request(app).get(`/api/clients/${clientId}/tax-concepts`).set(authHeader(a.token));

describe("conceptos: estado de revisión", () => {
  it("un concepto recién extraído es de la IA y está sin revisar (el valor de la IA lo pone la base)", async () => {
    const { owner, client, concept } = await setup("Lista Revisión");
    const [item] = (await list(owner, client.id)).body;
    expect(item).toMatchObject({
      id: concept.id,
      amount: "1500000",
      aiAmount: "1500000",
      source: "ai",
      reviewedAt: null,
      reviewer: null,
    });
  });

  it("confirmar el mismo monto: revisado, sigue siendo de la IA; queda quién y cuándo; se audita", async () => {
    const { owner, client, concept } = await setup("Confirma");
    const res = await review(owner, client.id, concept.id, { amount: 1500000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: "ai", amount: "1500000", reviewer: { name: "Confirma" } });
    expect(new Date(res.body.reviewedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    await flushAudit();
    const entry = await prisma.auditLog.findFirst({ where: { action: "tax_concept.review", entityId: concept.id } });
    expect(entry).toMatchObject({ userId: owner.user.id, entity: "tax_concept" });
  });

  it("corregir: el monto cambia, el de la IA se conserva y la fuente pasa a persona", async () => {
    const { owner, client, concept } = await setup("Corrige");
    const res = await review(owner, client.id, concept.id, { amount: 1450000.5 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: "person", amount: "1450000.5", aiAmount: "1500000" });
    // Volver al valor de la IA lo deja otra vez como "de la IA" (revisado).
    expect((await review(owner, client.id, concept.id, { amount: 1500000 })).body.source).toBe("ai");
  });

  it("valida el monto: negativo, más de 2 decimales o texto → 400", async () => {
    const { owner, client, concept } = await setup("Valida Monto");
    for (const amount of [-1, 10.123, "1500000", null]) {
      expect((await review(owner, client.id, concept.id, { amount })).status, String(amount)).toBe(400);
    }
    expect((await review(owner, client.id, concept.id, { amount: 0.1 + 0.2 })).status).toBe(200); // 0,30
  });

  it("las alertas se reevalúan con el monto revisado", async () => {
    const owner = await createAccount("Alertas Revisión");
    const client = await createClient(owner.token);
    const doc = await createDocument(client.id, owner.user.id);
    await prisma.taxConcept.create({
      data: { documentId: doc.id, clientId: client.id, conceptType: "gross_income", amount: 1000, periodYear: 2025 },
    });
    const deduction = await prisma.taxConcept.create({
      data: { documentId: doc.id, clientId: client.id, conceptType: "deduction", amount: 300, periodYear: 2025 },
    });
    const before = await prisma.alert.count({ where: { clientId: client.id } });
    await review(owner, client.id, deduction.id, { amount: 500 }); // 50 % > 40 %
    expect(await prisma.alert.count({ where: { clientId: client.id } })).toBeGreaterThan(before);
  });
});

describe("conceptos: ownership", () => {
  it("otro contador: 404; un concepto de OTRO cliente con este clientId: 404", async () => {
    const a = await setup("Dueño A");
    const b = await setup("Dueño B");
    expect((await review(b.owner, a.client.id, a.concept.id, { amount: 1 })).status).toBe(404);
    expect((await review(a.owner, a.client.id, b.concept.id, { amount: 1 })).status).toBe(404);
    expect((await prisma.taxConcept.findUniqueOrThrow({ where: { id: a.concept.id } })).reviewedAt).toBeNull();
  });

  it("el asistente del contador y el admin pueden; el usuario del portal no (403)", async () => {
    const { owner, client, concept } = await setup("Contador Equipo");
    const assistant = await createAccountWithRole("assistant", { accountantUserId: owner.user.id });
    const portal = await createAccountWithRole("client", { clientId: client.id });
    expect((await review(assistant, client.id, concept.id, { amount: 1 })).status).toBe(200);
    expect((await review(await testAdmin(), client.id, concept.id, { amount: 2 })).status).toBe(200);
    expect((await review(portal, client.id, concept.id, { amount: 3 })).status).toBe(403);
    // El portal sí VE el estado de revisión.
    expect((await list(portal, client.id)).body[0]).toMatchObject({ source: "person", amount: "2" });
  });

  it("ids inválidos: 400", async () => {
    const { owner, client } = await setup("Ids Inválidos");
    expect((await review(owner, client.id, "no-es-uuid", { amount: 1 })).status).toBe(400);
  });
});

describe("D6: reprocesar con conceptos revisados", () => {
  /** Documento terminado con advertencias (se puede reprocesar) y un concepto revisado. */
  async function reviewedDocument() {
    const { owner, client, doc, concept } = await setup("Reprocesa");
    await prisma.document.update({
      where: { id: doc.id },
      data: { status: "processed", errorMessage: "Advertencia de prueba" },
    });
    await review(owner, client.id, concept.id, { amount: 1400000 });
    return { owner, doc };
  }
  const reprocess = (a: Account, docId: string, body?: object) =>
    request(app)
      .post(`/api/documents/${docId}/reprocess`)
      .set(authHeader(a.token))
      .send(body ?? {});

  it("sin confirmar: 409 reviewed_concepts con cuántos; no se encola ni cambia el estado", async () => {
    const { owner, doc } = await reviewedDocument();
    const add = vi.mocked(documentQueue.add);
    add.mockClear();
    const res = await reprocess(owner, doc.id);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "reviewed_concepts", details: { reviewedCount: 1 } });
    expect(res.body.error).toContain("1 concepto revisado");
    expect(add).not.toHaveBeenCalled();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe("processed");
  });

  it("confirmando 'descartar revisiones': se encola con la confirmación y queda auditado", async () => {
    const { owner, doc } = await reviewedDocument();
    const add = vi.mocked(documentQueue.add);
    add.mockClear();
    const res = await reprocess(owner, doc.id, { discardReviews: true });
    expect(res.status).toBe(202);
    expect(add).toHaveBeenCalledWith("process-document", { documentId: doc.id, discardReviews: true });
    await flushAudit();
    expect(
      await prisma.auditLog.count({ where: { action: "document.reprocess.discard_reviews", entityId: doc.id } })
    ).toBe(1);
  });

  it("sin revisiones no pide confirmación ni audita un descarte", async () => {
    const { owner, doc } = await setup("Sin Revisiones");
    await prisma.document.update({ where: { id: doc.id }, data: { status: "error", errorMessage: "x" } });
    expect((await reprocess(owner, doc.id)).status).toBe(202);
    await flushAudit();
    expect(
      await prisma.auditLog.count({ where: { action: "document.reprocess.discard_reviews", entityId: doc.id } })
    ).toBe(0);
  });

  it("discardReviews debe ser booleano", async () => {
    const { owner, doc } = await reviewedDocument();
    expect((await reprocess(owner, doc.id, { discardReviews: "sí" })).status).toBe(400);
  });
});

describe("026: garantías de la base", () => {
  const sql = (q: string, ...p: unknown[]) => prisma.$executeRawUnsafe(q, ...p);
  it("'ai' con otro monto, 'person' sin revisar o revisado sin autor: rechazados", async () => {
    const { concept, owner } = await setup("Base 026");
    await expect(sql(`UPDATE tax_concepts SET amount = amount + 1 WHERE id = $1::uuid`, concept.id)).rejects.toThrow(
      /chk_tax_concepts_ai_amount_kept/
    );
    await expect(
      sql(`UPDATE tax_concepts SET source = 'person', amount = amount + 1 WHERE id = $1::uuid`, concept.id)
    ).rejects.toThrow(/chk_tax_concepts_person_reviewed/);
    await expect(sql(`UPDATE tax_concepts SET reviewed_at = now() WHERE id = $1::uuid`, concept.id)).rejects.toThrow(
      /chk_tax_concepts_review_pair/
    );
    await expect(
      sql(
        `UPDATE tax_concepts SET source = 'person', amount = amount + 1, reviewed_at = now(), reviewed_by = $2::uuid WHERE id = $1::uuid`,
        concept.id,
        owner.user.id
      )
    ).resolves.toBe(1);
  });

  it("un monto negativo reporta el CHECK del monto (no el del valor de la IA)", async () => {
    const { doc, client } = await setup("Negativo 026");
    await expect(
      prisma.taxConcept.create({
        data: { documentId: doc.id, clientId: client.id, conceptType: "deduction", amount: -1, periodYear: 2025 },
      })
    ).rejects.toThrow(/chk_tax_concepts_amount_non_negative/);
  });
});
