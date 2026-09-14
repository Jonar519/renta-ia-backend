import { Router } from "express";
import { authController } from "./auth.controller";
import { asyncHandler } from "../../utils/asyncHandler";

export const authRouter = Router();

authRouter.post("/register", asyncHandler(authController.register));
authRouter.post("/login", asyncHandler(authController.login));
