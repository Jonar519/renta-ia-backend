import { Request, Response } from "express";
import { clientsService } from "./clients.service";

export const clientsController = {
  async create(req: Request, res: Response) {
    const client = await clientsService.create({
      ...req.body,
      accountantUserId: req.user!.userId,
    });
    res.status(201).json(client);
  },

  async list(req: Request, res: Response) {
    const clients = await clientsService.listByAccountant(req.user!.userId);
    res.json(clients);
  },

  async getById(req: Request, res: Response) {
    const client = await clientsService.getById(req.params.id);
    res.json(client);
  },

  async update(req: Request, res: Response) {
    const client = await clientsService.update(req.params.id, req.body);
    res.json(client);
  },

  async remove(req: Request, res: Response) {
    await clientsService.remove(req.params.id);
    res.status(204).send();
  },
};
