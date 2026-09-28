import express, { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { metricsLimiter } from "../../middlewares/rateLimit.middleware";
import { asyncHandler } from "../../utils/asyncHandler";
import { ApiError } from "../../utils/apiError";
import { summaryQuerySchema, webVitalsPayloadSchema } from "./metrics.schema";
import { metricsService } from "./metrics.service";

export const metricsRouter = Router();

/**
 * POST /api/metrics/web-vitals — recibe los beacons del navegador.
 *
 * Sin autenticación a propósito: navigator.sendBeacon no puede enviar el
 * header Authorization, y los datos son anónimos (sin usuario ni IP). Se
 * protege con rate limit por IP, tamaño máximo y validación estricta.
 * El beacon llega como text/plain (no dispara preflight CORS).
 */
metricsRouter.post(
  "/web-vitals",
  metricsLimiter,
  express.text({ type: ["text/plain", "application/json"], limit: "16kb" }),
  (req, _res, next) => {
    if (typeof req.body === "string") {
      try {
        req.body = JSON.parse(req.body);
      } catch {
        throw new ApiError(400, "El cuerpo no es JSON válido");
      }
    }
    next();
  },
  validate({ body: webVitalsPayloadSchema }),
  asyncHandler(async (req, res) => {
    await metricsService.record(req.body);
    res.status(204).end();
  })
);

/** GET /api/metrics/web-vitals/summary?days=7&device=mobile — vista "Rendimiento" (solo admin). */
metricsRouter.get(
  "/web-vitals/summary",
  authMiddleware,
  requireRole("admin"),
  validate({ query: summaryQuerySchema }),
  asyncHandler(async (req, res) => {
    const { days, device } = req.query as unknown as { days: number; device?: string };
    res.json({ days, device: device ?? null, rows: await metricsService.summary(days, device) });
  })
);
