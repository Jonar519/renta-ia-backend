import { Router } from "express";
import { validate } from "../../middlewares/validate.middleware";
import { mfaManageLimiter } from "../../middlewares/rateLimit.middleware";
import { audit } from "../../services/audit/audit.service";
import { asyncHandler } from "../../utils/asyncHandler";
import { mfaService } from "./mfa.service";
import { mfaDisableSchema, mfaEnableSchema, mfaRegenerateSchema, mfaSetupSchema } from "./mfa.schema";

/**
 * Verificación en dos pasos de la PROPIA cuenta: /api/users/me/mfa (detrás
 * de authMiddleware). Cambiarla exige reconfirmar: la contraseña para
 * empezar a configurarla o desactivarla, y un código de la app para
 * activarla o regenerar los códigos de recuperación. Así, una sesión robada
 * no basta para quitarle el segundo factor a su dueño ni para poner uno propio.
 */
export const mfaRouter = Router();

mfaRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await mfaService.status(req.user!.userId));
  })
);

mfaRouter.post(
  "/setup",
  mfaManageLimiter,
  validate({ body: mfaSetupSchema }),
  asyncHandler(async (req, res) => {
    const setup = await mfaService.beginSetup(req.user!.userId, req.body.password);
    audit(req, { action: "mfa.setup.started", entity: "user", entityId: req.user!.userId });
    // El secreto viaja solo en esta respuesta (para el QR o la clave manual);
    // como toda la API, con Cache-Control: no-store (app.ts, ADR 0008).
    res.status(201).json(setup);
  })
);

mfaRouter.post(
  "/enable",
  mfaManageLimiter,
  validate({ body: mfaEnableSchema }),
  asyncHandler(async (req, res) => {
    const result = await mfaService.enable(req.user!.userId, req.body.code, req.user!.sid);
    audit(req, { action: "mfa.enabled", entity: "user", entityId: req.user!.userId });
    // Los códigos de recuperación se muestran UNA sola vez (en la base, solo su hash).
    res.json(result);
  })
);

mfaRouter.post(
  "/disable",
  mfaManageLimiter,
  validate({ body: mfaDisableSchema }),
  asyncHandler(async (req, res) => {
    await mfaService.disable(req.user!.userId, req.body.password, req.body.code);
    audit(req, { action: "mfa.disabled", entity: "user", entityId: req.user!.userId });
    res.status(204).end();
  })
);

mfaRouter.post(
  "/recovery-codes",
  mfaManageLimiter,
  validate({ body: mfaRegenerateSchema }),
  asyncHandler(async (req, res) => {
    const result = await mfaService.regenerateRecoveryCodes(req.user!.userId, req.body.code);
    audit(req, { action: "mfa.recovery_codes.regenerated", entity: "user", entityId: req.user!.userId });
    res.json(result);
  })
);
