import { z } from "zod";
import "../../utils/schemas";
import { PASSWORD_MAX_LENGTH, passwordProblems } from "./passwordPolicy";

// Campos no declarados (p. ej. "role") se descartan silenciosamente: el
// registro público nunca asigna roles.
export const registerSchema = z
  .object({
    name: z.string().trim().min(2).max(150),
    email: z.string().trim().email().max(150),
    password: z
      .string()
      .max(PASSWORD_MAX_LENGTH)
      .describe("10 a 72 caracteres; no puede ser una contraseña común ni contener el correo o el nombre"),
  })
  .superRefine((data, ctx) => {
    for (const message of passwordProblems(data.password, { email: data.email, name: data.name })) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["password"], message });
    }
  });

export const loginSchema = z.object({
  email: z.string().trim().email().max(150),
  password: z.string().min(1).max(200),
});
