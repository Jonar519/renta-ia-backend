import { Router } from "express";
import { clientsController } from "./clients.controller";
import { clientIdParams, createClientSchema, summarySchema, updateClientSchema } from "./clients.schema";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { forbidRoles, requireRole } from "../../middlewares/role.middleware";
import { summaryLimiter } from "../../middlewares/rateLimit.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { asyncHandler } from "../../utils/asyncHandler";
import { paginationQuerySchema } from "../../utils/pagination";

export const clientsRouter = Router();

clientsRouter.use(authMiddleware);

// Permisos por rol (el alcance de lectura lo da clientScope):
//  - crear y borrar clientes: solo el contador responsable (y el admin). Un
//    asistente trabaja sobre los clientes de su contador, pero no los crea
//    (quedarían a su nombre) ni los borra.
//  - el rol "client" (portal) es de solo lectura.
const ownersOnly = requireRole("admin", "accountant");
const readOnlyClient = forbidRoles("client");

clientsRouter.post("/", ownersOnly, validate({ body: createClientSchema }), asyncHandler(clientsController.create));
clientsRouter.get("/", validate({ query: paginationQuerySchema }), asyncHandler(clientsController.list));
clientsRouter.get("/:id", validate({ params: clientIdParams }), asyncHandler(clientsController.getById));
clientsRouter.get(
  "/:id/tax-concepts",
  validate({ params: clientIdParams }),
  asyncHandler(clientsController.listTaxConcepts)
);
clientsRouter.post(
  "/:id/summary",
  readOnlyClient,
  summaryLimiter,
  validate({ params: clientIdParams, body: summarySchema }),
  asyncHandler(clientsController.summary)
);
clientsRouter.patch(
  "/:id",
  readOnlyClient,
  validate({ params: clientIdParams, body: updateClientSchema }),
  asyncHandler(clientsController.update)
);
clientsRouter.delete("/:id", ownersOnly, validate({ params: clientIdParams }), asyncHandler(clientsController.remove));
