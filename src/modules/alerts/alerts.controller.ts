import { Request, Response } from "express";
import { alertsService } from "./alerts.service";

export const alertsController = {
  async listByClient(req: Request, res: Response) {
    const alerts = await alertsService.listByClient(req.params.clientId);
    res.json(alerts);
  },
};
