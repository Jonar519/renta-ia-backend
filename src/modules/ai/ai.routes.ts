import { Router } from "express";
import { aiController } from "./ai.controller";
import { chatSchema } from "./ai.schema";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireClientAccess } from "../../middlewares/ownership.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { aiChatLimiter } from "../../middlewares/rateLimit.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const aiRouter = Router();

aiRouter.use(authMiddleware);

aiRouter.post(
  "/chat",
  aiChatLimiter,
  validate({ body: chatSchema }),
  requireClientAccess("body", "clientId"),
  asyncHandler(aiController.chat)
);
