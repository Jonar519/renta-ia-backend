import { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/apiError";

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({ error: err.message, details: err.details });
  }

  // eslint-disable-next-line no-console
  console.error(err);
  return res.status(500).json({ error: "Error interno del servidor" });
}

export function notFoundMiddleware(_req: Request, res: Response) {
  res.status(404).json({ error: "Ruta no encontrada" });
}
