import { Request, Response } from "express";
import { clientsService } from "./clients.service";
import { summaryService } from "./summary.service";
import { routeParam } from "../../utils/params";

export const clientsController = {
  async create(req: Request, res: Response) {
    const client = await clientsService.create({
      ...req.body,
      accountantUserId: req.user!.userId,
    });
    res.status(201).json(client);
  },

  async list(req: Request, res: Response) {
    const clients = await clientsService.list(req.user!);
    res.json(clients);
  },

  // periodYear (opcional) ya viene validado por summarySchema.
  async summary(req: Request, res: Response) {
    const summary = await summaryService.generate(routeParam(req, "id"), req.user!, req.body?.periodYear);
    res.json(summary);
  },

  async getById(req: Request, res: Response) {
    const client = await clientsService.getById(routeParam(req, "id"), req.user!);
    res.json(client);
  },

  async update(req: Request, res: Response) {
    const client = await clientsService.update(routeParam(req, "id"), req.body ?? {}, req.user!);
    res.json(client);
  },

  async remove(req: Request, res: Response) {
    await clientsService.remove(routeParam(req, "id"), req.user!);
    res.status(204).send();
  },

  async listTaxConcepts(req: Request, res: Response) {
    const concepts = await clientsService.listTaxConcepts(routeParam(req, "id"), req.user!);
    res.json(concepts);
  },
};
