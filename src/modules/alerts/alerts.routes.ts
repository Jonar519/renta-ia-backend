import { Router } from "express";
import { alertsController } from "./alerts.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const alertsRouter = Router();

alertsRouter.use(authMiddleware);

alertsRouter.get("/client/:clientId", asyncHandler(alertsController.listByClient));
