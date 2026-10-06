import { z } from "zod";
import "../../utils/schemas";
import { PASSWORD_MAX_LENGTH } from "./passwordPolicy";

/** Pedir la recuperación: solo el correo. La respuesta es la misma exista o no. */
export const passwordResetRequestSchema = z.object({
  email: z.string().trim().email().max(150),
});

/** El token va en el cuerpo, nunca en la URL (las URL quedan en los logs). */
export const passwordResetTokenSchema = z.object({ token: z.string().min(1).max(200) });

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1).max(200),
  password: z
    .string()
    .max(PASSWORD_MAX_LENGTH)
    .describe("10 a 72 caracteres; no puede ser una contraseña común ni contener el correo o el nombre"),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(150),
  password: z.string().min(1).max(200),
});
