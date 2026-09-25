import { describe, expect, it } from "vitest";
import { createClient, createDocument, registerUser } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { rulesService } from "../../src/modules/ai/rules.service";

/** Cliente nuevo con ingreso bruto y deducciones dados. */
async function clientWith(grossIncome: number, deductions: number) {
  const user = await registerUser();
  const client = await createClient(user.token);
  const document = await createDocument(client.id, user.user.id);
  await prisma.taxConcept.createMany({
    data: [
      { documentId: document.id, clientId: client.id, conceptType: "gross_income", amount: grossIncome, periodYear: 2025 },
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
