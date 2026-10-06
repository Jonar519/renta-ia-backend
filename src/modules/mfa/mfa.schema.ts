import { z } from "zod";
import "../../utils/schemas";
import { uuidParams } from "../../utils/schemas";

/** Código de 6 dígitos de la app, o un código de recuperación "XXXX-XXXX-XXXX-XXXX". */
const secondFactorCode = z
  .string()
  .trim()
  .min(6)
  .max(24)
  .describe("6 dígitos de la app de autenticación, o un código de recuperación (XXXX-XXXX-XXXX-XXXX)");
const totpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Debe ser el código de 6 dígitos de la app")
  .describe("6 dígitos de la app de autenticación");
const currentPassword = z.string().min(1).max(200).describe("Contraseña actual (se vuelve a pedir)");

export const mfaSetupSchema = z.object({ password: currentPassword });
export const mfaEnableSchema = z.object({ code: totpCode });
export const mfaDisableSchema = z.object({ password: currentPassword, code: secondFactorCode });
export const mfaRegenerateSchema = z.object({ code: totpCode });

/** Segundo paso del login: el token del paso va en el cuerpo, nunca en la URL. */
export const loginMfaSchema = z.object({
  challengeToken: z.string().min(1).max(200),
  code: secondFactorCode,
});

export const mfaUserParams = uuidParams("userId");
