import { z } from "zod";
import "../../utils/schemas";
import { uuidParams, uuidSchema } from "../../utils/schemas";
import { PASSWORD_MAX_LENGTH } from "../auth/passwordPolicy";

/**
 * Alta de cuentas SOLO por invitación (Fase 5). El admin indica nombre,
 * correo y rol; NUNCA una contraseña (no hay campo para ella: zod descarta
 * los campos no declarados).
 *  - assistant: requiere accountantUserId (el contador al que ayudará).
 *  - client (portal): requiere clientId (el expediente que podrá consultar).
 * La relación se crea al invitar; la cuenta queda pendiente y sin acceso
 * hasta que la persona la active.
 */
export const inviteSchema = z
  .object({
    name: z.string().trim().min(2).max(150),
    email: z.string().trim().email().max(150),
    role: z.enum(["admin", "accountant", "assistant", "client"]),
    accountantUserId: uuidSchema.optional(),
    clientId: uuidSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role === "assistant" && !data.accountantUserId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["accountantUserId"], message: "Campo requerido" });
    }
    if (data.role === "client" && !data.clientId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["clientId"], message: "Campo requerido" });
    }
  });

/** La invitación se identifica por la cuenta pendiente a la que pertenece. */
export const invitedUserParams = uuidParams("userId");

/**
 * El token viaja en el CUERPO (POST), nunca en la URL: las URL quedan en los
 * logs de acceso, el historial y el Referer.
 */
const token = z.string().min(1).max(200);

export const invitationTokenSchema = z.object({ token });

export const acceptInvitationSchema = z.object({
  token,
  password: z
    .string()
    .max(PASSWORD_MAX_LENGTH)
    .describe("10 a 72 caracteres; no puede ser una contraseña común ni contener el correo o el nombre"),
});
