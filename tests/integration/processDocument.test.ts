import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { createClient, createDocument, registerUser } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { processDocument } from "../../src/workers/processDocument";
import type { DocumentProcessingJob } from "../../src/queues/documentQueue";
import { DocumentEvent, documentEventBus } from "../../src/services/events/documentEvents";
import { textExtractionService } from "../../src/modules/ai/text-extraction.service";
import { extractionService } from "../../src/modules/ai/extraction.service";
import { embeddingsService } from "../../src/modules/ai/embeddings.service";

// Servicios externos mockeados: almacenamiento, OCR, LLM y embeddings.
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

const extractText = vi.mocked(textExtractionService.extractText);
const extractTaxConcepts = vi.mocked(extractionService.extractTaxConcepts);
const chunkText = vi.mocked(embeddingsService.chunkText);
const embed = vi.mocked(embeddingsService.embed);

const jobFor = (documentId: string) => ({ data: { documentId } }) as Job<DocumentProcessingJob>;

describe("Worker processDocument", () => {
  let clientId: string;
  let userId: string;

  beforeAll(async () => {
    const user = await registerUser();
    userId = user.user.id;
    clientId = (await createClient(user.token)).id;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    chunkText.mockReturnValue(["fragmento 1", "fragmento 2"]);
    embed.mockResolvedValue([new Array(1024).fill(0.1), new Array(1024).fill(0.2)]);
  });

  it("si falla la extracción de texto, el job falla (BullMQ reintenta) y el documento queda en error", async () => {
    const doc = await createDocument(clientId, userId);
    extractText.mockRejectedValue(new Error("El PDF no tiene texto extraíble"));

    await expect(processDocument(jobFor(doc.id))).rejects.toThrow("El PDF no tiene texto extraíble");

    const updated = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(updated.status).toBe("error");
    expect(updated.errorMessage).toBe("El PDF no tiene texto extraíble");
    expect(extractTaxConcepts).not.toHaveBeenCalled();
  });

  it("si falla solo el LLM, el documento queda processed con advertencias y los embeddings se guardan", async () => {
    const doc = await createDocument(clientId, userId);
    extractText.mockResolvedValue("Certificado de ingresos y retenciones 2025 ...");
    extractTaxConcepts.mockRejectedValue(new Error("Sin crédito en la API de Anthropic"));

    await expect(processDocument(jobFor(doc.id))).resolves.toBeUndefined();

    const updated = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(updated.status).toBe("processed");
    expect(updated.errorMessage).toMatch(
      /^Procesado con advertencias: Extracción de conceptos tributarios falló: Sin crédito/
    );
    expect(await prisma.documentEmbedding.count({ where: { documentId: doc.id } })).toBe(2);
  });

  it("si fallan solo los embeddings, los conceptos se guardan y el documento queda processed con advertencias", async () => {
    const doc = await createDocument(clientId, userId);
    extractText.mockResolvedValue("texto");
    extractTaxConcepts.mockResolvedValue([
      { conceptType: "gross_income", description: "Salario", amount: 1000, periodYear: 2025 },
    ]);
    embed.mockRejectedValue(new Error("Voyage no disponible"));

    await processDocument(jobFor(doc.id));

    const updated = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(updated.status).toBe("processed");
    expect(updated.errorMessage).toMatch(/Generación de embeddings falló: Voyage no disponible/);
    expect(await prisma.taxConcept.count({ where: { documentId: doc.id } })).toBe(1);
  });

  it("caso feliz: conceptos y embeddings guardados, sin advertencias", async () => {
    const doc = await createDocument(clientId, userId);
    extractText.mockResolvedValue("texto");
    extractTaxConcepts.mockResolvedValue([
      { conceptType: "gross_income", description: "Salario", amount: 1000, periodYear: 2025 },
      { conceptType: "withholding", description: "Retención", amount: 100, periodYear: 2025 },
    ]);

    await processDocument(jobFor(doc.id));

    const updated = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(updated.status).toBe("processed");
    expect(updated.errorMessage).toBeNull();
    expect(updated.processedAt).not.toBeNull();
    expect(await prisma.taxConcept.count({ where: { documentId: doc.id } })).toBe(2);
    expect(await prisma.documentEmbedding.count({ where: { documentId: doc.id } })).toBe(2);
  });
});

describe("Worker processDocument: reprocesamiento", () => {
  let clientId: string;
  let userId: string;

  beforeAll(async () => {
    const user = await registerUser();
    userId = user.user.id;
    clientId = (await createClient(user.token)).id;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    extractText.mockResolvedValue("texto");
    chunkText.mockReturnValue(["fragmento 1", "fragmento 2"]);
    embed.mockResolvedValue([new Array(1024).fill(0.1), new Array(1024).fill(0.2)]);
  });

  it("procesar dos veces el mismo documento no duplica conceptos ni embeddings", async () => {
    const doc = await createDocument(clientId, userId);
    extractTaxConcepts.mockResolvedValue([
      { conceptType: "gross_income", description: "Salario", amount: 1000, periodYear: 2025 },
      { conceptType: "withholding", description: "Retención", amount: 100, periodYear: 2025 },
    ]);

    await processDocument(jobFor(doc.id));
    await processDocument(jobFor(doc.id));

    expect(await prisma.taxConcept.count({ where: { documentId: doc.id } })).toBe(2);
    expect(await prisma.documentEmbedding.count({ where: { documentId: doc.id } })).toBe(2);
  });

  it("al reprocesar, los conceptos nuevos reemplazan a los anteriores", async () => {
    const doc = await createDocument(clientId, userId);
    extractTaxConcepts.mockResolvedValueOnce([
      { conceptType: "gross_income", description: "Primera lectura", amount: 1000, periodYear: 2025 },
    ]);
    await processDocument(jobFor(doc.id));
    extractTaxConcepts.mockResolvedValueOnce([
      { conceptType: "gross_income", description: "Segunda lectura", amount: 2000, periodYear: 2025 },
    ]);
    await processDocument(jobFor(doc.id));

    const concepts = await prisma.taxConcept.findMany({ where: { documentId: doc.id } });
    expect(concepts.map((c) => c.description)).toEqual(["Segunda lectura"]);
  });

  it("si al reprocesar el LLM no devuelve conceptos, se conservan los anteriores", async () => {
    const doc = await createDocument(clientId, userId);
    extractTaxConcepts.mockResolvedValueOnce([
      { conceptType: "gross_income", description: "Buena", amount: 1000, periodYear: 2025 },
    ]);
    await processDocument(jobFor(doc.id));
    extractTaxConcepts.mockResolvedValueOnce([]);
    await processDocument(jobFor(doc.id));

    expect(await prisma.taxConcept.count({ where: { documentId: doc.id } })).toBe(1);
  });
});

describe("Worker processDocument: notificaciones en tiempo real", () => {
  it("publica processing y luego processed (con advertencias) al dueño del cliente", async () => {
    const user = await registerUser();
    const clientId = (await createClient(user.token)).id;
    const doc = await createDocument(clientId, user.user.id);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    extractText.mockResolvedValue("texto");
    extractTaxConcepts.mockRejectedValue(new Error("sin crédito"));
    chunkText.mockReturnValue(["a"]);
    embed.mockResolvedValue([new Array(1024).fill(0.1)]);

    const events: DocumentEvent[] = [];
    const unsubscribe = await documentEventBus.subscribe((e) => events.push(e));
    await processDocument(jobFor(doc.id));
    await unsubscribe();

    expect(events.map((e) => e.status)).toEqual(["processing", "processed"]);
    expect(events[1]).toMatchObject({ clientId, audienceUserIds: [user.user.id], documentId: doc.id });
    expect(events[1]!.errorMessage).toMatch(/Procesado con advertencias/);
  });

  it("publica error cuando falla la extracción de texto", async () => {
    const user = await registerUser();
    const doc = await createDocument((await createClient(user.token)).id, user.user.id);
    vi.spyOn(console, "error").mockImplementation(() => {});
    extractText.mockRejectedValue(new Error("PDF escaneado"));

    const events: DocumentEvent[] = [];
    const unsubscribe = await documentEventBus.subscribe((e) => events.push(e));
    await expect(processDocument(jobFor(doc.id))).rejects.toThrow();
    await unsubscribe();
    expect(events.map((e) => e.status)).toEqual(["processing", "error"]);
  });
});
