import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { createAccount, createClient, createDocument } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { processDocument } from "../../src/workers/processDocument";
import type { DocumentProcessingJob } from "../../src/queues/documentQueue";
import { textExtractionService } from "../../src/modules/ai/text-extraction.service";
import { extractionService } from "../../src/modules/ai/extraction.service";
import { embeddingsService } from "../../src/modules/ai/embeddings.service";

/**
 * D6 (B16) en el worker: sin la confirmación "descartar revisiones", el
 * worker NO reemplaza conceptos revisados por una persona, tampoco en un
 * reintento automático de BullMQ (que no pasa por la API). Con ella, sí.
 */

vi.mock("../../src/services/storage", () => ({
  storageService: { save: vi.fn(), readAsBuffer: vi.fn().mockResolvedValue(Buffer.from("%PDF-1.4")) },
}));
vi.mock("../../src/modules/ai/text-extraction.service", () => ({
  textExtractionService: { extractText: vi.fn() },
}));
vi.mock("../../src/modules/ai/extraction.service", () => ({
  extractionService: { extractTaxConcepts: vi.fn() },
}));
vi.mock("../../src/modules/ai/embeddings.service", () => ({
  embeddingsService: { chunkText: vi.fn(), embed: vi.fn() },
}));

const job = (documentId: string, discardReviews?: boolean) =>
  ({ data: { documentId, ...(discardReviews !== undefined && { discardReviews }) } }) as Job<DocumentProcessingJob>;

/** Documento con un concepto revisado (corregido a 1.400.000; la IA había leído 1.500.000). */
async function reviewedDocument() {
  const owner = await createAccount("Worker D6");
  const client = await createClient(owner.token);
  const doc = await createDocument(client.id, owner.user.id);
  await prisma.taxConcept.create({
    data: {
      documentId: doc.id,
      clientId: client.id,
      conceptType: "withholding",
      amount: 1400000,
      aiAmount: 1500000,
      source: "person",
      periodYear: 2025,
      reviewedAt: new Date(),
      reviewedBy: owner.user.id,
    },
  });
  return doc;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(textExtractionService.extractText).mockResolvedValue("texto del certificado");
  vi.mocked(embeddingsService.chunkText).mockReturnValue(["fragmento"]);
  vi.mocked(embeddingsService.embed).mockResolvedValue([new Array(1024).fill(0.1)]);
  vi.mocked(extractionService.extractTaxConcepts).mockResolvedValue([
    { conceptType: "withholding", description: "Retención", amount: 1600000, periodYear: 2025 },
  ]);
});

describe("worker y conceptos revisados (D6)", () => {
  it("sin confirmación (p. ej. un reintento automático): conserva lo revisado y lo deja como advertencia", async () => {
    const doc = await reviewedDocument();
    await processDocument(job(doc.id));
    const concepts = await prisma.taxConcept.findMany({ where: { documentId: doc.id } });
    expect(concepts).toHaveLength(1);
    expect(concepts[0]).toMatchObject({ source: "person", reviewedBy: expect.any(String) });
    expect(String(concepts[0]!.amount)).toBe("1400000");
    const updated = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(updated.status).toBe("processed");
    expect(updated.errorMessage).toContain("1 concepto(s) revisado(s): no se reemplazaron");
  });

  it("con la confirmación: reemplaza por lo que extrae la IA, sin revisar", async () => {
    const doc = await reviewedDocument();
    await processDocument(job(doc.id, true));
    const concepts = await prisma.taxConcept.findMany({ where: { documentId: doc.id } });
    expect(concepts).toHaveLength(1);
    expect(concepts[0]).toMatchObject({ source: "ai", reviewedAt: null, reviewedBy: null });
    expect(String(concepts[0]!.amount)).toBe("1600000");
    expect(String(concepts[0]!.aiAmount)).toBe("1600000");
  });

  it("sin conceptos revisados, reemplaza como siempre (no hace falta confirmar)", async () => {
    const owner = await createAccount("Worker Sin Revisar");
    const client = await createClient(owner.token);
    const doc = await createDocument(client.id, owner.user.id);
    await prisma.taxConcept.create({
      data: { documentId: doc.id, clientId: client.id, conceptType: "withholding", amount: 1, periodYear: 2025 },
    });
    await processDocument(job(doc.id));
    const concepts = await prisma.taxConcept.findMany({ where: { documentId: doc.id } });
    expect(concepts.map((c) => String(c.amount))).toEqual(["1600000"]);
  });
});
