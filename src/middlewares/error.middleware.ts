import { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { MulterError } from "multer";
import { logger } from "../config/logger";
import { ApiError } from "../utils/apiError";

/**
 * Traduce errores conocidos (Prisma, multer, body-parser) a respuestas
 * 4xx. Todo lo demás es un 500 genérico: el detalle solo va al log.
 */
function toApiError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err;

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case "P2002":
        return new ApiError(409, "Ya existe un registro con esos datos");
      case "P2003":
        return new ApiError(400, "La operación hace referencia a un registro que no existe o está en uso");
      case "P2025":
        return new ApiError(404, "Registro no encontrado");
      case "P2023":
        return new ApiError(400, "Identificador con formato inválido");
      case "P2010":
        // Consultas SQL crudas ($queryRaw): cast inválido a uuid.
        if (err.message.includes("invalid input syntax for type uuid")) {
          return new ApiError(400, "Identificador con formato inválido");
        }
        return null;
      default:
        return null;
    }
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    return new ApiError(400, "Datos inválidos");
  }

  if (err instanceof MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return new ApiError(413, "El archivo supera el tamaño máximo permitido (15 MB)");
    return new ApiError(400, `Error en la subida del archivo (${err.code})`);
  }

  // Errores de express.json(): JSON mal formado o demasiado grande.
  const bodyErr = err as { type?: string };
  if (bodyErr?.type === "entity.parse.failed") return new ApiError(400, "El cuerpo de la petición no es JSON válido");
  if (bodyErr?.type === "entity.too.large") return new ApiError(413, "El cuerpo de la petición es demasiado grande");

  return null;
}

/**
 * Qué se loguea de un error inesperado. Los mensajes de Prisma pueden
 * incluir los argumentos de la consulta (p. ej. un passwordHash), así que
 * de ellos solo se guarda el código y el modelo, nunca el mensaje.
 */
function describeForLog(err: unknown) {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return { name: err.name, code: err.code, model: err.meta?.modelName };
  }
  if (err instanceof Prisma.PrismaClientValidationError || err instanceof Prisma.PrismaClientUnknownRequestError) {
    return { name: err.name };
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}

export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const apiError = toApiError(err);
  if (apiError) {
    return res.status(apiError.statusCode).json({ error: apiError.message, details: apiError.details });
  }

  logger.error({ err: describeForLog(err), method: req.method, path: req.path }, "Error no controlado");
  return res.status(500).json({ error: "Error interno del servidor" });
}

export function notFoundMiddleware(_req: Request, res: Response) {
  res.status(404).json({ error: "Ruta no encontrada" });
}
