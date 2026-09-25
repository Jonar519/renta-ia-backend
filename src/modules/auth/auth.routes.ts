import { Router } from "express";
import { authController } from "./auth.controller";
import { loginSchema, registerSchema } from "./auth.schema";
import { validate } from "../../middlewares/validate.middleware";
import { authLimiter } from "../../middlewares/rateLimit.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const authRouter = Router();

authRouter.use(authLimiter);

authRouter.post("/register", validate({ body: registerSchema }), asyncHandler(authController.register));
authRouter.post("/login", validate({ body: loginSchema }), asyncHandler(authController.login));
