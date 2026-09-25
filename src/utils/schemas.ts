import { z } from "zod";
import { isUuid } from "./uuid";

// Piezas de validación compartidas por los *.schema.ts de cada módulo.

// Mensajes de error de zod en español (los usuarios de la API los ven en
// `details`). Los mensajes personalizados de cada schema tienen prioridad.
z.setErrorMap((issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return { message: issue.received === "undefined" ? "Campo requerido" : `Se esperaba ${issue.expected}` };
    case z.ZodIssueCode.too_small:
      return {
        message:
          issue.type === "string"
            ? `Debe tener al menos ${issue.minimum} caracteres`
            : `Debe ser mayor o igual a ${issue.minimum}`,
      };
    case z.ZodIssueCode.too_big:
      return {
        message:
          issue.type === "string"
            ? `Debe tener como máximo ${issue.maximum} caracteres`
            : `Debe ser menor o igual a ${issue.maximum}`,
      };
    case z.ZodIssueCode.invalid_string:
      return { message: issue.validation === "email" ? "Correo electrónico inválido" : "Formato inválido" };
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `Valor no permitido. Opciones: ${issue.options.join(", ")}` };
    default:
      return { message: ctx.defaultError };
  }
});

export const uuidSchema = z.string().refine(isUuid, { message: "Debe ser un UUID válido" });

export function uuidParams<K extends string>(key: K) {
  return z.object({ [key]: uuidSchema } as Record<K, typeof uuidSchema>);
}

/** Convierte "" (campo de formulario vacío) en undefined antes de validar. */
export function optionalText<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional()
  );
}
