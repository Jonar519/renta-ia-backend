// Escenario: ráfaga de subidas a la cola y tiempo de drenaje.
//  1. Sube N PDFs sintéticos distintos (LOADTEST_UPLOADS, por defecto 100) con
//     LOADTEST_CONNECTIONS subidas simultáneas; mide la latencia de cada subida.
//  2. Mide cuánto tarda el worker en vaciar la cola (waiting + active = 0)
//     leyendo renta_ia_queue_jobs de GET /metrics de la API.
//  3. Lee del /metrics del worker la duración media de cada etapa.
// La concurrencia del worker se fija al arrancarlo (WORKER_CONCURRENCY); aquí
// solo se etiqueta el resultado con LOADTEST_WORKER_CONCURRENCY.
import { api, API, login, percentile, readState, save, sleep } from "./lib.mjs";
import { syntheticCertificate } from "./pdf.mjs";

const state = readState();
const uploads = Number(process.env.LOADTEST_UPLOADS || 100);
const connections = Number(process.env.LOADTEST_CONNECTIONS || 10);
const workerConcurrency = process.env.LOADTEST_WORKER_CONCURRENCY || "desconocida";
const metricsToken = process.env.METRICS_TOKEN;
const workerMetricsUrl = process.env.LOADTEST_WORKER_METRICS_URL || "http://localhost:9464/metrics";
if (!metricsToken) throw new Error("Define METRICS_TOKEN (el mismo de la API y el worker).");

const token = await login(state.upload.email);
const client = await api("POST", "/api/clients", {
  token,
  body: { fullName: `Ráfaga ${Date.now()}`, documentNumber: `LT-R-${Date.now()}` },
});

async function metrics(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${metricsToken}` } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

function gauge(text, jobState) {
  const re = new RegExp(`renta_ia_queue_jobs\\{queue="document-processing",state="${jobState}"\\} (\\d+)`);
  return Number(text.match(re)?.[1] ?? NaN);
}

function stageStats(text) {
  const stats = {};
  const re = /renta_ia_pipeline_stage_duration_seconds_(sum|count)\{stage="(\w+)",outcome="(\w+)"\} ([\d.e+-]+)/g;
  for (const m of text.matchAll(re)) {
    const key = `${m[2]}:${m[3]}`;
    stats[key] ??= { sum: 0, count: 0 };
    stats[key][m[1]] = Number(m[4]);
  }
  return stats;
}

const workerBefore = stageStats(await metrics(workerMetricsUrl));
const latencies = [];
const statuses = {};
let next = 0;
const t0 = performance.now();
await Promise.all(
  Array.from({ length: connections }, async () => {
    while (next < uploads) {
      const n = next++;
      const form = new FormData();
      form.append("clientId", client.id);
      form.append("docType", "income_certificate");
      const pdf = syntheticCertificate(`${Date.now()}-${n}`);
      form.append("file", new Blob([pdf], { type: "application/pdf" }), `cert-${n}.pdf`);
      const start = performance.now();
      const res = await fetch(`${API}/api/documents/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      await res.arrayBuffer();
      latencies.push(Number((performance.now() - start).toFixed(1)));
      statuses[res.status] = (statuses[res.status] || 0) + 1;
    }
  })
);
const enqueuedMs = performance.now() - t0;

let drainedMs = null;
let maxWaiting = 0;
for (;;) {
  const text = await metrics(`${API}/metrics`);
  const waiting = gauge(text, "waiting");
  const active = gauge(text, "active");
  maxWaiting = Math.max(maxWaiting, waiting);
  if (waiting === 0 && active === 0) {
    drainedMs = performance.now() - t0;
    break;
  }
  if (performance.now() - t0 > 30 * 60_000) break;
  await sleep(250);
}

const workerAfter = stageStats(await metrics(workerMetricsUrl));
const workerStagesAvgMs = {};
for (const [key, after] of Object.entries(workerAfter)) {
  const before = workerBefore[key] ?? { sum: 0, count: 0 };
  const count = after.count - before.count;
  if (count > 0) {
    workerStagesAvgMs[key] = { count, avgMs: Number((((after.sum - before.sum) / count) * 1000).toFixed(1)) };
  }
}

latencies.sort((a, b) => a - b);
const ok = statuses[201] || 0;
save(`upload-burst-w${workerConcurrency}.json`, {
  scenario: "upload-burst",
  uploads,
  uploadConnections: connections,
  workerConcurrency,
  aiMockLatencyMsPerCall: process.env.LOADTEST_AI_MOCK_LATENCY_MS ?? "no indicado",
  result: {
    uploadLatencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.at(-1),
    },
    statusCodes: statuses,
    errorRate: Number((1 - ok / uploads).toFixed(4)),
    allEnqueuedAfterMs: Math.round(enqueuedMs),
    maxWaitingObserved: maxWaiting,
    queueDrainedAfterMs: drainedMs === null ? "no se vació en 30 min" : Math.round(drainedMs),
    documentsPerSecond: drainedMs ? Number((ok / (drainedMs / 1000)).toFixed(2)) : null,
    workerStagesAvgMs,
  },
});
