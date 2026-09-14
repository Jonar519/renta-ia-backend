import { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/apiError";
import { AppRole } from "./auth.middleware";

export function requireRole(...roles: AppRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new ApiError(403, "No tienes permisos para realizar esta acción");
    }
    next();
  };
}
