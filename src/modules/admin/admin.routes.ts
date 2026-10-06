import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { asyncHandler } from "../../utils/asyncHandler";
import { audit } from "../../services/audit/audit.service";
import { adminService } from "./admin.service";
import { auditQuerySchema, portalClientsQuerySchema } from "./admin.schema";
import { invitationsService } from "../invitations/invitations.service";
import { invitedUserParams, inviteSchema } from "../invitations/invitations.schema";

export const adminRouter = Router();

adminRouter.use(authMiddleware, requireRole("admin"));

/**
 * Alta de cuentas: SOLO por invitación (Fase 5). No existe ninguna ruta que
 * cree una cuenta con contraseña: la define la persona invitada al activarla.
 * Las respuestas nunca incluyen el token ni el enlace (solo viajan por correo).
 */
adminRouter.post(
  "/invitations",
  validate({ body: inviteSchema }),
  asyncHandler(async (req, res) => {
    const view = await invitationsService.invite(req.body, req.user!);
    audit(req, { action: "admin.invitation.create", entity: "user", entityId: view.userId });
    res.status(201).json(view);
  })
);

adminRouter.get(
  "/invitations",
  asyncHandler(async (_req, res) => {
    res.json({ items: await invitationsService.list() });
  })
);

adminRouter.post(
  "/invitations/:userId/resend",
  validate({ params: invitedUserParams }),
  asyncHandler(async (req, res) => {
    const view = await invitationsService.resend(req.params.userId as string, req.user!);
    audit(req, { action: "admin.invitation.resend", entity: "user", entityId: view.userId });
    res.json(view);
  })
);

adminRouter.delete(
  "/invitations/:userId",
  validate({ params: invitedUserParams }),
  asyncHandler(async (req, res) => {
    await invitationsService.cancel(req.params.userId as string);
    audit(req, { action: "admin.invitation.cancel", entity: "user", entityId: req.params.userId as string });
    res.status(204).end();
  })
);

// Datos para el formulario de invitación (solo lectura).
adminRouter.get(
  "/accountants",
  asyncHandler(async (_req, res) => {
    res.json({ items: await adminService.listAccountants() });
  })
);

adminRouter.get(
  "/portal-clients",
  validate({ query: portalClientsQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as z.infer<typeof portalClientsQuerySchema>;
    res.json({ items: await adminService.listPortalCandidates(query) });
  })
);

adminRouter.get(
  "/audit",
  validate({ query: auditQuerySchema }),
  asyncHandler(async (req, res) => {
    const page = await adminService.listAudit(req.query as unknown as z.infer<typeof auditQuerySchema>);
    audit(req, { action: "admin.audit.view", entity: "audit" });
    res.json(page);
  })
);
