import { z } from "zod";
import { optionalText, uuidParams } from "../../utils/schemas";

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
  z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? null : value), schema.nullable().optional());

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
