import { Request, Response } from "express";
import { documentsService } from "./documents.service";
import { ApiError } from "../../utils/apiError";
import { routeParam } from "../../utils/params";

export const documentsController = {
  async create(req: Request, res: Response) {
    const document = await documentsService.create({
      ...req.body,
      uploadedBy: req.user!.userId,
    });
    res.status(201).json(document);
  },

  async upload(req: Request, res: Response) {
    if (!req.file) {
      throw new ApiError(400, "No se envió ningún archivo (campo 'file')");
    }
    // clientId y docType ya vienen validados por uploadDocumentSchema.
    const { clientId, docType } = req.body;

    const document = await documentsService.uploadAndEnqueue({
      clientId,
      docType,
      uploadedBy: req.user!.userId,
      originalName: req.file.originalname,
      buffer: req.file.buffer,
    });

    res.status(201).json(document);
  },

  async listByClient(req: Request, res: Response) {
    const documents = await documentsService.listByClient(routeParam(req, "clientId"));
    res.json(documents);
  },

  async getById(req: Request, res: Response) {
    const document = await documentsService.getById(routeParam(req, "id"), req.user!);
    res.json(document);
  },

  async reprocess(req: Request, res: Response) {
    const document = await documentsService.reprocess(routeParam(req, "id"), req.user!);
    res.status(202).json(document);
  },
};
