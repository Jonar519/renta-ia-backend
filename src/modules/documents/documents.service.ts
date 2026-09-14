import { DocumentType } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";

interface CreateDocumentInput {
  clientId: string;
  uploadedBy: string;
  docType: DocumentType;
  originalName: string;
  storageKey: string;
}

export const documentsService = {
  // Nota: en esta fase solo registramos los metadatos del documento.
  // La subida real a S3 y el encolado hacia el pipeline de IA se agregan
  // en la Fase 3 (integración de inteligencia artificial).
  async create(input: CreateDocumentInput) {
    return prisma.document.create({ data: input });
  },

  async listByClient(clientId: string) {
    return prisma.document.findMany({
      where: { clientId },
      orderBy: { uploadedAt: "desc" },
    });
  },

  async getById(id: string) {
    const document = await prisma.document.findUnique({
      where: { id },
      include: { taxConcepts: true },
    });
    if (!document) {
      throw new ApiError(404, "Documento no encontrado");
    }
    return document;
  },
};
