import { describe, expect, it } from "vitest";
import { computeTotals, estimateBalance, SummaryTotals } from "../../src/modules/clients/summary.service";
import { taxRules } from "../../src/config/taxConfig";

const rules = { ...taxRules.rentaPersonasNaturales, uvtPorAnioGravable: { "2025": 49799 } };
const totals = (overrides: Partial<SummaryTotals> = {}): SummaryTotals => ({
  grossIncome: 85_000_000,
  withholding: 6_200_000,
  deductions: 10_000_000,
  pensionContribution: 3_400_000,
  healthContribution: 3_400_000,
  other: 0,
  ...overrides,
});

describe("computeTotals", () => {
  it("suma por tipo de concepto (montos Decimal llegan como string u objeto)", () => {
    expect(
      computeTotals([
        { conceptType: "gross_income", amount: "50000000.50" },
        { conceptType: "gross_income", amount: 35_000_000 },
        { conceptType: "withholding", amount: "6200000" },
        { conceptType: "deduction", amount: 1_000_000 },
        { conceptType: "other", amount: 10 },
      ])
    ).toEqual({
      grossIncome: 85_000_000.5,
      withholding: 6_200_000,
      deductions: 1_000_000,
      pensionContribution: 0,
      healthContribution: 0,
      other: 10,
    });
  });
});

describe("estimateBalance (cálculo determinista, verificado a mano)", () => {
  it("caso base: tramo del 19%", () => {
    // Cuenta a mano:
    //   ingresos netos = 85.000.000 − 3.400.000 − 3.400.000 = 78.200.000
    //   deducciones: min(10.000.000; 40% × 78.200.000 = 31.280.000; 1.340 × 49.799 = 66.730.660) = 10.000.000
    //   base = 68.200.000 → 68.200.000 / 49.799 = 1.369,5054 UVT (tramo 1.090–1.700, 19%)
    //   impuesto = (1.369,5054 − 1.090) × 0,19 = 53,1060 UVT × 49.799 = 2.644.627 → 2.645.000
    //   saldo = 2.645.000 − 6.200.000 = −3.555.000 (saldo a favor)
    expect(estimateBalance(totals(), 2025, rules)).toEqual({
      uvtValue: 49799,
      netIncome: 78_200_000,
      deductionsApplied: 10_000_000,
      taxableBase: 68_200_000,
      estimatedTax: 2_645_000,
      estimatedBalance: -3_555_000,
      rulesVerified: false,
    });
  });

  it("aplica el tope del 40% a las deducciones", () => {
    expect(estimateBalance(totals({ deductions: 50_000_000 }), 2025, rules)!.deductionsApplied).toBe(31_280_000);
  });

  it("aplica el tope de 1.340 UVT a las deducciones", () => {
    const high = totals({ grossIncome: 500_000_000, deductions: 150_000_000 });
    expect(estimateBalance(high, 2025, rules)!.deductionsApplied).toBe(1340 * 49799);
  });

  it("base menor a 1.090 UVT: impuesto 0 y todo lo retenido es saldo a favor", () => {
    const low = estimateBalance(totals({ grossIncome: 40_000_000, withholding: 500_000 }), 2025, rules)!;
    expect(low.estimatedTax).toBe(0);
    expect(low.estimatedBalance).toBe(-500_000);
  });

  it("devuelve null si no hay UVT configurada para el año", () => {
    expect(estimateBalance(totals(), 2019, rules)).toBeNull();
  });

  it("marca si los parámetros no están verificados contra la normativa", () => {
    expect(estimateBalance(totals(), 2025, { ...rules, verificado: true })!.rulesVerified).toBe(true);
  });
});
