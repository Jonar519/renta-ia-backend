import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app, authHeader, createClient, registerUser } from "../helpers";
import { env } from "../../src/config/env";
import { redisConnection } from "../../src/config/redis";
import { documentQueue } from "../../src/queues/documentQueue";
import { markShuttingDown } from "../../src/observability/health";
import { timeStage } from "../../src/observability/metrics";
import { instrumentProvider } from "../../src/services/llm/provider";
import { createMockProvider } from "../../src/services/llm/mock.provider";

const TOKEN = "token-de-metricas-de-prueba";

describe("Sondas /health y /ready", () => {
  it("/health (liveness) responde sin consultar dependencias", async () => {
    const pingsBefore = vi.mocked(redisConnection.ping).mock.calls.length;
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(vi.mocked(redisConnection.ping).mock.calls.length).toBe(pingsBefore);
  });

  it("/ready verifica PostgreSQL y Redis", async () => {
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { database: "ok", redis: "ok" } });
  });

  it("/ready responde 503 si Redis no contesta (sin exponer la cadena de conexión)", async () => {
    vi.mocked(redisConnection.ping).mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:6379"));
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks.database).toBe("ok");
    expect(res.body.checks.redis).toMatch(/^error: /);
  });
});

describe("GET /metrics (Prometheus)", () => {
  afterEach(() => {
    env.metricsToken = undefined;
  });

  it("no existe si no hay METRICS_TOKEN", async () => {
    expect((await request(app).get("/metrics")).status).toBe(404);
  });

  it("exige el token correcto", async () => {
    env.metricsToken = TOKEN;
    expect((await request(app).get("/metrics")).status).toBe(401);
    expect((await request(app).get("/metrics").set("Authorization", "Bearer otro")).status).toBe(401);
  });

  it("expone duración HTTP por PATRÓN de ruta (sin ids), estado de la cola, etapas y LLM", async () => {
    env.metricsToken = TOKEN;
    const user = await registerUser();
    const client = await createClient(user.token);
    await request(app).get(`/api/clients/${client.id}`).set(authHeader(user.token));
    vi.mocked(documentQueue.getJobCounts).mockResolvedValueOnce({
      waiting: 7,
      active: 2,
      delayed: 0,
      failed: 1,
      completed: 5,
    });
    // Una etapa del pipeline y una llamada al LLM (proveedor falso instrumentado).
    await timeStage("text", async () => "texto");
    await instrumentProvider(createMockProvider()).complete({
      purpose: "chat",
      system: "s",
      userContent: "<pregunta>hola</pregunta>",
      maxTokens: 10,
    });

    const res = await request(app).get("/metrics").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    const body = res.text;
    expect(body).toMatch(
      /renta_ia_http_request_duration_seconds_count\{method="GET",route="\/api\/clients\/:id",status_code="200"\} 1/
    );
    expect(body).not.toContain(client.id);
    expect(body).toContain('renta_ia_queue_jobs{queue="document-processing",state="waiting"} 7');
    expect(body).toContain('renta_ia_queue_jobs{queue="document-processing",state="failed"} 1');
    expect(body).toMatch(/renta_ia_pipeline_stage_duration_seconds_count\{stage="text",outcome="ok"\} 1/);
    expect(body).toMatch(
      /renta_ia_llm_request_duration_seconds_count\{provider="mock",operation="complete",purpose="chat",outcome="ok"\} 1/
    );
    expect(body).toMatch(/renta_ia_llm_tokens_total\{provider="mock",purpose="chat",direction="input"\} \d+/);
    expect(body).toContain("renta_ia_process_cpu_seconds_total");
  });
});

describe("RATE_LIMIT_SCALE (solo pruebas de carga)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("se rechaza en producción", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ORIGIN", "https://app.example.com");
    vi.stubEnv("RATE_LIMIT_SCALE", "100");
    vi.resetModules();
    await expect(import("../../src/config/env")).rejects.toThrow(/solo para pruebas de carga/);
  });

  it("se rechaza un valor inválido", async () => {
    vi.stubEnv("RATE_LIMIT_SCALE", "0.5");
    vi.resetModules();
    await expect(import("../../src/config/env")).rejects.toThrow(/no es válido/);
  });
});

// Al final: el estado de apagado es global del proceso de tests.
describe("Apagado ordenado", () => {
  it("/ready responde 503 en cuanto empieza el apagado (el balanceador deja de enviar tráfico)", async () => {
    markShuttingDown();
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("shutting_down");
    expect((await request(app).get("/health")).status).toBe(200);
  });
});
