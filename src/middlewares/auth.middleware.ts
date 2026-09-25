import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { ApiError } from "../utils/apiError";

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

  const token = header.replace("Bearer ", "");

  try {
    const payload = jwt.verify(token, env.jwtSecret) as AuthPayload;
    req.user = payload;
    next();
  } catch {
    throw new ApiError(401, "Token inválido o expirado");
  }
}
