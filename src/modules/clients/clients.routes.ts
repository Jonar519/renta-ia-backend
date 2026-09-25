import { Router } from "express";
import { clientsController } from "./clients.controller";
import { clientIdParams, createClientSchema, updateClientSchema } from "./clients.schema";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const clientsRouter = Router();

clientsRouter.use(authMiddleware);

clientsRouter.post("/", validate({ body: createClientSchema }), asyncHandler(clientsController.create));
clientsRouter.get("/", asyncHandler(clientsController.list));
clientsRouter.get("/:id", validate({ params: clientIdParams }), asyncHandler(clientsController.getById));
clientsRouter.get(
  "/:id/tax-concepts",
  validate({ params: clientIdParams }),
  asyncHandler(clientsController.listTaxConcepts)
);
clientsRouter.patch(
  "/:id",
  validate({ params: clientIdParams, body: updateClientSchema }),
  asyncHandler(clientsController.update)
);
clientsRouter.delete("/:id", validate({ params: clientIdParams }), asyncHandler(clientsController.remove));
