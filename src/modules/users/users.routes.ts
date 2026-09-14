import { Router } from "express";
import { usersController } from "./users.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const usersRouter = Router();

usersRouter.use(authMiddleware);

usersRouter.get("/me", asyncHandler(usersController.me));
