import { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { ApiError } from "../utils/apiError";
import { isUuid } from "../utils/uuid";
import { AuthPayload } from "./auth.middleware";

/**
 * Único lugar donde se decide si un usuario puede acceder a un cliente:
 * el admin ve todo; cualquier otro rol solo ve los clientes de los que es
 * contador responsable (clients.accountant_user_id).
 *
 * Si no tiene acceso se responde 404 (no 403) para no revelar que el
 * recurso existe.
 */
export function clientScope(user: AuthPayload): Prisma.ClientWhereInput {
  return user.role === "admin" ? {} : { accountantUserId: user.userId };
}

export async function assertClientAccess(clientId: string, user: AuthPayload) {
  if (!isUuid(clientId)) {
    throw new ApiError(404, "Cliente no encontrado");
  }
  const client = await prisma.client.findFirst({ where: { id: clientId, ...clientScope(user) } });
  if (!client) {
    throw new ApiError(404, "Cliente no encontrado");
  }
  return client;
}

/**
 * Middleware que verifica acceso al cliente indicado en `req.params[key]` o
 * `req.body[key]`. Debe ir después de authMiddleware (y, en rutas multipart,
 * después de multer, que es quien llena req.body).
 */
export function requireClientAccess(source: "params" | "body", key: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const container = (source === "params" ? req.params : req.body) as Record<string, unknown> | undefined;
    const clientId = String(container?.[key] ?? "");
    assertClientAccess(clientId, req.user!)
      .then(() => next())
      .catch(next);
  };
}
