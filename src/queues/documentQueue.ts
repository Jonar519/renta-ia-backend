import { Queue } from "bullmq";
import { redisConnection } from "../config/redis";

export interface DocumentProcessingJob {
  documentId: string;
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
