import { describe, expect, it } from "vitest";
import { createClient, createDocument, registerUser } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { findExogenousMismatches, rulesService } from "../../src/modules/ai/rules.service";

/** Cliente nuevo con ingreso bruto y deducciones dados. */
async function clientWith(grossIncome: number, deductions: number) {
  const user = await registerUser();
  const client = await createClient(user.token);
  const document = await createDocument(client.id, user.user.id);
  await prisma.taxConcept.createMany({
    data: [
      {
        documentId: document.id,
        clientId: client.id,
        conceptType: "gross_income",
        amount: grossIncome,
        periodYear: 2025,
      },
      { documentId: document.id, clientId: client.id, conceptType: "deduction", amount: deductions, periodYear: 2025 },
    ],
  });
  return { clientId: client.id, documentId: document.id };
}

const inconsistencyAlerts = (clientId: string) =>
  prisma.alert.findMany({ where: { clientId, alertType: "inconsistency" } });

describe("rulesService: deducciones > 40% del ingreso bruto", () => {
  it("crea una alerta high si las deducciones superan el 40%", async () => {
    const { clientId, documentId } = await clientWith(1_000_000, 400_001);
    await rulesService.evaluateClientConcepts(clientId, documentId);

    const alerts = await inconsistencyAlerts(clientId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("high");
    expect(alerts[0]!.status).toBe("open");
  });

  it("no crea alerta si las deducciones son exactamente el 40%", async () => {
    const { clientId, documentId } = await clientWith(1_000_000, 400_000);
    await rulesService.evaluateClientConcepts(clientId, documentId);
    expect(await inconsistencyAlerts(clientId)).toHaveLength(0);
  });

  it("no crea alerta si no hay ingreso bruto (evita dividir por cero)", async () => {
    const { clientId, documentId } = await clientWith(0, 500_000);
    await rulesService.evaluateClientConcepts(clientId, documentId);
    expect(await inconsistencyAlerts(clientId)).toHaveLength(0);
  });
});

describe("rulesService: sin alertas duplicadas", () => {
  it("evaluar de nuevo deja una sola alerta abierta, con las cifras actualizadas", async () => {
    const { clientId, documentId } = await clientWith(1_000_000, 500_000);
    await rulesService.evaluateClientConcepts(clientId, documentId);

    // Un segundo documento suma 100.000 más en deducciones.
    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const secondDoc = await createDocument(clientId, client.accountantUserId);
    await prisma.taxConcept.create({
      data: { documentId: secondDoc.id, clientId, conceptType: "deduction", amount: 100_000, periodYear: 2025 },
    });
    await rulesService.evaluateClientConcepts(clientId, secondDoc.id);

    const alerts = await inconsistencyAlerts(clientId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.documentId).toBe(secondDoc.id);
    expect(alerts[0]!.message).toContain("600.000");
  });

  it("si la alerta anterior ya se resolvió, se crea una nueva", async () => {
    const { clientId, documentId } = await clientWith(1_000_000, 500_000);
    await rulesService.evaluateClientConcepts(clientId, documentId);
    await prisma.alert.updateMany({ where: { clientId }, data: { status: "resolved" } });

    await rulesService.evaluateClientConcepts(clientId, documentId);
    const alerts = await inconsistencyAlerts(clientId);
    expect(alerts.map((a) => a.status).sort()).toEqual(["open", "resolved"]);
  });
});

describe("findExogenousMismatches (función pura)", () => {
  const c = (
    docType: "exogenous_info" | "income_certificate" | "bank_statement",
    amount: number,
    periodYear = 2025,
    conceptType = "gross_income"
  ) => ({
    docType,
    amount,
    periodYear,
    conceptType,
  });

  it("detecta una diferencia mayor que la tolerancia", () => {
    expect(findExogenousMismatches([c("exogenous_info", 100), c("income_certificate", 80)], 0.05)).toEqual([
      { periodYear: 2025, exogenousTotal: 100, certificateTotal: 80, differenceRatio: 0.2 },
    ]);
  });

  it("no alerta dentro de la tolerancia (ni exactamente en el límite)", () => {
    expect(findExogenousMismatches([c("exogenous_info", 100), c("income_certificate", 95)], 0.05)).toEqual([]);
  });

  it("suma varios certificados del mismo año antes de comparar", () => {
    const concepts = [c("exogenous_info", 100), c("income_certificate", 60), c("income_certificate", 40)];
    expect(findExogenousMismatches(concepts, 0.05)).toEqual([]);
  });

  it("no compara si falta uno de los dos tipos de documento", () => {
    expect(findExogenousMismatches([c("exogenous_info", 100)], 0.05)).toEqual([]);
    expect(findExogenousMismatches([c("income_certificate", 100)], 0.05)).toEqual([]);
  });

  it("compara por año e ignora otros conceptos y otros tipos de documento", () => {
    const concepts = [
      c("exogenous_info", 100, 2024),
      c("income_certificate", 100, 2024),
      c("exogenous_info", 200, 2025),
      c("income_certificate", 100, 2025),
      c("bank_statement", 999, 2025),
      c("income_certificate", 999, 2025, "withholding"),
    ];
    expect(findExogenousMismatches(concepts, 0.05).map((m) => m.periodYear)).toEqual([2025]);
  });
});
