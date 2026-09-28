import { z } from "zod";
import { DocumentType } from "@prisma/client";
import { uuidParams, uuidSchema } from "../../utils/schemas";

const docType = z.nativeEnum(DocumentType, {
  errorMap: () => ({ message: `docType inválido. Opciones: ${Object.values(DocumentType).join(", ")}` }),
});

export const documentIdParams = uuidParams("id");
export const documentClientParams = uuidParams("clientId");

export const createDocumentSchema = z.object({
  clientId: uuidSchema,
  docType,
  originalName: z.string().trim().min(1).max(255),
  storageKey: z.string().trim().min(1).max(500),
});

// Campos de texto que acompañan al archivo en el multipart de /upload.
const sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { message: "Debe ser un SHA-256 en hexadecimal (64 caracteres en minúscula)" });

export const uploadDocumentSchema = z.object({
  clientId: uuidSchema,
  docType,
  // Huella calculada por el navegador (Web Worker). Opcional: si viene, se
  // compara con la que calcula el backend para detectar un archivo alterado.
  sha256: sha256.optional(),
});

export const byHashParams = z.object({ clientId: uuidSchema, sha256 });
