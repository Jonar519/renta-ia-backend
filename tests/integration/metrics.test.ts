import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { app, authHeader, registerUser, TEST_PASSWORD, unique } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { metricsService } from "../../src/modules/metrics/metrics.service";

// Beacon tal como lo envía navigator.sendBeacon: text/plain con JSON adentro.
const beacon = (payload: unknown) =>
  request(app)
    .post("/api/metrics/web-vitals")
    .set("Content-Type", "text/plain;charset=UTF-8")
    .send(JSON.stringify(payload));

// Ruta exclusiva de este archivo para no mezclar muestras con otros tests.
const ROUTE = `/test-${unique().replace(/\D/g, "")}`;

describe("POST /api/metrics/web-vitals", () => {
  it("acepta un beacon text/plain y guarda cada entrada sin datos personales", async () => {
    const res = await beacon({
      device: "mobile",
      entries: [
        { name: "LCP", value: 1234.5, rating: "good", route: ROUTE, navigationType: "navigate" },
        { name: "LOAF", value: 180, route: ROUTE, attribution: "index-abc.js" },
      ],
    });
    expect(res.status).toBe(204);
    const rows = await prisma.webVital.findMany({ where: { route: ROUTE }, orderBy: { metric: "asc" } });
    expect(rows.map((r) => [r.metric, r.value, r.device])).toEqual([
      ["LCP", 1234.5, "mobile"],
      ["LOAF", 180, "mobile"],
    ]);
  });

  it("valida el payload (métrica, rango, ruta normalizada, cantidad)", async () => {
    const ok = { name: "INP", value: 10, route: ROUTE };
    expect((await beacon({ device: "desktop", entries: [{ ...ok, name: "FOO" }] })).status).toBe(400);
    expect((await beacon({ device: "desktop", entries: [{ ...ok, value: -1 }] })).status).toBe(400);
    expect((await beacon({ device: "desktop", entries: [{ ...ok, name: "CLS", value: 50 }] })).status).toBe(400);
    expect((await beacon({ device: "watch", entries: [ok] })).status).toBe(400);
    expect((await beacon({ device: "desktop", entries: Array(51).fill(ok) })).status).toBe(400);
    // Una ruta con un id o un query string no es una ruta normalizada.
    expect((await beacon({ device: "desktop", entries: [{ ...ok, route: "/clients/1?email=a@b.co" }] })).status).toBe(
      400
    );
    const bad = await request(app).post("/api/metrics/web-vitals").set("Content-Type", "text/plain").send("{no-json");
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/metrics/web-vitals/summary", () => {
  let adminToken: string;
  let accountantToken: string;

  beforeAll(async () => {
    accountantToken = (await registerUser()).token;
    const email = `admin-metrics-${unique()}@test.local`;
    await prisma.user.create({
      data: { name: "Admin", email, role: "admin", passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) },
    });
    adminToken = (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.token;

    // INP: 100, 200, 300, 400 → p75 (interpolación lineal de percentile_cont) = 325.
    await metricsService.record({
      device: "desktop",
      entries: [100, 200, 300, 400].map((value) => ({ name: "INP" as const, value, route: `${ROUTE}-p75` })),
    });
  });

  it("es solo para admin", async () => {
    expect((await request(app).get("/api/metrics/web-vitals/summary")).status).toBe(401);
    expect((await request(app).get("/api/metrics/web-vitals/summary").set(authHeader(accountantToken))).status).toBe(
      403
    );
  });

  it("calcula el p75 por métrica y ruta", async () => {
    const res = await request(app).get("/api/metrics/web-vitals/summary?days=1").set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const row = res.body.rows.find(
      (r: { metric: string; route: string }) => r.metric === "INP" && r.route === `${ROUTE}-p75`
    );
    expect(row).toEqual({ metric: "INP", route: `${ROUTE}-p75`, samples: 4, p75: 325 });
    // Fila de total por métrica (route null).
    expect(res.body.rows.some((r: { metric: string; route: null }) => r.metric === "INP" && r.route === null)).toBe(
      true
    );
  });
});
