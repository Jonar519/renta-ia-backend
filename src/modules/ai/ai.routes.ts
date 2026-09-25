import { Router } from "express";
import { aiController } from "./ai.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireClientAccess } from "../../middlewares/ownership.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const aiRouter = Router();

aiRouter.use(authMiddleware);

aiRouter.post("/chat", requireClientAccess("body", "clientId"), asyncHandler(aiController.chat));
