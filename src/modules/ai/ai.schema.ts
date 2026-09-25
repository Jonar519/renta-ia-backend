import { z } from "zod";
import { uuidSchema } from "../../utils/schemas";

export const QUESTION_MIN_LENGTH = 3;
export const QUESTION_MAX_LENGTH = 1000;

export const chatSchema = z.object({
  clientId: uuidSchema,
  question: z.string().trim().min(QUESTION_MIN_LENGTH).max(QUESTION_MAX_LENGTH),
});
