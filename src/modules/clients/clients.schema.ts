import { z } from "zod";
import { optionalText, uuidParams, uuidSchema } from "../../utils/schemas";

const fullName = z.string().trim().min(2).max(200);
const documentNumber = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[0-9A-Za-z.-]+$/, { message: "Solo números, letras, puntos y guiones" });
const email = z.string().trim().email().max(150);
const phone = z
  .string()
  .trim()
  .max(30)
  .regex(/^[0-9+()\s-]+$/, { message: "Teléfono inválido" });

export const clientIdParams = uuidParams("id");

export const createClientSchema = z.object({
  fullName,
  documentNumber,
  email: optionalText(email),
  phone: optionalText(phone),
});

// En la actualización, enviar "" o null en email/phone los borra.
const clearable = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    schema.nullable().optional()
  );

export const updateClientSchema = z
  .object({
    fullName: fullName.optional(),
    documentNumber: documentNumber.optional(),
    email: clearable(email),
    phone: clearable(phone),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "Envía al menos un campo para actualizar",
  });

// Año gravable a resumir; si se omite, el más reciente con conceptos.
export const summarySchema = z.object({
  periodYear: z.number().int().min(2000).max(2100).optional(),
});

/** Revisar un concepto (B16): el cliente y el concepto. */
export const conceptParams = z.object({ id: uuidSchema, conceptId: uuidSchema });

/**
 * Revisar un concepto (B16): el monto que la persona confirma (el mismo que
 * leyó la IA) o corrige. Hasta 2 decimales, como NUMERIC(14, 2).
 */
export const reviewConceptSchema = z.object({
  amount: z
    .number()
    .nonnegative()
    .max(999_999_999_999.99)
    // Sin centavos de fracción: 0,1 + 0,2 no da exacto en binario, de ahí la tolerancia.
    .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, { message: "Máximo 2 decimales" })
    .describe("Monto confirmado o corregido (COP)"),
});
