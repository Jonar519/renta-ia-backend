import { Router } from "express";
import multer from "multer";
import { documentsController } from "./documents.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

export const documentsRouter = Router();

documentsRouter.use(authMiddleware);

documentsRouter.post("/", asyncHandler(documentsController.create));
documentsRouter.post("/upload", upload.single("file"), asyncHandler(documentsController.upload));
documentsRouter.get("/client/:clientId", asyncHandler(documentsController.listByClient));
documentsRouter.get("/:id", asyncHandler(documentsController.getById));
