import { z } from "zod";
import "../../utils/schemas";

export const loginSchema = z.object({
  email: z.string().trim().email().max(150),
  password: z.string().min(1).max(200),
});
