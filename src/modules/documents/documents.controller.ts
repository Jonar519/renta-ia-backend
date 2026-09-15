import { Request, Response } from "express";
import { documentsService } from "./documents.service";
import { ApiError } from "../../utils/apiError";

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
    const { clientId, docType } = req.body;
    if (!clientId || !docType) {
      throw new ApiError(400, "clientId y docType son requeridos");
    }

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
    const documents = await documentsService.listByClient(req.params.clientId);
    res.json(documents);
  },

  async getById(req: Request, res: Response) {
    const document = await documentsService.getById(req.params.id);
    res.json(document);
  },
};
