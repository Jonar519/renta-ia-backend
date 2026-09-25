import { prisma } from "../../config/prisma";

/**
 * Motor de reglas simplificado, con fines didácticos para el proyecto de
 * curso. Una implementación real de normativa tributaria colombiana tendría
 * muchas más reglas (topes exactos por tipo de deducción, UVT del año,
 * comparación contra exógena reportada por terceros, etc.). Aquí mostramos
 * el patrón: comparar cifras estructuradas y generar una alerta accionable.
 */
const DEDUCTION_LIMIT_RATIO = 0.4; // ejemplo: deducciones no deberían superar 40% del ingreso bruto

export const rulesService = {
  async evaluateClientConcepts(clientId: string, documentId: string): Promise<void> {
    const concepts = await prisma.taxConcept.findMany({ where: { clientId } });

    const grossIncome = sumByType(concepts, "gross_income");
    const deductions = sumByType(concepts, "deduction");

    if (grossIncome > 0 && deductions / grossIncome > DEDUCTION_LIMIT_RATIO) {
      const message =
        `Las deducciones reportadas ($${formatCOP(deductions)}) superan el ` +
        `${Math.round(DEDUCTION_LIMIT_RATIO * 100)}% del ingreso bruto acumulado ` +
        `($${formatCOP(grossIncome)}). Revisar manualmente antes de declarar.`;

      // Una sola alerta de inconsistencia abierta por cliente: si ya existe,
      // se actualiza con las cifras actuales en vez de crear otra igual con
      // cada documento nuevo.
      const existing = await prisma.alert.findFirst({
        where: { clientId, alertType: "inconsistency", status: "open" },
        orderBy: { createdAt: "desc" },
      });

      if (existing) {
        await prisma.alert.update({ where: { id: existing.id }, data: { documentId, severity: "high", message } });
      } else {
        await prisma.alert.create({
          data: { clientId, documentId, alertType: "inconsistency", severity: "high", status: "open", message },
        });
      }
    }
  },
};

function sumByType(concepts: { conceptType: string; amount: unknown }[], type: string): number {
  return concepts.filter((c) => c.conceptType === type).reduce((sum, c) => sum + Number(c.amount), 0);
}

function formatCOP(value: number): string {
  return value.toLocaleString("es-CO");
}
