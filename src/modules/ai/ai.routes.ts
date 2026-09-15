import { Router } from "express";
import { aiController } from "./ai.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const aiRouter = Router();

aiRouter.use(authMiddleware);

aiRouter.post("/chat", asyncHandler(aiController.chat));
