import { Request, Response } from "express";
import { documentsService } from "./documents.service";

export const documentsController = {
  async create(req: Request, res: Response) {
    const document = await documentsService.create({
      ...req.body,
      uploadedBy: req.user!.userId,
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
