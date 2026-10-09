import { z } from "zod";
import { uuidParams } from "../../utils/schemas";
import { PASSWORD_MAX_LENGTH } from "../auth/passwordPolicy";

/** Mismo formato que impone la base (chk_users_phone_format). */
export const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{5,27}[0-9]$/;

const phone = z
  .string()
  .trim()
  .max(30)
  .regex(PHONE_PATTERN, "Usa solo dígitos, espacios, paréntesis, guiones y un + inicial (7 a 30 caracteres)")
  .describe("Opcional. Vacío o null lo borra");

/** Nombre y/o teléfono. El teléfono vacío ("") o null se borra. */
export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(150).optional(),
    phone: z
      .union([z.literal(""), z.null(), phone])
      .optional()
      .transform((value) => (value === "" ? null : value)),
  })
  .refine((data) => data.name !== undefined || data.phone !== undefined, {
    message: "Indica el nombre o el teléfono",
  });

const currentPassword = z.string().min(1).max(200).describe("Contraseña actual (se vuelve a pedir)");

export const emailChangeSchema = z.object({
  newEmail: z.string().trim().email().max(150),
  password: currentPassword,
});

/** El token va en el cuerpo, nunca en la URL (las URL quedan en los logs). */
export const emailChangeConfirmSchema = z.object({ token: z.string().min(1).max(200) });

export const changePasswordSchema = z.object({
  currentPassword,
  newPassword: z
    .string()
    .max(PASSWORD_MAX_LENGTH)
    .describe("10 a 72 caracteres; distinta de la actual; sin contraseñas comunes ni el correo o el nombre"),
});

/** Sesión a cerrar (B13): el id de la sesión (familia de refresh tokens). */
export const sessionParams = uuidParams("sessionId");
