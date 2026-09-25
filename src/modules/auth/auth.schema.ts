import { z } from "zod";
import "../../utils/schemas";

// Campos no declarados (p. ej. "role") se descartan silenciosamente: el
// registro público nunca asigna roles.
export const registerSchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.string().trim().email().max(150),
  // bcrypt solo usa los primeros 72 bytes de la contraseña.
  password: z.string().min(8).max(72),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(150),
  password: z.string().min(1).max(200),
});
