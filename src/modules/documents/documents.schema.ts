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
export const uploadDocumentSchema = z.object({
  clientId: uuidSchema,
  docType,
});
