import { Router } from "express";
import { documentsController } from "./documents.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const documentsRouter = Router();

documentsRouter.use(authMiddleware);

documentsRouter.post("/", asyncHandler(documentsController.create));
documentsRouter.get("/client/:clientId", asyncHandler(documentsController.listByClient));
documentsRouter.get("/:id", asyncHandler(documentsController.getById));
