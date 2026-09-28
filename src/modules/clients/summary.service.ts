import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { taxRules, TaxRules } from "../../config/taxConfig";
import { AuthPayload } from "../../middlewares/auth.middleware";
import { assertClientAccess } from "../../middlewares/ownership.middleware";
import { ApiError } from "../../utils/apiError";
import { getAiProvider } from "../../services/llm/provider";

/**
 * Resumen ejecutivo de un cliente.
 *
 * Regla de diseño: TODAS las cifras las calcula este código de forma
 * determinista (y están cubiertas por tests). El LLM solo redacta un texto a
 * partir de esas cifras ya calculadas; nunca calcula ni inventa números.
 */

export const SUMMARY_DISCLAIMER =
  "Resumen orientativo generado automáticamente a partir de los documentos cargados. No constituye " +
  "asesoría tributaria: las cifras son una estimación simplificada y deben verificarse antes de presentar la declaración.";

export interface SummaryTotals {
  grossIncome: number;
  withholding: number;
  deductions: number;
  pensionContribution: number;
  healthContribution: number;
  other: number;
}

export interface SummaryEstimate {
  uvtValue: number;
  /** Ingresos brutos − aportes obligatorios a pensión y salud. */
  netIncome: number;
  /** Deducciones aceptadas tras aplicar los topes (40% y 1.340 UVT). */
  deductionsApplied: number;
  taxableBase: number;
  estimatedTax: number;
  /** Positivo: saldo a pagar. Negativo: saldo a favor. */
  estimatedBalance: number;
  rulesVerified: boolean;
}

const round = (value: number) => Math.round(value * 100) / 100;
/** La DIAN redondea los valores de la declaración al múltiplo de 1.000 más cercano. */
const roundToThousand = (value: number) => Math.round(value / 1000) * 1000;

export function computeTotals(concepts: { conceptType: string; amount: unknown }[]): SummaryTotals {
  const sum = (type: string) =>
    round(concepts.filter((c) => c.conceptType === type).reduce((acc, c) => acc + Number(c.amount), 0));
  return {
    grossIncome: sum("gross_income"),
    withholding: sum("withholding"),
    deductions: sum("deduction"),
    pensionContribution: sum("pension_contribution"),
    healthContribution: sum("health_contribution"),
    other: sum("other"),
  };
}

/**
 * Estimación SIMPLIFICADA del impuesto (tabla del art. 241 E.T., en UVT) y
 * del saldo frente a las retenciones. null si no hay UVT configurada para
 * el año. Ver las limitaciones en tax-rules.json (_simplificacion).
 */
export function estimateBalance(
  totals: SummaryTotals,
  periodYear: number,
  rules: TaxRules["rentaPersonasNaturales"]
): SummaryEstimate | null {
  const uvtValue = rules.uvtPorAnioGravable[String(periodYear)];
  if (!uvtValue) return null;

  const netIncome = Math.max(0, totals.grossIncome - totals.pensionContribution - totals.healthContribution);
  const deductionsApplied = Math.min(
    totals.deductions,
    netIncome * rules.topeDeduccionesPorcentaje,
    rules.topeDeduccionesUvt * uvtValue
  );
  const taxableBase = Math.max(0, netIncome - deductionsApplied);

  const baseUvt = taxableBase / uvtValue;
  const bracket = rules.tablaArt241.find((b) => baseUvt > b.desdeUvt && (b.hastaUvt === null || baseUvt <= b.hastaUvt));
  const taxUvt = bracket ? (baseUvt - bracket.desdeUvt) * bracket.tarifa + bracket.baseUvt : 0;
  const estimatedTax = roundToThousand(taxUvt * uvtValue);

  return {
    uvtValue,
    netIncome: round(netIncome),
    deductionsApplied: round(deductionsApplied),
    taxableBase: round(taxableBase),
    estimatedTax,
    estimatedBalance: roundToThousand(estimatedTax - totals.withholding),
    rulesVerified: rules.verificado,
  };
}

const SUMMARY_SYSTEM_PROMPT = `Eres un asistente que redacta resúmenes ejecutivos para contadores en Colombia.
Recibes, en JSON, cifras YA CALCULADAS por el sistema a partir de los documentos de un cliente.
Redacta en español un resumen de 3 a 5 frases, claro y profesional.
Reglas estrictas:
- Usa ÚNICAMENTE las cifras del JSON, copiándolas tal cual (formato con separador de miles). No calcules, redondees ni inventes cifras nuevas.
- Si "estimacion" es null, di que no hay parámetros para estimar el saldo de ese año.
- Si "estimacion.saldoEstimado" es negativo, es un saldo a favor; si es positivo, un saldo a pagar.
- No des recomendaciones de planeación tributaria ni asesoría; indica que la estimación es simplificada y orientativa.`;

export const summaryService = {
  async generate(clientId: string, user: AuthPayload, requestedYear?: number) {
    const client = await assertClientAccess(clientId, user);

    const years = await prisma.taxConcept.findMany({
      where: { clientId },
      distinct: ["periodYear"],
      select: { periodYear: true },
      orderBy: { periodYear: "desc" },
    });
    if (years.length === 0) {
      throw new ApiError(422, "El cliente todavía no tiene conceptos tributarios extraídos para resumir");
    }
    const periodYear = requestedYear ?? years[0]!.periodYear;
    const concepts = await prisma.taxConcept.findMany({
      where: { clientId, periodYear },
      select: { conceptType: true, amount: true },
    });
    if (concepts.length === 0) {
      throw new ApiError(422, `No hay conceptos tributarios del año gravable ${periodYear}`);
    }

    const totals = computeTotals(concepts);
    const estimate = estimateBalance(totals, periodYear, taxRules.rentaPersonasNaturales);

    // El nombre del cliente NO se envía al modelo: no lo necesita para redactar.
    const payload = {
      anioGravable: periodYear,
      totales: totals,
      estimacion: estimate && {
        valorUvt: estimate.uvtValue,
        ingresosNetos: estimate.netIncome,
        deduccionesAceptadas: estimate.deductionsApplied,
        baseGravable: estimate.taxableBase,
        impuestoEstimado: estimate.estimatedTax,
        saldoEstimado: estimate.estimatedBalance,
      },
    };

    let text: string | null = null;
    let textError: string | null = null;
    try {
      const completion = await getAiProvider().complete({
        purpose: "summary",
        system: SUMMARY_SYSTEM_PROMPT,
        maxTokens: 600,
        userContent: JSON.stringify(payload),
      });
      text = completion.text;
    } catch (err) {
      // Sin crédito o sin API key: las cifras (lo importante) se devuelven igual.
      textError = err instanceof Error ? err.message : "Error desconocido";
      logger.warn({ clientId, err: textError }, "No se pudo redactar el resumen con IA");
    }

    return {
      clientId: client.id,
      periodYear,
      availableYears: years.map((y) => y.periodYear),
      totals,
      estimate,
      text,
      textError,
      disclaimer: SUMMARY_DISCLAIMER,
      generatedAt: new Date().toISOString(),
    };
  },
};
