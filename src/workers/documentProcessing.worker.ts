import { Worker } from "bullmq";
import { redisConnection } from "../config/redis";
import { DocumentProcessingJob } from "../queues/documentQueue";
import { processDocument } from "./processDocument";
import { startScheduledTasks } from "./scheduledTasks";

// Proceso "npm run worker": procesa la cola de documentos y, en el mismo
// proceso, las tareas programadas (alertas de vencimiento diarias).

const worker = new Worker<DocumentProcessingJob>("document-processing", processDocument, {
  connection: redisConnection,
  concurrency: 2,
});

worker.on("completed", (job) => console.log(`[worker] job completado: ${job.id}`));
worker.on("failed", (job, err) => console.error(`[worker] job fallido ${job?.id}:`, err.message));

console.log("Worker de procesamiento de documentos escuchando la cola 'document-processing'...");

startScheduledTasks().catch((err) => {
  console.error("[worker] no se pudieron iniciar las tareas programadas:", err);
  process.exit(1);
});
