import { NextFunction, Request, Response, Router } from "express";
import multer from "multer";
import { documentsController } from "./documents.controller";
import { createDocumentSchema, documentClientParams, documentIdParams, uploadDocumentSchema } from "./documents.schema";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireClientAccess } from "../../middlewares/ownership.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { uploadLimiter } from "../../middlewares/rateLimit.middleware";
import { asyncHandler } from "../../utils/asyncHandler";
import { ApiError } from "../../utils/apiError";
import { MAX_UPLOAD_BYTES, hasValidSignature, isAllowedMimeAndExtension } from "../../utils/fileType";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!isAllowedMimeAndExtension(file.mimetype, file.originalname)) {
      cb(new ApiError(415, "Tipo de archivo no permitido. Solo se aceptan PDF, PNG o JPG."));
      return;
    }
    cb(null, true);
  },
});

// El MIME lo declara el cliente; aquí se confirma con el contenido real.
function checkFileSignature(req: Request, _res: Response, next: NextFunction) {
  if (req.file && !hasValidSignature(req.file.mimetype, req.file.buffer)) {
    throw new ApiError(415, "El contenido del archivo no corresponde a su tipo (PDF, PNG o JPG).");
  }
  next();
}

export const documentsRouter = Router();

documentsRouter.use(authMiddleware);

documentsRouter.post(
  "/",
  validate({ body: createDocumentSchema }),
  requireClientAccess("body", "clientId"),
  asyncHandler(documentsController.create)
);
// Orden: límite por usuario → multer (llena req.body en multipart) →
// firma del archivo → validación de campos → verificación de dueño.
documentsRouter.post(
  "/upload",
  uploadLimiter,
  upload.single("file"),
  checkFileSignature,
  validate({ body: uploadDocumentSchema }),
  requireClientAccess("body", "clientId"),
  asyncHandler(documentsController.upload)
);
documentsRouter.get(
  "/client/:clientId",
  validate({ params: documentClientParams }),
  requireClientAccess("params", "clientId"),
  asyncHandler(documentsController.listByClient)
);
documentsRouter.get("/:id", validate({ params: documentIdParams }), asyncHandler(documentsController.getById));
// Reintentar el análisis con IA. Cuesta lo mismo que una subida: mismo límite.
documentsRouter.post(
  "/:id/reprocess",
  uploadLimiter,
  validate({ params: documentIdParams }),
  asyncHandler(documentsController.reprocess)
);
