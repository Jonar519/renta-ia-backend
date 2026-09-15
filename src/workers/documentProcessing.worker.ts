import { Worker, Job } from "bullmq";
import { redisConnection } from "../config/redis";
import { prisma } from "../config/prisma";
import { storageService } from "../services/storage";
import { textExtractionService } from "../modules/ai/text-extraction.service";
import { extractionService } from "../modules/ai/extraction.service";
import { embeddingsService } from "../modules/ai/embeddings.service";
import { saveEmbedding } from "../modules/ai/embeddings.repository";
import { rulesService } from "../modules/ai/rules.service";
import { DocumentProcessingJob } from "../queues/documentQueue";

async function processDocument(job: Job<DocumentProcessingJob>) {
  const { documentId } = job.data;
  console.log(`[worker] procesando documento ${documentId} ...`);

  const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  await prisma.document.update({ where: { id: documentId }, data: { status: "processing" } });

  const warnings: string[] = [];

  try {
    // 1. Extraer texto (PDF con texto embebido, o imagen vía OCR).
    // Si esto falla, no hay nada más que hacer con el documento: se detiene aquí.
    const buffer = await storageService.readAsBuffer(document.storageKey);
    const text = await textExtractionService.extractText(buffer, document.originalName);

    // 2. Extraer conceptos tributarios estructurados con el LLM.
    // Etapa independiente: si falla (ej. sin crédito en la API), se guarda
    // como advertencia y el pipeline continúa con las demás etapas.
    try {
      const concepts = await extractionService.extractTaxConcepts(text);
      console.log(`[worker] ${concepts.length} concepto(s) tributario(s) extraído(s)`);

      if (concepts.length > 0) {
        await prisma.taxConcept.createMany({
          data: concepts.map((c) => ({
            documentId: document.id,
            clientId: document.clientId,
            conceptType: c.conceptType,
            description: c.description,
            amount: c.amount,
            periodYear: c.periodYear,
          })),
        });

        // 4. Motor de reglas: solo tiene sentido si hubo conceptos extraídos.
        await rulesService.evaluateClientConcepts(document.clientId, document.id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error desconocido";
      console.error(`[worker] no se pudo extraer conceptos tributarios:`, message);
      warnings.push(`Extracción de conceptos tributarios falló: ${message}`);
    }

    // 3. Generar embeddings del texto para búsqueda semántica (RAG).
    // Etapa independiente: si falla, se guarda como advertencia y no bloquea
    // el resto (ni tumba lo que ya se guardó en las etapas anteriores).
    try {
      const chunks = embeddingsService.chunkText(text);
      if (chunks.length > 0) {
        const vectors = await embeddingsService.embed(chunks);
        for (let i = 0; i < chunks.length; i++) {
          await saveEmbedding(document.id, i, chunks[i], vectors[i]);
        }
        console.log(`[worker] ${chunks.length} fragmento(s) vectorizado(s)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error desconocido";
      console.error(`[worker] no se pudieron generar embeddings:`, message);
      warnings.push(`Generación de embeddings falló: ${message}`);
    }

    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: "processed",
        processedAt: new Date(),
        errorMessage: warnings.length > 0 ? `Procesado con advertencias: ${warnings.join(" | ")}` : null,
      },
    });

    console.log(`[worker] documento ${documentId} procesado${warnings.length > 0 ? " (con advertencias)" : " correctamente"}`);
  } catch (err) {
    // Solo llega aquí si falló la extracción de texto (etapa 1), que es
    // la única que de verdad impide seguir procesando el documento.
    const message = err instanceof Error ? err.message : "Error desconocido";
    console.error(`[worker] error procesando documento ${documentId}:`, message);

    await prisma.document.update({
      where: { id: documentId },
      data: { status: "error", errorMessage: message },
    });
  }
}

const worker = new Worker<DocumentProcessingJob>("document-processing", processDocument, {
  connection: redisConnection,
  concurrency: 2,
});

worker.on("completed", (job) => console.log(`[worker] job completado: ${job.id}`));
worker.on("failed", (job, err) => console.error(`[worker] job fallido ${job?.id}:`, err.message));

console.log("Worker de procesamiento de documentos escuchando la cola 'document-processing'...");