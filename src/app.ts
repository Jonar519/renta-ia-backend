import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import { env } from "./config/env";
import { authRouter } from "./modules/auth/auth.routes";
import { usersRouter } from "./modules/users/users.routes";
import { clientsRouter } from "./modules/clients/clients.routes";
import { documentsRouter } from "./modules/documents/documents.routes";
import { alertsRouter } from "./modules/alerts/alerts.routes";
import { aiRouter } from "./modules/ai/ai.routes";
import { metricsRouter } from "./modules/metrics/metrics.routes";
import { errorMiddleware, notFoundMiddleware } from "./middlewares/error.middleware";
import { globalLimiter } from "./middlewares/rateLimit.middleware";

export function createApp() {
  const app = express();

  app.set("trust proxy", env.trustProxy);

  // helmet revisado (Fase 4, docs/threat-model.md): la API solo sirve JSON, así
  // que los defaults son correctos: CSP "default-src 'self'" (no aplica a
  // JSON, pero protege si un error devolviera HTML), X-Content-Type-Options
  // nosniff, frame-ancestors 'none'/X-Frame-Options, Referrer-Policy
  // no-referrer, HSTS (efectivo detrás de HTTPS) y Cross-Origin-Resource-Policy
  // same-origin (no afecta a fetch con CORS; impide incrustar respuestas con
  // <img>/<script> desde otros sitios). Se quita X-Powered-By.
  app.use(helmet());
  // gzip/brotli de las respuestas (> 1 KB). Medido: el detalle de un cliente
  // con 4.000 conceptos transfería 824 KB de JSON sin comprimir
  // (docs/performance-report.md del frontend).
  app.use(compression({ threshold: 1024 }));
  // credentials: true para que el navegador envíe la cookie de refresh a
  // /api/auth (solo a los orígenes listados en CORS_ORIGIN).
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: "100kb" }));

  // "dev" (colores, conciso) solo en desarrollo; "combined" (formato Apache
  // estándar, sin headers de autorización) en producción; nada en tests.
  if (env.nodeEnv === "development") {
    app.use(morgan("dev"));
  } else if (env.nodeEnv !== "test") {
    app.use(morgan("combined"));
  }

  // Política de caché (docs/cache-policy.md del frontend): NINGUNA respuesta
  // de la API se guarda en cachés del navegador, proxies ni CDN. Todo lo que
  // devuelve la API es dato tributario/personal o estado que cambia (y
  // además depende del usuario autenticado).
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api", globalLimiter);
  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/clients", clientsRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api/alerts", alertsRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/metrics", metricsRouter);

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
