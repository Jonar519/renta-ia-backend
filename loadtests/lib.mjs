// Utilidades comunes de las pruebas de carga (ver loadtests/README.md).
import autocannon from "autocannon";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const API = process.env.LOADTEST_API_URL || "http://localhost:4300";
export const DURATION = Number(process.env.LOADTEST_DURATION || 20);
// Contraseña de las cuentas SINTÉTICAS que crea setup.mjs (solo existen en la base de pruebas).
export const PASSWORD = "carga sintetica solo pruebas";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.join(here, "results");
const STATE_FILE = path.join(here, ".state.json");

export function readState() {
  if (!fs.existsSync(STATE_FILE))
    throw new Error("Falta loadtests/.state.json: corre primero `node loadtests/setup.mjs`.");
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

export function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function api(method, url, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API}${url}`, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

export async function login(email) {
  return (await api("POST", "/api/auth/login", { body: { email, password: PASSWORD } })).accessToken;
}

/** Percentil exacto (método nearest-rank) de una lista de números. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * Corre autocannon registrando la latencia y el código de CADA respuesta
 * (autocannon no reporta p95, y necesitamos separar 2xx de 429 y errores).
 */
export function run(name, options) {
  return new Promise((resolve, reject) => {
    const latencies = [];
    const statuses = {};
    // Con "amount" (cantidad fija de solicitudes) no se pasa "duration".
    const opts = { url: API, ...(options.amount ? {} : { duration: DURATION }), ...options };
    const instance = autocannon(opts, (err, result) => {
      if (err) return reject(err);
      latencies.sort((a, b) => a - b);
      const total = latencies.length;
      const ok = Object.entries(statuses)
        .filter(([code]) => code.startsWith("2"))
        .reduce((sum, [, n]) => sum + n, 0);
      resolve({
        name,
        connections: options.connections,
        durationSeconds: result.duration,
        requests: total,
        throughputRps: Number((total / result.duration).toFixed(1)),
        latencyMs: {
          p50: percentile(latencies, 50),
          p95: percentile(latencies, 95),
          p99: percentile(latencies, 99),
          max: latencies[total - 1] ?? null,
        },
        statusCodes: statuses,
        socketErrors: result.errors,
        timeouts: result.timeouts,
        errorRate: total + result.errors ? Number((1 - ok / (total + result.errors)).toFixed(4)) : null,
      });
    });
    instance.on("response", (_client, statusCode, _bytes, responseTime) => {
      latencies.push(Number(responseTime.toFixed(1)));
      statuses[statusCode] = (statuses[statusCode] || 0) + 1;
    });
  });
}

export function machine() {
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model.trim(),
    logicalCpus: cpus.length,
    ramGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    os: `${os.type()} ${os.release()}`,
    node: process.version,
  };
}

export function save(file, data) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const out = { measuredAt: new Date().toISOString(), api: API, machine: machine(), ...data };
  fs.writeFileSync(path.join(RESULTS_DIR, file), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
