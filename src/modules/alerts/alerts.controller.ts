import { Request, Response } from "express";
import { alertsService } from "./alerts.service";
import { routeParam } from "../../utils/params";

export const alertsController = {
  async listByClient(req: Request, res: Response) {
    const alerts = await alertsService.listByClient(routeParam(req, "clientId"));
    res.json(alerts);
  },
};
