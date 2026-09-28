import { z } from "zod";
import { uuidSchema } from "../../utils/schemas";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "../../utils/pagination";
import { PASSWORD_MAX_LENGTH, passwordProblems } from "../auth/passwordPolicy";

/**
 * Alta de usuarios con rol distinto de "accountant" (el registro público
 * solo crea contadores):
 *  - assistant: requiere accountantUserId (el contador al que ayuda).
 *  - client: requiere clientId (el expediente que podrá consultar).
 */
export const createUserSchema = z
  .object({
    name: z.string().trim().min(2).max(150),
    email: z.string().trim().email().max(150),
    password: z.string().max(PASSWORD_MAX_LENGTH),
    role: z.enum(["assistant", "client"]),
    accountantUserId: uuidSchema.optional(),
    clientId: uuidSchema.optional(),
  })
  .superRefine((data, ctx) => {
    for (const message of passwordProblems(data.password, { email: data.email, name: data.name })) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["password"], message });
    }
    if (data.role === "assistant" && !data.accountantUserId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["accountantUserId"], message: "Campo requerido" });
    }
    if (data.role === "client" && !data.clientId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["clientId"], message: "Campo requerido" });
    }
  });

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
