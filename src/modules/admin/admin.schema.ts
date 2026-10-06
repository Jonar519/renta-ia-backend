import { z } from "zod";
import { uuidSchema } from "../../utils/schemas";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "../../utils/pagination";

export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  // Cursor: id (bigint) del último registro visto; el orden es id DESC.
  cursor: z
    .string()
    .regex(/^\d{1,19}$/, "Cursor de paginación inválido")
    .optional(),
  userId: uuidSchema.optional(),
  action: z.string().max(50).optional(),
  entity: z.enum(["user", "client", "document", "session", "audit"]).optional(),
  entityId: z.string().max(64).optional(),
});
