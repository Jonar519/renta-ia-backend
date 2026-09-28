import { Queue } from "bullmq";
import { redisConnection } from "../config/redis";

/** Cola de tareas programadas (jobs repetibles de BullMQ). */
export const SCHEDULED_QUEUE_NAME = "scheduled-tasks";

export type ScheduledJobName = "deadline-alerts" | "web-vitals-retention";

export const scheduledQueue = new Queue(SCHEDULED_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: 30,
    removeOnFail: 100,
  },
});

/** Todos los días a las 06:00 (hora de Colombia). */
export const DEADLINE_ALERTS_CRON = "0 6 * * *";

/** Todos los días a las 03:30: borra métricas de rendimiento de más de 90 días. */
export const WEB_VITALS_RETENTION_CRON = "30 3 * * *";
