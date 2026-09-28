import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { prisma } from "./config/prisma";
import { redisConnection } from "./config/redis";
import { attachRealtime } from "./realtime/wsServer";
import { markShuttingDown } from "./observability/health";
import { flushAudit } from "./services/audit/audit.service";
import { documentQueue } from "./queues/documentQueue";
import { closeHttpServer, createGracefulShutdown } from "./lifecycle/shutdown";

const app = createApp();

async function main() {
  await prisma.$connect();
  logger.info("Conectado a la base de datos.");

  const server = app.listen(env.port, () => {
    logger.info(`Servidor escuchando en http://localhost:${env.port}`);
  });
  // WebSocket de notificaciones en el mismo puerto (ruta /ws).
  const realtime = await attachRealtime(server);

  /**
   * Apagado ordenado (SIGTERM del orquestador, o Ctrl+C = SIGINT en la consola):
   *  1. /ready empieza a responder 503 y se esperan SHUTDOWN_DRAIN_DELAY_MS
   *     para que el balanceador lo vea y deje de enviar tráfico.
   *  2. Se cierran los WebSocket (el navegador reconecta a otra instancia).
   *  3. Se dejan de aceptar conexiones y se esperan las solicitudes en curso.
   *  4. Se escriben los registros de auditoría pendientes y se cierran la
   *     cola, Redis y PostgreSQL.
   * Si algo se cuelga, a los SHUTDOWN_TIMEOUT_MS se fuerza la salida.
   * Nota Windows: cmd.exe no envía SIGTERM; Ctrl+C envía SIGINT (mismo camino).
   */
  const shutdown = createGracefulShutdown(
    [
      { name: "readiness en 503", run: async () => markShuttingDown() },
      {
        name: "drenaje del balanceador",
        run: () => new Promise((resolve) => setTimeout(resolve, env.shutdownDrainDelayMs)),
      },
      { name: "WebSocket", run: () => realtime.close() },
      { name: "servidor HTTP", run: () => closeHttpServer(server) },
      { name: "auditoría pendiente", run: () => flushAudit() },
      { name: "cola", run: () => documentQueue.close() },
      { name: "Redis", run: () => redisConnection.quit() },
      { name: "PostgreSQL", run: () => prisma.$disconnect() },
    ],
    { timeoutMs: env.shutdownTimeoutMs, log: (message, extra) => logger.info(extra ?? {}, message) }
  );
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal(
    { err: err instanceof Error ? { name: err.name, message: err.message } : String(err) },
    "Error al iniciar el servidor"
  );
  process.exit(1);
});
