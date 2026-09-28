import { Job, Worker } from "bullmq";
import { redisConnection } from "../config/redis";
import { logger } from "../config/logger";
import { taxCalendar } from "../config/taxConfig";
import { runDeadlineCheck } from "../modules/alerts/deadlines.service";
import { metricsService } from "../modules/metrics/metrics.service";
import {
  DEADLINE_ALERTS_CRON,
  SCHEDULED_QUEUE_NAME,
  ScheduledJobName,
  WEB_VITALS_RETENTION_CRON,
  scheduledQueue,
} from "../queues/scheduledQueue";

async function processScheduledJob(job: Job<unknown, unknown, ScheduledJobName>): Promise<unknown> {
  switch (job.name) {
    case "deadline-alerts":
      return runDeadlineCheck();
    case "web-vitals-retention":
      return { deleted: await metricsService.purgeOld() };
    default:
      throw new Error(`Tarea programada desconocida: ${job.name}`);
  }
}

/**
 * Registra el job repetible (idempotente: upsertJobScheduler no duplica el
 * programador aunque el worker se reinicie) y arranca el worker que lo procesa.
 */
export async function startScheduledTasks(): Promise<Worker<unknown, unknown, ScheduledJobName>> {
  await scheduledQueue.upsertJobScheduler(
    "deadline-alerts-daily",
    { pattern: DEADLINE_ALERTS_CRON, tz: taxCalendar.zonaHoraria },
    { name: "deadline-alerts" }
  );
  await scheduledQueue.upsertJobScheduler(
    "web-vitals-retention-daily",
    { pattern: WEB_VITALS_RETENTION_CRON, tz: taxCalendar.zonaHoraria },
    { name: "web-vitals-retention" }
  );

  const worker = new Worker(SCHEDULED_QUEUE_NAME, processScheduledJob, { connection: redisConnection, concurrency: 1 });
  worker.on("completed", (job, result) => logger.info({ job: job.name, result }, "Tarea programada completada"));
  worker.on("failed", (job, err) => logger.error({ job: job?.name, err: err.message }, "Tarea programada fallida"));
  logger.info(`Tareas programadas: vencimientos todos los días (${DEADLINE_ALERTS_CRON}, ${taxCalendar.zonaHoraria}).`);
  return worker;
}
