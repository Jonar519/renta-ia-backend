import { Router } from "express";
import multer from "multer";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { avatarLimiter, profileLimiter } from "../../middlewares/rateLimit.middleware";
import { ApiError } from "../../utils/apiError";
import { AVATAR_MIME_TYPES, MAX_AVATAR_BYTES } from "../../utils/fileType";
import { avatarService } from "./avatar.service";
import { audit } from "../../services/audit/audit.service";
import { asyncHandler } from "../../utils/asyncHandler";
import { mfaRouter } from "../mfa/mfa.routes";
import { profileService } from "./profile.service";
import {
  changePasswordSchema,
  deleteAccountSchema,
  emailChangeSchema,
  exportDataSchema,
  sessionParams,
  updateProfileSchema,
} from "./profile.schema";
import { accountService } from "./account.service";
import { REFRESH_COOKIE, refreshCookieOptions, sessionsService } from "../auth/sessions.service";

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

// Foto de perfil (B12). La firma real del archivo la verifica avatarService
// con la misma tabla de "magic bytes" que los documentos.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!(AVATAR_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      cb(new ApiError(415, "La foto debe ser una imagen PNG o JPG."));
      return;
    }
    cb(null, true);
  },
});

usersRouter.post(
  "/me/avatar",
  avatarLimiter,
  avatarUpload.single("avatar"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, "Falta la foto (campo avatar).");
    const result = await avatarService.set(req.user!.userId, req.file);
    audit(req, { action: "user.avatar.update", entity: "user", entityId: req.user!.userId });
    res.status(201).json(result);
  })
);

usersRouter.delete(
  "/me/avatar",
  asyncHandler(async (req, res) => {
    await avatarService.remove(req.user!.userId);
    audit(req, { action: "user.avatar.remove", entity: "user", entityId: req.user!.userId });
    res.status(204).end();
  })
);

/**
 * La imagen, solo para la propia cuenta. El navegador la pide con fetch (lleva
 * el token) y la muestra como blob:. Encabezados: el tipo real (el que validó
 * la firma), nosniff (helmet) y una CSP que no permite nada por si alguien
 * abriera la URL directamente con un archivo "políglota".
 */
usersRouter.get(
  "/me/avatar",
  asyncHandler(async (req, res) => {
    const { buffer, contentType } = await avatarService.read(req.user!.userId);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Content-Disposition", "inline");
    res.send(buffer);
  })
);

/**
 * Sesiones activas (B13). Ownership por construcción: solo las de
 * req.user.userId; la actual se reconoce por el sid del access token.
 */
usersRouter.get(
  "/me/sessions",
  asyncHandler(async (req, res) => {
    res.json(await sessionsService.list(req.user!.userId, req.user!.sid));
  })
);

usersRouter.delete(
  "/me/sessions/:sessionId",
  validate({ params: sessionParams }),
  asyncHandler(async (req, res) => {
    const sessionId = req.params.sessionId as string;
    await sessionsService.close(req.user!.userId, req.user!.sid, sessionId);
    audit(req, { action: "user.session.close", entity: "session", entityId: sessionId });
    res.status(204).end();
  })
);

/** Cierra todas las demás sesiones (la actual sigue abierta). */
usersRouter.delete(
  "/me/sessions",
  asyncHandler(async (req, res) => {
    const closed = await sessionsService.closeOthers(req.user!.userId, req.user!.sid);
    audit(req, { action: "user.session.close_others", entity: "user", entityId: req.user!.userId });
    res.json({ closed });
  })
);

/**
 * Exportar mis datos (B14): JSON descargable. POST porque lleva la
 * contraseña en el cuerpo (nunca en la URL).
 */
usersRouter.post(
  "/me/export",
  profileLimiter,
  validate({ body: exportDataSchema }),
  asyncHandler(async (req, res) => {
    const data = await accountService.exportData(req.user!.userId, req.user!.sid, req.body.password);
    audit(req, { action: "user.data.export", entity: "user", entityId: req.user!.userId });
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename="renta-ia-mis-datos-${day}.json"`);
    res.setHeader("Cache-Control", "no-store");
    res.json(data);
  })
);

/** ¿Se puede eliminar la cuenta? (contador con clientes, único admin → no, y por qué). */
usersRouter.get(
  "/me/deletion",
  asyncHandler(async (req, res) => {
    res.json(await accountService.deletionStatus(req.user!.userId));
  })
);

/**
 * Eliminar mi cuenta (B14). Irreversible: contraseña + segundo factor si lo
 * tiene. Queda una lápida anónima (ver account.service y docs/data-retention.md);
 * se cierran todas las sesiones y se borra la cookie de esta.
 */
usersRouter.post(
  "/me/deletion",
  profileLimiter,
  validate({ body: deleteAccountSchema }),
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId;
    // El registro de la eliminación lo escribe el servicio, ya recortado (data-retention.md).
    await accountService.deleteAccount(userId, req.body.password, req.body.code, {
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });
    const { maxAge: _maxAge, ...cookie } = refreshCookieOptions();
    res.clearCookie(REFRESH_COOKIE, cookie);
    res.status(204).end();
  })
);

usersRouter.use("/me/mfa", mfaRouter);
