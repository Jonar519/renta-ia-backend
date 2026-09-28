import { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { ApiError } from "../utils/apiError";
import { isUuid } from "../utils/uuid";
import { AuthPayload } from "./auth.middleware";

/**
 * Único lugar donde se decide si un usuario puede acceder a un cliente:
 *  - admin: todos.
 *  - accountant: los clientes de los que es contador responsable
 *    (clients.accountant_user_id).
 *  - assistant: los clientes de los contadores a los que está asignado
 *    (tabla accountant_assistants).
 *  - client: solo su propio expediente (clients.portal_user_id).
 * Lo que cada rol puede MODIFICAR se decide en las rutas (role.middleware).
 *
 * Si no tiene acceso se responde 404 (no 403) para no revelar que el
 * recurso existe.
 */
export function clientScope(user: AuthPayload): Prisma.ClientWhereInput {
  switch (user.role) {
    case "admin":
      return {};
    case "accountant":
      return { accountantUserId: user.userId };
    case "assistant":
      return { accountant: { assistants: { some: { assistantUserId: user.userId } } } };
    case "client":
      return { portalUserId: user.userId };
    default:
      // Rol desconocido: no ve nada (defensa en profundidad).
      return { id: { in: [] } };
  }
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
