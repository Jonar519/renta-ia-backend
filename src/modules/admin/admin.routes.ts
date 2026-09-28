import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { asyncHandler } from "../../utils/asyncHandler";
import { audit } from "../../services/audit/audit.service";
import { adminService } from "./admin.service";
import { auditQuerySchema, createUserSchema } from "./admin.schema";

export const adminRouter = Router();

adminRouter.use(authMiddleware, requireRole("admin"));

/** Crea usuarios assistant (ligado a un contador) o client (ligado a un expediente). */
adminRouter.post(
  "/users",
  validate({ body: createUserSchema }),
  asyncHandler(async (req, res) => {
    const user = await adminService.createUser(req.body);
    audit(req, { action: "admin.user.create", entity: "user", entityId: user.id });
    res.status(201).json(user);
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
