import fs from "fs";
import { z } from "zod";
import defaultCalendar from "./tax-calendar.json";
import defaultRules from "./tax-rules.json";

/**
 * Configuración tributaria editable (JSON). Por defecto se usan los archivos
 * de src/config/; con TAX_CALENDAR_PATH / TAX_RULES_PATH se puede apuntar a
 * otros archivos sin recompilar (útil en producción).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha en formato AAAA-MM-DD");
const twoDigits = z.string().regex(/^\d{2}$/, "Dos dígitos, de 00 a 99");

const calendarSchema = z
  .object({
    esEjemplo: z.boolean(),
    zonaHoraria: z.string(),
    diasDeAnticipacion: z.number().int().positive(),
    umbralesSeveridad: z.object({
      critical: z.number().int().nonnegative(),
      high: z.number().int().nonnegative(),
      medium: z.number().int().nonnegative(),
    }),
    declaracionRentaPersonasNaturales: z.record(
      z.string(),
      z.union([z.string(), z.array(z.object({ desde: twoDigits, hasta: twoDigits, vence: isoDate }))])
    ),
  })
  .transform((raw) => {
    // Descarta las claves de documentación ("_descripcion") y deja solo los años.
    const years: Record<string, { desde: string; hasta: string; vence: string }[]> = {};
    for (const [key, value] of Object.entries(raw.declaracionRentaPersonasNaturales)) {
      if (/^\d{4}$/.test(key) && Array.isArray(value)) years[key] = value;
    }
    return { ...raw, declaracionRentaPersonasNaturales: years };
  })
  .superRefine((calendar, ctx) => {
    for (const [year, ranges] of Object.entries(calendar.declaracionRentaPersonasNaturales)) {
      const covered = new Array<number>(100).fill(0);
      for (const { desde, hasta } of ranges) {
        for (let d = Number(desde); d <= Number(hasta); d++) covered[d]! += 1;
      }
      const missing = covered.flatMap((count, digit) => (count === 0 ? [digit] : []));
      const repeated = covered.flatMap((count, digit) => (count > 1 ? [digit] : []));
      if (missing.length || repeated.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Año ${year}: los rangos deben cubrir 00-99 exactamente una vez (faltan: ${missing.join(",") || "ninguno"}; repetidos: ${repeated.join(",") || "ninguno"})`,
        });
      }
    }
  });

const rulesSchema = z.object({
  limiteDeduccionesSobreIngresoBruto: z.number().positive(),
  toleranciaExogenaVsCertificado: z.number().nonnegative(),
  rentaPersonasNaturales: z.object({
    verificado: z.boolean(),
    topeDeduccionesUvt: z.number().positive(),
    topeDeduccionesPorcentaje: z.number().positive(),
    uvtPorAnioGravable: z.record(z.string().regex(/^\d{4}$/), z.number().positive()),
    tablaArt241: z
      .array(
        z.object({
          desdeUvt: z.number().nonnegative(),
          hastaUvt: z.number().positive().nullable(),
          tarifa: z.number().min(0).max(1),
          baseUvt: z.number().nonnegative(),
        })
      )
      .min(1),
  }),
});

export type TaxCalendar = z.infer<typeof calendarSchema>;
export type TaxRules = z.infer<typeof rulesSchema>;

function load<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, fallback: unknown, pathEnv: string, label: string): T {
  const path = process.env[pathEnv];
  const raw = path ? JSON.parse(fs.readFileSync(path, "utf8")) : fallback;
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join(" | ");
    throw new Error(`Configuración tributaria inválida en ${path ?? label}: ${issues}`);
  }
  return result.data;
}

export function parseTaxCalendar(raw: unknown): TaxCalendar {
  return load(calendarSchema, raw, "__NO_PATH__", "calendario");
}

export const taxCalendar: TaxCalendar = load(calendarSchema, defaultCalendar, "TAX_CALENDAR_PATH", "tax-calendar.json");
export const taxRules: TaxRules = load(rulesSchema, defaultRules, "TAX_RULES_PATH", "tax-rules.json");

// Tolerancia de la regla exógena vs. certificado, sobreescribible por entorno.
if (process.env.EXOGENOUS_TOLERANCE_RATIO !== undefined) {
  const value = Number(process.env.EXOGENOUS_TOLERANCE_RATIO);
  if (!Number.isFinite(value) || value < 0) throw new Error("EXOGENOUS_TOLERANCE_RATIO debe ser un número >= 0");
  taxRules.toleranciaExogenaVsCertificado = value;
}
