import { DocumentType } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { taxRules } from "../../config/taxConfig";
import { alertsService } from "../alerts/alerts.service";

/**
 * Motor de reglas simplificado, con fines didácticos para el proyecto de
 * curso. Una implementación real de normativa tributaria colombiana tendría
 * muchas más reglas (topes exactos por tipo de deducción, UVT del año,
 * etc.). Aquí mostramos el patrón: comparar cifras estructuradas y generar
 * una alerta accionable. Los parámetros viven en src/config/tax-rules.json.
 */

interface ConceptForRules {
  conceptType: string;
  amount: unknown;
  periodYear: number;
  docType: DocumentType;
}

export interface ExogenousMismatch {
  periodYear: number;
  exogenousTotal: number;
  certificateTotal: number;
  differenceRatio: number;
}

/**
 * Regla exógena vs. certificado: para cada año en que el cliente tiene
 * ingresos brutos tanto en información exógena como en certificados de
 * ingresos, compara los totales. Si la diferencia relativa (sobre el mayor
 * de los dos) supera la tolerancia, es una inconsistencia.
 */
export function findExogenousMismatches(concepts: ConceptForRules[], tolerance: number): ExogenousMismatch[] {
  const totals = new Map<number, { exogenous: number; certificate: number }>();
  for (const c of concepts) {
    if (c.conceptType !== "gross_income") continue;
    if (c.docType !== "exogenous_info" && c.docType !== "income_certificate") continue;
    const entry = totals.get(c.periodYear) ?? { exogenous: 0, certificate: 0 };
    if (c.docType === "exogenous_info") entry.exogenous += Number(c.amount);
    else entry.certificate += Number(c.amount);
    totals.set(c.periodYear, entry);
  }

  const mismatches: ExogenousMismatch[] = [];
  for (const [periodYear, { exogenous, certificate }] of totals) {
    if (exogenous <= 0 || certificate <= 0) continue; // falta uno de los dos: no hay nada que comparar
    const differenceRatio = Math.abs(exogenous - certificate) / Math.max(exogenous, certificate);
    if (differenceRatio > tolerance) {
      mismatches.push({ periodYear, exogenousTotal: exogenous, certificateTotal: certificate, differenceRatio });
    }
  }
  return mismatches.sort((a, b) => a.periodYear - b.periodYear);
}

export const rulesService = {
  async evaluateClientConcepts(clientId: string, documentId: string): Promise<void> {
    const rows = await prisma.taxConcept.findMany({
      where: { clientId },
      select: { conceptType: true, amount: true, periodYear: true, document: { select: { docType: true } } },
    });
    const concepts: ConceptForRules[] = rows.map((r) => ({ ...r, docType: r.document.docType }));

    // Regla 1: deducciones sobre el ingreso bruto acumulado.
    const limit = taxRules.limiteDeduccionesSobreIngresoBruto;
    const grossIncome = sumByType(concepts, "gross_income");
    const deductions = sumByType(concepts, "deduction");

    if (grossIncome > 0 && deductions / grossIncome > limit) {
      await alertsService.upsertActiveAlert({
        clientId,
        dedupeKey: "deductions_over_limit",
        documentId,
        alertType: "inconsistency",
        severity: "high",
        message:
          `Las deducciones reportadas ($${formatCOP(deductions)}) superan el ` +
          `${Math.round(limit * 100)}% del ingreso bruto acumulado ` +
          `($${formatCOP(grossIncome)}). Revisar manualmente antes de declarar.`,
      });
    }

    // Regla 2: información exógena vs. certificados de ingresos, por año.
    const tolerance = taxRules.toleranciaExogenaVsCertificado;
    for (const m of findExogenousMismatches(concepts, tolerance)) {
      await alertsService.upsertActiveAlert({
        clientId,
        dedupeKey: `exogenous_mismatch:${m.periodYear}`,
        documentId,
        alertType: "inconsistency",
        severity: "high",
        message:
          `Año gravable ${m.periodYear}: los ingresos reportados en la información exógena ` +
          `($${formatCOP(m.exogenousTotal)}) difieren ${formatPercent(m.differenceRatio)} de los ` +
          `certificados de ingresos ($${formatCOP(m.certificateTotal)}); la tolerancia es ` +
          `${formatPercent(tolerance)}. Verificar si falta un certificado o si terceros reportaron de más.`,
      });
    }
  },
};

function sumByType(concepts: { conceptType: string; amount: unknown }[], type: string): number {
  return concepts.filter((c) => c.conceptType === type).reduce((sum, c) => sum + Number(c.amount), 0);
}

function formatCOP(value: number): string {
  return value.toLocaleString("es-CO");
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toLocaleString("es-CO", { maximumFractionDigits: 1 })}%`;
}
