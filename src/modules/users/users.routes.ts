import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { profileLimiter } from "../../middlewares/rateLimit.middleware";
import { audit } from "../../services/audit/audit.service";
import { asyncHandler } from "../../utils/asyncHandler";
import { mfaRouter } from "../mfa/mfa.routes";
import { profileService } from "./profile.service";
import { changePasswordSchema, emailChangeSchema, updateProfileSchema } from "./profile.schema";

/**
 * La propia cuenta (/api/users/me). Ownership por construcción: todas las
 * rutas actúan sobre req.user.userId; no reciben el id de otra cuenta.
 */
export const usersRouter = Router();

usersRouter.use(authMiddleware);

usersRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    res.json(await profileService.me(req.user!.userId));
  })
);

usersRouter.patch(
  "/me",
  validate({ body: updateProfileSchema }),
  asyncHandler(async (req, res) => {
    const me = await profileService.update(req.user!.userId, req.body);
    audit(req, { action: "user.profile.update", entity: "user", entityId: req.user!.userId });
    res.json(me);
  })
);

usersRouter.post(
  "/me/email",
  profileLimiter,
  validate({ body: emailChangeSchema }),
  asyncHandler(async (req, res) => {
    const result = await profileService.requestEmailChange(req.user!.userId, req.body.newEmail, req.body.password);
    audit(req, { action: "user.email_change.requested", entity: "user", entityId: req.user!.userId });
    res.status(202).json(result);
  })
);

usersRouter.delete(
  "/me/email",
  asyncHandler(async (req, res) => {
    await profileService.cancelEmailChange(req.user!.userId);
    audit(req, { action: "user.email_change.cancelled", entity: "user", entityId: req.user!.userId });
    res.status(204).end();
  })
);

usersRouter.post(
  "/me/password",
  profileLimiter,
  validate({ body: changePasswordSchema }),
  asyncHandler(async (req, res) => {
    const result = await profileService.changePassword(
      req.user!.userId,
      req.user!.sid,
      req.body.currentPassword,
      req.body.newPassword
    );
    audit(req, { action: "user.password.change", entity: "user", entityId: req.user!.userId });
    res.json(result);
  })
);

usersRouter.use("/me/mfa", mfaRouter);
