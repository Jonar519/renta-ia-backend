import { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/apiError";
import { verifyAccessToken } from "../modules/auth/tokens";

export type AppRole = "admin" | "accountant" | "assistant" | "client";

export interface AuthPayload {
  userId: string;
  role: AppRole;
}

// Agrega req.user al tipo Request de Express (module augmentation).
declare module "express-serve-static-core" {
  interface Request {
    user?: AuthPayload;
  }
}

export function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new ApiError(401, "Token no proporcionado");
  }

  const payload = verifyAccessToken(header.slice("Bearer ".length));
  if (!payload) {
    throw new ApiError(401, "Token inválido o expirado");
  }
  req.user = { userId: payload.userId, role: payload.role };
  next();
}
