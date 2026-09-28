import type { Job } from "bullmq";
import { prisma } from "../config/prisma";
import { storageService } from "../services/storage";
import { textExtractionService } from "../modules/ai/text-extraction.service";
import { extractionService } from "../modules/ai/extraction.service";
import { embeddingsService } from "../modules/ai/embeddings.service";
import { replaceEmbeddings } from "../modules/ai/embeddings.repository";
import { rulesService } from "../modules/ai/rules.service";
import type { DocumentProcessingJob } from "../queues/documentQueue";
import { publishDocumentEvent } from "../services/events/documentEvents";
import { clientAudience } from "../services/access/clientAudience";

/**
 * Pipeline de IA de un documento. Separado del arranque del Worker
 * (documentProcessing.worker.ts) para poder probarlo sin Redis/BullMQ.
 */
export async function processDocument(job: Job<DocumentProcessingJob>) {
  const { documentId } = job.data;
  console.log(`[worker] procesando documento ${documentId} ...`);

  const document = await prisma.document.findUniqueOrThrow({
    where: { id: documentId },
  });
  const audienceUserIds = await clientAudience(document.clientId);
  // Notificación en tiempo real al dueño del cliente (nunca interrumpe el pipeline).
  const notify = (status: "processing" | "processed" | "error", errorMessage: string | null) =>
    publishDocumentEvent({
      documentId,
      clientId: document.clientId,
      audienceUserIds,
      status,
      errorMessage,
    });

  await prisma.document.update({ where: { id: documentId }, data: { status: "processing" } });
  await notify("processing", null);

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
        // Si el documento se reprocesa (reintento de BullMQ o re-subida), los
        // conceptos nuevos REEMPLAZAN a los anteriores de ese documento, en una
        // transacción. Si la extracción no devolvió nada, se conservan los que
        // había (una respuesta vacía o inválida del LLM no borra datos buenos).
        await prisma.$transaction([
          prisma.taxConcept.deleteMany({ where: { documentId: document.id } }),
          prisma.taxConcept.createMany({
            data: concepts.map((c) => ({
              documentId: document.id,
              clientId: document.clientId,
              conceptType: c.conceptType,
              description: c.description,
              amount: c.amount,
              periodYear: c.periodYear,
            })),
          }),
        ]);

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
        if (vectors.length !== chunks.length) {
          throw new Error(`Se recibieron ${vectors.length} vectores para ${chunks.length} fragmentos`);
        }
        // Reemplaza los embeddings anteriores del documento (reprocesamiento).
        await replaceEmbeddings(
          document.id,
          chunks.map((chunkText, i) => ({ chunkText, embedding: vectors[i]! }))
        );
        console.log(`[worker] ${chunks.length} fragmento(s) vectorizado(s)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error desconocido";
      console.error(`[worker] no se pudieron generar embeddings:`, message);
      warnings.push(`Generación de embeddings falló: ${message}`);
    }

    const finalMessage = warnings.length > 0 ? `Procesado con advertencias: ${warnings.join(" | ")}` : null;
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "processed", processedAt: new Date(), errorMessage: finalMessage },
    });
    await notify("processed", finalMessage);

    console.log(
      `[worker] documento ${documentId} procesado${warnings.length > 0 ? " (con advertencias)" : " correctamente"}`
    );
  } catch (err) {
    // Solo llega aquí si falló la extracción de texto (etapa 1), que es
    // la única que de verdad impide seguir procesando el documento.
    // Se marca el documento en "error" y se RE-LANZA el error para que
    // BullMQ registre el job como fallido y lo reintente (attempts: 2); si
    // un reintento funciona, el documento vuelve a pasar a "processed".
    const message = err instanceof Error ? err.message : "Error desconocido";
    console.error(`[worker] error procesando documento ${documentId}:`, message);

    await prisma.document.update({
      where: { id: documentId },
      data: { status: "error", errorMessage: message },
    });
    await notify("error", message);

    throw err;
  }
}
