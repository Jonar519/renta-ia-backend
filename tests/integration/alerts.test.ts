import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, createClient, createDocument, registerUser, unique } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { parseTaxCalendar } from "../../src/config/taxConfig";
import { runDeadlineCheck } from "../../src/modules/alerts/deadlines.service";
import { alertsService } from "../../src/modules/alerts/alerts.service";
import { rulesService } from "../../src/modules/ai/rules.service";

// Calendario de PRUEBA (no el de ejemplo del repo): todos los dígitos vencen
// el 2026-09-30, así los tests no dependen del archivo editable.
const testCalendar = parseTaxCalendar({
  esEjemplo: false,
  zonaHoraria: "America/Bogota",
  diasDeAnticipacion: 60,
  umbralesSeveridad: { critical: 7, high: 15, medium: 30 },
  declaracionRentaPersonasNaturales: { "2025": [{ desde: "00", hasta: "99", vence: "2026-09-30" }] },
});
const at = (iso: string) => new Date(`${iso}T12:00:00Z`); // mediodía UTC = mañana en Bogotá

async function clientWithDocumentNumber(documentNumber: string) {
  const { token } = await registerUser();
  const res = await request(app)
    .post("/api/clients")
    .set(authHeader(token))
    .send({ fullName: "Cliente vencimientos", documentNumber });
  return res.body.id as string;
}

const deadlineAlerts = (clientId: string) =>
  prisma.alert.findMany({ where: { clientId, alertType: "deadline" }, orderBy: { createdAt: "asc" } });

describe("Job de alertas de vencimiento", () => {
  it("no crea nada fuera de la ventana de anticipación", async () => {
    const clientId = await clientWithDocumentNumber(`90${unique().replace(/\D/g, "")}`);
    await runDeadlineCheck({ now: at("2026-07-01"), calendar: testCalendar, clientIds: [clientId] }); // faltan 91 días
    expect(await deadlineAlerts(clientId)).toHaveLength(0);
  });

  it("crea la alerta dentro de la ventana y la escala sin duplicarla", async () => {
    const clientId = await clientWithDocumentNumber(`91${unique().replace(/\D/g, "")}`);
    const run = (iso: string) => runDeadlineCheck({ now: at(iso), calendar: testCalendar, clientIds: [clientId] });

    expect((await run("2026-08-10")).created).toBe(1); // 51 días
    let alerts = await deadlineAlerts(clientId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "low", status: "open", dedupeKey: "deadline:2025" });
    expect(alerts[0]!.dueDate?.toISOString().slice(0, 10)).toBe("2026-09-30");
    expect(alerts[0]!.message).toContain("faltan 51 días");

    expect((await run("2026-08-10")).updated).toBe(1); // misma fecha, segunda corrida: no duplica
    await run("2026-09-05"); // 25 días
    await run("2026-09-20"); // 10 días
    alerts = await deadlineAlerts(clientId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("high");

    await run("2026-10-02"); // vencida
    alerts = await deadlineAlerts(clientId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.message).toContain("venció el 30/09/2026");
  });

  it("no recrea una alerta que el contador ya resolvió", async () => {
    const clientId = await clientWithDocumentNumber(`92${unique().replace(/\D/g, "")}`);
    const run = () => runDeadlineCheck({ now: at("2026-09-20"), calendar: testCalendar, clientIds: [clientId] });
    await run();
    await prisma.alert.updateMany({ where: { clientId }, data: { status: "resolved" } });

    const result = await run();
    expect(result.skippedResolved).toBe(1);
    expect(await deadlineAlerts(clientId)).toHaveLength(1);
  });

  it("con el calendario de ejemplo del repo, el mensaje advierte que la fecha no es oficial", async () => {
    const clientId = await clientWithDocumentNumber(`93${unique().replace(/\D/g, "")}`);
    const example = { ...testCalendar, esEjemplo: true };
    await runDeadlineCheck({ now: at("2026-09-20"), calendar: example, clientIds: [clientId] });
    const [alert] = await deadlineAlerts(clientId);
    expect(alert!.message).toMatch(/Fecha de EJEMPLO.*no es el oficial de la DIAN/);
  });
});

describe("Deduplicación de alertas (carrera entre jobs)", () => {
  it("dos upserts simultáneos de la misma situación dejan UNA sola alerta activa", async () => {
    const { token } = await registerUser();
    const clientId = (await createClient(token)).id;
    const input = {
      clientId,
      dedupeKey: "deductions_over_limit",
      alertType: "inconsistency" as const,
      severity: "high" as const,
      message: "carrera",
    };
    await Promise.all(Array.from({ length: 5 }, () => alertsService.upsertActiveAlert(input)));
    expect(await prisma.alert.count({ where: { clientId, dedupeKey: "deductions_over_limit" } })).toBe(1);
  });

  it("la base rechaza una segunda alerta activa con la misma dedupe_key", async () => {
    const { token } = await registerUser();
    const clientId = (await createClient(token)).id;
    const data = { clientId, dedupeKey: "x", alertType: "inconsistency" as const, message: "m" };
    await prisma.alert.create({ data });
    await expect(prisma.alert.create({ data })).rejects.toMatchObject({ code: "P2002" });
    // Resuelta ya no cuenta: se puede crear otra.
    await prisma.alert.updateMany({ where: { clientId }, data: { status: "resolved" } });
    await expect(prisma.alert.create({ data })).resolves.toBeDefined();
  });
});

describe("PATCH /api/alerts/:id", () => {
  let tokenA: string;
  let tokenB: string;
  let alertId: string;

  beforeAll(async () => {
    tokenA = (await registerUser()).token;
    tokenB = (await registerUser()).token;
    const clientId = (await createClient(tokenA)).id;
    alertId = (await prisma.alert.create({ data: { clientId, alertType: "inconsistency", message: "revisar" } })).id;
  });

  const patch = (token: string, id: string, body: object) =>
    request(app).patch(`/api/alerts/${id}`).set(authHeader(token)).send(body);

  it("otro contador recibe 404", async () => {
    expect((await patch(tokenB, alertId, { status: "acknowledged" })).status).toBe(404);
  });

  it("valida el estado", async () => {
    const res = await patch(tokenA, alertId, { status: "open" });
    expect(res.status).toBe(400);
  });

  it("open → acknowledged → resolved, y resolved es final", async () => {
    const ack = await patch(tokenA, alertId, { status: "acknowledged" });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ status: "acknowledged", resolvedAt: null });

    const resolved = await patch(tokenA, alertId, { status: "resolved" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.resolvedAt).toEqual(expect.any(String));

    expect((await patch(tokenA, alertId, { status: "acknowledged" })).status).toBe(409);
  });

  it("POST /api/alerts/deadlines/run es solo para admin", async () => {
    expect((await request(app).post("/api/alerts/deadlines/run").set(authHeader(tokenA))).status).toBe(403);
  });
});

describe("Regla exógena vs. certificado de ingresos (integración)", () => {
  async function clientWithIncomes(exogenous: number, certificate: number) {
    const user = await registerUser();
    const clientId = (await createClient(user.token)).id;
    for (const [docType, amount] of [
      ["exogenous_info", exogenous],
      ["income_certificate", certificate],
    ] as const) {
      const doc = await createDocument(clientId, user.user.id);
      await prisma.document.update({ where: { id: doc.id }, data: { docType } });
      await prisma.taxConcept.create({
        data: { documentId: doc.id, clientId, conceptType: "gross_income", amount, periodYear: 2025 },
      });
    }
    return clientId;
  }

  it("alerta si difieren más de la tolerancia y no duplica al reevaluar", async () => {
    const clientId = await clientWithIncomes(100_000_000, 80_000_000); // 20% > 5%
    const doc = await prisma.document.findFirstOrThrow({ where: { clientId } });
    await rulesService.evaluateClientConcepts(clientId, doc.id);
    await rulesService.evaluateClientConcepts(clientId, doc.id);

    const alerts = await prisma.alert.findMany({ where: { clientId, dedupeKey: "exogenous_mismatch:2025" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toContain("difieren 20%");
  });

  it("no alerta si la diferencia está dentro de la tolerancia", async () => {
    const clientId = await clientWithIncomes(100_000_000, 97_000_000); // 3%
    const doc = await prisma.document.findFirstOrThrow({ where: { clientId } });
    await rulesService.evaluateClientConcepts(clientId, doc.id);
    expect(await prisma.alert.count({ where: { clientId, dedupeKey: { startsWith: "exogenous" } } })).toBe(0);
  });
});
