import { Queue } from "bullmq";
import { redisConnection } from "../config/redis";

export interface DocumentProcessingJob {
  documentId: string;
  /**
   * D6 (B16): la persona confirmó "descartar revisiones" al reprocesar. Sin
   * esto, el worker NO reemplaza conceptos ya revisados (tampoco en un
   * reintento automático de BullMQ).
   */
  discardReviews?: boolean;
}

export const documentQueue = new Queue<DocumentProcessingJob>("document-processing", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});
