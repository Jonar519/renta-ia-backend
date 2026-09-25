import { Router } from "express";
import { alertsController } from "./alerts.controller";
import { alertClientParams } from "./alerts.schema";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireClientAccess } from "../../middlewares/ownership.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const alertsRouter = Router();

alertsRouter.use(authMiddleware);

alertsRouter.get(
  "/client/:clientId",
  validate({ params: alertClientParams }),
  requireClientAccess("params", "clientId"),
  asyncHandler(alertsController.listByClient)
);
