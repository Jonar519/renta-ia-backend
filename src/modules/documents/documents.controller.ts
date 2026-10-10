import { Request, Response } from "express";
import { documentsService } from "./documents.service";
import { ApiError } from "../../utils/apiError";
import { audit } from "../../services/audit/audit.service";
import { routeParam } from "../../utils/params";
import type { PageParams } from "../../utils/pagination";

export const documentsController = {
  async create(req: Request, res: Response) {
    const document = await documentsService.create({
      ...req.body,
      uploadedBy: req.user!.userId,
    });
    audit(req, { action: "document.upload", entity: "document", entityId: document.id });
    res.status(201).json(document);
  },

  async upload(req: Request, res: Response) {
    if (!req.file) {
      throw new ApiError(400, "No se envió ningún archivo (campo 'file')");
    }
    // clientId y docType ya vienen validados por uploadDocumentSchema.
    const { clientId, docType, sha256 } = req.body;

    const document = await documentsService.uploadAndEnqueue({
      clientId,
      docType,
      uploadedBy: req.user!.userId,
      originalName: req.file.originalname,
      buffer: req.file.buffer,
      clientSha256: sha256,
    });
    audit(req, { action: "document.upload", entity: "document", entityId: document.id });

    res.status(201).json(document);
  },

  async listByClient(req: Request, res: Response) {
    const documents = await documentsService.listByClient(
      routeParam(req, "clientId"),
      req.query as unknown as PageParams
    );
    audit(req, { action: "document.list", entity: "client", entityId: routeParam(req, "clientId") });
    res.json(documents);
  },

  async findByHash(req: Request, res: Response) {
    res.json(await documentsService.findByHash(routeParam(req, "clientId"), routeParam(req, "sha256")));
  },

  async getById(req: Request, res: Response) {
    const document = await documentsService.getById(routeParam(req, "id"), req.user!);
    audit(req, { action: "document.view", entity: "document", entityId: document.id });
    res.json(document);
  },

  /**
   * El archivo original, para la vista dividida (B17). Se sirve inline con el
   * tipo real, nosniff (helmet) y una CSP que no permite nada: si alguien abre
   * la URL directamente, un archivo "políglota" no puede ejecutar código.
   */
  async getFile(req: Request, res: Response) {
    const { buffer, contentType, fileName } = await documentsService.getFile(routeParam(req, "id"), req.user!);
    audit(req, { action: "document.file.view", entity: "document", entityId: routeParam(req, "id") });
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(buffer);
  },

  async reprocess(req: Request, res: Response) {
    const { document, discardedReviews } = await documentsService.reprocess(
      routeParam(req, "id"),
      req.user!,
      req.body?.discardReviews === true
    );
    audit(req, { action: "document.reprocess", entity: "document", entityId: document.id });
    // D6: descartar revisiones queda auditado aparte.
    if (discardedReviews > 0) {
      audit(req, { action: "document.reprocess.discard_reviews", entity: "document", entityId: document.id });
    }
    res.status(202).json(document);
  },
};
