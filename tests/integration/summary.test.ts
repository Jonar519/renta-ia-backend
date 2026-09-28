import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { app, authHeader, createClient, createDocument, registerUser, TEST_PASSWORD, unique } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { SUMMARY_DISCLAIMER } from "../../src/modules/clients/summary.service";

// Anthropic mockeado: sin llamadas reales ni consumo de crédito.
const { createMessage } = vi.hoisted(() => ({ createMessage: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: createMessage } })),
}));

describe("POST /api/clients/:id/summary", () => {
  let token: string;
  let clientId: string;
  let clientName: string;

  beforeAll(async () => {
    const user = await registerUser();
    token = user.token;
    const client = await createClient(token);
    clientId = client.id;
    clientName = (await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).fullName;
    const doc = await createDocument(clientId, user.user.id);
    await prisma.taxConcept.createMany({
      data: [
        { documentId: doc.id, clientId, conceptType: "gross_income", amount: 85_000_000, periodYear: 2025 },
        { documentId: doc.id, clientId, conceptType: "withholding", amount: 6_200_000, periodYear: 2025 },
        { documentId: doc.id, clientId, conceptType: "gross_income", amount: 10_000_000, periodYear: 2024 },
      ],
    });
  });

  // Cuerpo de bloque a propósito: si beforeEach DEVUELVE una función, Vitest la
  // ejecuta como teardown (y mockReset() devuelve el propio mock).
  beforeEach(() => {
    createMessage.mockReset();
  });

  const summary = (body: object = {}, t = token, id = clientId) =>
    request(app).post(`/api/clients/${id}/summary`).set(authHeader(t)).send(body);

  it("calcula los totales en código y el LLM solo recibe esas cifras para redactar", async () => {
    createMessage.mockResolvedValue({
      content: [{ type: "text", text: "Resumen redactado." }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const res = await summary();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      periodYear: 2025, // por defecto, el año más reciente
      availableYears: [2025, 2024],
      totals: { grossIncome: 85_000_000, withholding: 6_200_000, deductions: 0 },
      text: "Resumen redactado.",
      textError: null,
      disclaimer: SUMMARY_DISCLAIMER,
    });
    expect(res.body.estimate.estimatedBalance).toEqual(expect.any(Number));

    const prompt = createMessage.mock.calls[0]![0];
    const payload = JSON.parse(prompt.messages[0].content);
    expect(payload.totales.grossIncome).toBe(85_000_000);
    expect(prompt.messages[0].content).not.toContain(clientName); // no se envían datos personales
    expect(prompt.system).toMatch(/No calcules/);
  });

  it("permite elegir el año gravable", async () => {
    createMessage.mockResolvedValue({ content: [{ type: "text", text: "ok" }], usage: {} });
    const res = await summary({ periodYear: 2024 });
    expect(res.body.totals.grossIncome).toBe(10_000_000);
  });

  it("si la IA falla (p. ej. sin crédito), devuelve igual las cifras y el error de redacción", async () => {
    createMessage.mockImplementation(async () => {
      throw new Error("Your credit balance is too low");
    });
    const res = await summary();
    expect(res.status).toBe(200);
    expect(res.body.text).toBeNull();
    expect(res.body.textError).toMatch(/credit balance/);
    expect(res.body.totals.grossIncome).toBe(85_000_000);
  });

  it("422 si el año pedido no tiene conceptos, 400 si el año es inválido", async () => {
    expect((await summary({ periodYear: 2023 })).status).toBe(422);
    expect((await summary({ periodYear: 1990 })).status).toBe(400);
  });

  it("otro contador recibe 404", async () => {
    const other = await registerUser();
    expect((await summary({}, other.token)).status).toBe(404);
  });

  it("422 si el cliente no tiene conceptos", async () => {
    const empty = await createClient(token);
    expect((await summary({}, token, empty.id)).status).toBe(422);
  });
});

describe("GET /api/clients (listado del admin)", () => {
  it("el admin ve los clientes de todos los contadores, con el nombre del contador", async () => {
    const accountant = await registerUser("Contador listado");
    const client = await createClient(accountant.token);

    const email = `admin-${unique()}@test.local`;
    await prisma.user.create({
      data: { name: "Admin", email, role: "admin", passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) },
    });
    const login = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });

    const res = await request(app).get("/api/clients").set(authHeader(login.body.token));
    expect(res.status).toBe(200);
    const listed = res.body.items.find((c: { id: string }) => c.id === client.id);
    expect(listed.accountant).toEqual({ id: accountant.user.id, name: "Contador listado" });

    // Un contador sigue viendo solo los suyos.
    const own = await request(app).get("/api/clients").set(authHeader(accountant.token));
    expect(own.body).toEqual({ items: [expect.objectContaining({ id: client.id })], nextCursor: null });
  });
});
