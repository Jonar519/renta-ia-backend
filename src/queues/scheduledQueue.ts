import { Queue } from "bullmq";
import { redisConnection } from "../config/redis";

/** Cola de tareas programadas (jobs repetibles de BullMQ). */
export const SCHEDULED_QUEUE_NAME = "scheduled-tasks";

export type ScheduledJobName = "deadline-alerts";

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
