import { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/apiError";
import { AppRole } from "./auth.middleware";

/** Rechaza con 403 a los roles indicados (p. ej. "client", que es de solo lectura). */
export function forbidRoles(...roles: AppRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || roles.includes(req.user.role)) {
      throw new ApiError(403, "No tienes permisos para realizar esta acción");
    }
    next();
  };
}

export function requireRole(...roles: AppRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new ApiError(403, "No tienes permisos para realizar esta acción");
    }
    next();
  };
}
