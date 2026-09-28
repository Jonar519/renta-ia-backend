import { createHash } from "crypto";
import { DocumentType, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { isUuid } from "../../utils/uuid";
import { storageService } from "../../services/storage";
import { documentQueue } from "../../queues/documentQueue";
import { publishDocumentEvent } from "../../services/events/documentEvents";
import { AuthPayload } from "../../middlewares/auth.middleware";
import { clientScope } from "../../middlewares/ownership.middleware";
import { afterCursor, PageParams, toPage } from "../../utils/pagination";

// El acceso al cliente (clientId) de create/upload/listByClient se verifica
// en la ruta con requireClientAccess, antes de llegar aquí.

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
  /** SHA-256 que calculó el navegador (opcional). */
  clientSha256?: string;
}

const DUPLICATE_SELECT = { id: true, originalName: true, uploadedAt: true, status: true } as const;

function duplicateError(existing: { id: string; originalName: string; uploadedAt: Date; status: string }) {
  return new ApiError(409, `Este archivo ya se subió para este cliente como "${existing.originalName}"`, {
    duplicateOf: existing,
  });
}

export const documentsService = {
  // Registro manual de metadatos (Fase 2, se mantiene por si el archivo ya
  // se subió por otro medio y solo se quiere registrar su referencia).
  async create(input: CreateDocumentInput) {
    return prisma.document.create({
      data: {
        clientId: input.clientId,
        uploadedBy: input.uploadedBy,
        docType: input.docType,
        originalName: input.originalName,
        storageKey: input.storageKey,
      },
    });
  },

  // Fase 3: sube el archivo real, crea el documento y encola su
  // procesamiento por IA (OCR/lectura, extracción, embeddings, reglas).
  async uploadAndEnqueue(input: UploadDocumentInput) {
    // La huella que vale es la del backend, calculada sobre los bytes recibidos.
    const sha256 = createHash("sha256").update(input.buffer).digest("hex");
    if (input.clientSha256 && input.clientSha256 !== sha256) {
      throw new ApiError(
        400,
        "El archivo recibido no coincide con el que se seleccionó (la huella SHA-256 es distinta). Intenta subirlo de nuevo."
      );
    }

    const existing = await prisma.document.findFirst({
      where: { clientId: input.clientId, sha256 },
      select: DUPLICATE_SELECT,
    });
    if (existing) throw duplicateError(existing);

    const storageKey = await storageService.save({
      buffer: input.buffer,
      clientId: input.clientId,
      fileName: input.originalName,
    });

    let document;
    try {
      document = await prisma.document.create({
        data: {
          clientId: input.clientId,
          uploadedBy: input.uploadedBy,
          docType: input.docType,
          originalName: input.originalName,
          storageKey,
          sha256,
          status: "uploaded",
        },
      });
    } catch (err) {
      // Dos subidas simultáneas del mismo archivo: el índice único
      // (client_id, sha256) rechaza la segunda; se borra su archivo huérfano.
      await storageService.delete(storageKey);
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const winner = await prisma.document.findFirst({
          where: { clientId: input.clientId, sha256 },
          select: DUPLICATE_SELECT,
        });
        if (winner) throw duplicateError(winner);
      }
      throw err;
    }

    await documentQueue.add("process-document", { documentId: document.id });

    return document;
  },

  /** ¿Ya existe un documento con esta huella para el cliente? (el acceso se verifica en la ruta) */
  async findByHash(clientId: string, sha256: string) {
    const document = await prisma.document.findFirst({ where: { clientId, sha256 }, select: DUPLICATE_SELECT });
    return { exists: Boolean(document), document };
  },

  async listByClient(clientId: string, { limit, cursor }: PageParams) {
    const rows = await prisma.document.findMany({
      where: { clientId, ...afterCursor("uploadedAt", cursor) },
      orderBy: [{ uploadedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      // storageKey es una ruta interna del almacenamiento: no se expone.
      select: {
        id: true,
        clientId: true,
        docType: true,
        originalName: true,
        status: true,
        errorMessage: true,
        uploadedAt: true,
        processedAt: true,
      },
    });
    return toPage(rows, limit, (d) => d.uploadedAt);
  },

  async getById(id: string, user: AuthPayload) {
    const document = isUuid(id)
      ? await prisma.document.findFirst({
          where: { id, client: clientScope(user) },
          include: { taxConcepts: true },
        })
      : null;
    if (!document) {
      throw new ApiError(404, "Documento no encontrado");
    }
    return document;
  },

  /**
   * Vuelve a encolar el análisis de un documento (p. ej. cuando falló por
   * falta de crédito en la API de IA). Solo si ya terminó (processed o
   * error); uno en cola o procesándose responde 409. Al reprocesar, el
   * worker reemplaza los conceptos y embeddings anteriores del documento.
   */
  async reprocess(id: string, user: AuthPayload) {
    const document = isUuid(id)
      ? await prisma.document.findFirst({
          where: { id, client: clientScope(user) },
          include: { client: { select: { accountantUserId: true } } },
        })
      : null;
    if (!document) {
      throw new ApiError(404, "Documento no encontrado");
    }

    // Transición condicional en una sola sentencia: dos clics simultáneos no
    // encolan el documento dos veces.
    const { count } = await prisma.document.updateMany({
      where: { id, status: { in: ["processed", "error"] } },
      data: { status: "uploaded", errorMessage: null, processedAt: null },
    });
    if (count === 0) {
      throw new ApiError(409, "El documento ya está en cola o procesándose");
    }

    await documentQueue.add("process-document", { documentId: id });
    await publishDocumentEvent({
      documentId: id,
      clientId: document.clientId,
      accountantUserId: document.client.accountantUserId,
      status: "uploaded",
      errorMessage: null,
    });
    return prisma.document.findUniqueOrThrow({ where: { id } });
  },
};
