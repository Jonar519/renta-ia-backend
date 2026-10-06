import { Router } from "express";
import { authController } from "./auth.controller";
import {
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  passwordResetTokenSchema,
} from "./auth.schema";
import { acceptInvitationSchema, invitationTokenSchema } from "../invitations/invitations.schema";
import { validate } from "../../middlewares/validate.middleware";
import {
  authLimiter,
  invitationLimiter,
  passwordResetLimiter,
  passwordResetRequestLimiter,
} from "../../middlewares/rateLimit.middleware";
import { csrfProtection } from "../../middlewares/csrf.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const authRouter = Router();

// El limitador anti fuerza bruta (por IP) solo aplica a las credenciales;
// /refresh sin sesión responde 401 en cada arranque sin sesión y no debe
// consumir ese cupo.
authRouter.post("/login", authLimiter, validate({ body: loginSchema }), asyncHandler(authController.login));

// No hay registro público: las cuentas se crean por invitación de un admin
// (POST /api/admin/invitations). Estas dos rutas son la pantalla pública
// "Completa tu cuenta"; el token va en el cuerpo, nunca en la URL.
authRouter.post(
  "/invitations/lookup",
  invitationLimiter,
  validate({ body: invitationTokenSchema }),
  asyncHandler(authController.lookupInvitation)
);
authRouter.post(
  "/invitations/accept",
  invitationLimiter,
  validate({ body: acceptInvitationSchema }),
  asyncHandler(authController.acceptInvitation)
);

// Recuperación de contraseña (pública). Pedirla responde siempre igual (202).
authRouter.post(
  "/password-reset/request",
  passwordResetRequestLimiter,
  validate({ body: passwordResetRequestSchema }),
  asyncHandler(authController.requestPasswordReset)
);
authRouter.post(
  "/password-reset/lookup",
  passwordResetLimiter,
  validate({ body: passwordResetTokenSchema }),
  asyncHandler(authController.lookupPasswordReset)
);
authRouter.post(
  "/password-reset/confirm",
  passwordResetLimiter,
  validate({ body: passwordResetConfirmSchema }),
  asyncHandler(authController.confirmPasswordReset)
);

// Estas dos se autentican con la cookie: requieren protección CSRF.
authRouter.post("/refresh", csrfProtection, asyncHandler(authController.refresh));
authRouter.post("/logout", csrfProtection, asyncHandler(authController.logout));
