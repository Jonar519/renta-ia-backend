import { Router } from "express";
import { authController } from "./auth.controller";
import { loginSchema, registerSchema } from "./auth.schema";
import { validate } from "../../middlewares/validate.middleware";
import { authLimiter } from "../../middlewares/rateLimit.middleware";
import { csrfProtection } from "../../middlewares/csrf.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const authRouter = Router();

// El limitador anti fuerza bruta (por IP) solo aplica a las credenciales;
// /refresh sin sesión responde 401 en cada arranque sin sesión y no debe
// consumir ese cupo.
authRouter.post("/register", authLimiter, validate({ body: registerSchema }), asyncHandler(authController.register));
authRouter.post("/login", authLimiter, validate({ body: loginSchema }), asyncHandler(authController.login));

// Estas dos se autentican con la cookie: requieren protección CSRF.
authRouter.post("/refresh", csrfProtection, asyncHandler(authController.refresh));
authRouter.post("/logout", csrfProtection, asyncHandler(authController.logout));
