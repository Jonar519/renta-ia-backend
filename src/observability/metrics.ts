import type { NextFunction, Request, Response } from "express";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import { timingSafeEqual } from "crypto";
import { env } from "../config/env";

/**
 * Métricas Prometheus (prom-client). Cada proceso (API y worker) tiene su
 * propio registro y lo expone:
 *  - API:    GET /metrics en su mismo puerto.
 *  - Worker: GET /metrics en WORKER_METRICS_PORT (por defecto 9464).
 * Ambos exigen "Authorization: Bearer <METRICS_TOKEN>"; sin METRICS_TOKEN el
 * endpoint no existe (404). Las etiquetas nunca llevan ids ni datos de
 * usuarios: la ruta se registra como patrón ("/api/clients/:id").
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "renta_ia_" });

const SECONDS_FAST = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const SECONDS_SLOW = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120];

export const httpRequestDuration = new Histogram({
  name: "renta_ia_http_request_duration_seconds",
  help: "Duración de las solicitudes HTTP de la API",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: SECONDS_FAST,
  registers: [registry],
});

export const queueJobs = new Gauge({
  name: "renta_ia_queue_jobs",
  help: "Trabajos en la cola de documentos por estado (se lee de Redis en cada scrape)",
  labelNames: ["queue", "state"] as const,
  registers: [registry],
});

export const pipelineStageDuration = new Histogram({
  name: "renta_ia_pipeline_stage_duration_seconds",
  help: "Duración de cada etapa del procesamiento de un documento",
  labelNames: ["stage", "outcome"] as const,
  buckets: SECONDS_SLOW,
  registers: [registry],
});

export const llmRequestDuration = new Histogram({
  name: "renta_ia_llm_request_duration_seconds",
  help: "Latencia de las llamadas al proveedor de IA",
  labelNames: ["provider", "operation", "purpose", "outcome"] as const,
  buckets: SECONDS_SLOW,
  registers: [registry],
});

export const llmTokens = new Counter({
  name: "renta_ia_llm_tokens_total",
  help: "Tokens consumidos en el LLM (entrada y salida)",
  labelNames: ["provider", "purpose", "direction"] as const,
  registers: [registry],
});

type ScrapeHook = () => Promise<void>;
const scrapeHooks: ScrapeHook[] = [];

/** Registra una función que actualiza gauges justo antes de cada scrape (p. ej. leer la cola). */
export function onScrape(hook: ScrapeHook) {
  scrapeHooks.push(hook);
}

/** Texto de exposición de Prometheus, tras correr los hooks (un hook que falla no impide el resto). */
export async function renderMetrics(): Promise<string> {
  await Promise.all(scrapeHooks.map((hook) => hook().catch(() => undefined)));
  return registry.metrics();
}

/** Mide una etapa del pipeline y registra si terminó bien o con error. */
export async function timeStage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const end = pipelineStageDuration.startTimer({ stage });
  try {
    const result = await fn();
    end({ outcome: "ok" });
    return result;
  } catch (err) {
    end({ outcome: "error" });
    throw err;
  }
}

/** Middleware: duración por método, ruta (patrón, no la URL real) y código. */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    // req.route solo existe si una ruta respondió; baseUrl + path = patrón.
    const route = req.route ? `${req.baseUrl}${req.route.path}` : req.baseUrl || "sin_ruta";
    end({ method: req.method, route, status_code: String(res.statusCode) });
  });
  next();
}

function tokenMatches(header: string | undefined): boolean {
  if (!env.metricsToken || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(env.metricsToken);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** true si la petición puede leer las métricas; si no, responde (404 o 401). */
export function authorizeMetrics(authorization: string | undefined): 200 | 401 | 404 {
  if (!env.metricsToken) return 404;
  return tokenMatches(authorization) ? 200 : 401;
}

export async function metricsHandler(req: Request, res: Response) {
  const status = authorizeMetrics(req.get("authorization"));
  if (status !== 200) {
    res.status(status).json({ error: status === 404 ? "Ruta no encontrada" : "No autorizado" });
    return;
  }
  res.set("Content-Type", registry.contentType);
  res.send(await renderMetrics());
}
