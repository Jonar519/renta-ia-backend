import { Router } from "express";
import { alertsController } from "./alerts.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireClientAccess } from "../../middlewares/ownership.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const alertsRouter = Router();

alertsRouter.use(authMiddleware);

alertsRouter.get(
  "/client/:clientId",
  requireClientAccess("params", "clientId"),
  asyncHandler(alertsController.listByClient)
);
