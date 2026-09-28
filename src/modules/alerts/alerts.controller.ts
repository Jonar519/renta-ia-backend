import { Request, Response } from "express";
import { alertsService } from "./alerts.service";
import { routeParam } from "../../utils/params";

export const alertsController = {
  async listByClient(req: Request, res: Response) {
    const alerts = await alertsService.listByClient(routeParam(req, "clientId"));
    res.json(alerts);
  },

  // status ya viene validado por updateAlertStatusSchema.
  async updateStatus(req: Request, res: Response) {
    const alert = await alertsService.updateStatus(routeParam(req, "id"), req.body.status, req.user!);
    res.json(alert);
  },
};
