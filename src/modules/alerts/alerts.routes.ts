import { Router } from "express";
import { alertsController } from "./alerts.controller";
import { alertClientParams, alertIdParams, updateAlertStatusSchema } from "./alerts.schema";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireClientAccess } from "../../middlewares/ownership.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { asyncHandler } from "../../utils/asyncHandler";
import { paginationQuerySchema } from "../../utils/pagination";
import { runDeadlineCheck } from "./deadlines.service";

export const alertsRouter = Router();

alertsRouter.use(authMiddleware);

alertsRouter.get(
  "/client/:clientId",
  validate({ params: alertClientParams, query: paginationQuerySchema }),
  requireClientAccess("params", "clientId"),
  asyncHandler(alertsController.listByClient)
);
// Ejecuta ya la revisión diaria de vencimientos (el job de BullMQ corre a las
// 06:00; esto sirve para demostrarlo o tras editar tax-calendar.json).
alertsRouter.post(
  "/deadlines/run",
  requireRole("admin"),
  asyncHandler(async (_req, res) => {
    res.json(await runDeadlineCheck());
  })
);
// La verificación de dueño está en alertsService.updateStatus (vía el cliente de la alerta).
alertsRouter.patch(
  "/:id",
  validate({ params: alertIdParams, body: updateAlertStatusSchema }),
  asyncHandler(alertsController.updateStatus)
);
