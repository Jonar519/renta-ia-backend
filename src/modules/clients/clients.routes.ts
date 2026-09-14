import { Router } from "express";
import { clientsController } from "./clients.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const clientsRouter = Router();

clientsRouter.use(authMiddleware);

clientsRouter.post("/", asyncHandler(clientsController.create));
clientsRouter.get("/", asyncHandler(clientsController.list));
clientsRouter.get("/:id", asyncHandler(clientsController.getById));
clientsRouter.patch("/:id", asyncHandler(clientsController.update));
clientsRouter.delete("/:id", asyncHandler(clientsController.remove));
