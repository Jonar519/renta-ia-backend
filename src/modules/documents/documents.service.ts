import { DocumentType } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { storageService } from "../../services/storage";
import { documentQueue } from "../../queues/documentQueue";

interface CreateDocumentInput {
  clientId: string;
  uploadedBy: string;
  docType: DocumentType;
  originalName: string;
  storageKey: string;
}

interface UploadDocumentInput {
  clientId: string;
  uploadedBy: string;
  docType: DocumentType;
  originalName: string;
  buffer: Buffer;
}

export const documentsService = {
  // Registro manual de metadatos (Fase 2, se mantiene por si el archivo ya
  // se subió por otro medio y solo se quiere registrar su referencia).
  async create(input: CreateDocumentInput) {
    return prisma.document.create({ data: input });
  },

  // Fase 3: sube el archivo real, crea el documento y encola su
  // procesamiento por IA (OCR/lectura, extracción, embeddings, reglas).
  async uploadAndEnqueue(input: UploadDocumentInput) {
    const storageKey = await storageService.save({
      buffer: input.buffer,
      clientId: input.clientId,
      fileName: input.originalName,
    });

    const document = await prisma.document.create({
      data: {
        clientId: input.clientId,
        uploadedBy: input.uploadedBy,
        docType: input.docType,
        originalName: input.originalName,
        storageKey,
        status: "uploaded",
      },
    });

    await documentQueue.add("process-document", { documentId: document.id });

    return document;
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
