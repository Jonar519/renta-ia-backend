import http from "http";
import { Worker } from "bullmq";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { redisConnection } from "../config/redis";
import { DocumentProcessingJob } from "../queues/documentQueue";
import { authorizeMetrics, registry, renderMetrics } from "../observability/metrics";
import { processDocument } from "./processDocument";
import { startScheduledTasks } from "./scheduledTasks";
import { createGracefulShutdown } from "../lifecycle/shutdown";

// Proceso "npm run worker": procesa la cola de documentos y, en el mismo
// proceso, las tareas programadas (alertas de vencimiento diarias).

const worker = new Worker<DocumentProcessingJob>("document-processing", processDocument, {
  connection: redisConnection,
  // WORKER_CONCURRENCY: documentos en paralelo por proceso (medido en
  // docs/load-test-report.md). Casi todo el tiempo de un documento es espera
  // de red (LLM, embeddings), así que el paralelismo rinde más que la CPU.
  concurrency: env.workerConcurrency,
});

worker.on("completed", (job) => console.log(`[worker] job completado: ${job.id}`));
worker.on("failed", (job, err) => console.error(`[worker] job fallido ${job?.id}:`, err.message));

console.log(
  `Worker de procesamiento de documentos escuchando la cola 'document-processing' (concurrencia ${env.workerConcurrency})...`
);

let scheduledWorker: Awaited<ReturnType<typeof startScheduledTasks>> | null = null;
startScheduledTasks()
  .then((w) => {
    scheduledWorker = w;
  })
  .catch((err) => {
    console.error("[worker] no se pudieron iniciar las tareas programadas:", err);
    process.exit(1);
  });

// Métricas Prometheus del worker (etapas del pipeline, LLM, proceso), solo
// con METRICS_TOKEN configurado.
const metricsServer = env.metricsToken
  ? http
      .createServer(async (req, res) => {
        const status = req.url === "/metrics" ? authorizeMetrics(req.headers.authorization) : 404;
        if (status !== 200) {
          res.writeHead(status).end();
          return;
        }
        res.writeHead(200, { "Content-Type": registry.contentType }).end(await renderMetrics());
      })
      .listen(env.workerMetricsPort, () =>
        console.log(`[worker] métricas en http://localhost:${env.workerMetricsPort}/metrics`)
      )
  : null;

/**
 * Apagado ordenado (SIGTERM, o Ctrl+C = SIGINT en cmd.exe): worker.close()
 * deja de tomar trabajos y ESPERA a que terminen los que están en curso. Si
 * se supera SHUTDOWN_TIMEOUT_MS se fuerza la salida: BullMQ detecta el
 * trabajo como "stalled" y lo reintenta en otro worker (el pipeline es
 * idempotente: reemplaza conceptos y embeddings del documento).
 */
const shutdown = createGracefulShutdown(
  [
    { name: "trabajos en curso", run: () => Promise.all([worker.close(), scheduledWorker?.close()]) },
    { name: "métricas", run: async () => metricsServer?.close() },
    { name: "Redis", run: () => redisConnection.quit() },
    { name: "PostgreSQL", run: () => prisma.$disconnect() },
  ],
  { timeoutMs: env.shutdownTimeoutMs, log: (message, extra) => console.log(`[worker] ${message}`, extra ?? "") }
);

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
