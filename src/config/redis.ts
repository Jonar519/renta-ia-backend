import IORedis from "ioredis";
import { env } from "./env";

// maxRetriesPerRequest: null es requerido por BullMQ para conexiones
// usadas por Worker/QueueEvents (ver documentación de BullMQ).
export const redisConnection = new IORedis(env.redisUrl, {
  maxRetriesPerRequest: null,
});
