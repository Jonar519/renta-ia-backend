import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { authRouter } from "./modules/auth/auth.routes";
import { usersRouter } from "./modules/users/users.routes";
import { clientsRouter } from "./modules/clients/clients.routes";
import { documentsRouter } from "./modules/documents/documents.routes";
import { alertsRouter } from "./modules/alerts/alerts.routes";
import { aiRouter } from "./modules/ai/ai.routes";
import { errorMiddleware, notFoundMiddleware } from "./middlewares/error.middleware";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(morgan("dev"));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/clients", clientsRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api/alerts", alertsRouter);
  app.use("/api/ai", aiRouter);

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
