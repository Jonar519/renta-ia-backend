// Escenario: comportamiento de los rate limiters con los límites REALES
// (API arrancada SIN RATE_LIMIT_SCALE). Borra antes los contadores rl:* de Redis.
//  a) Límite global: 350 GET /api/clients desde una IP (límite 300 / 15 min).
//  b) Fuerza bruta: 12 logins fallidos contra cuentas distintas (límite 10 / 15 min por IP).
import IORedis from "ioredis";
import { API, login, readState, run, save } from "./lib.mjs";

const redis = new IORedis(process.env.LOADTEST_REDIS_URL || "redis://localhost:6379/3");
async function clearCounters() {
  const keys = await redis.keys("rl:*");
  if (keys.length) await redis.del(...keys);
}

const state = readState();
await clearCounters();
// Un login exitoso no cuenta para el limitador de fuerza bruta (skipSuccessfulRequests).
const token = await login(state.list.email);

const global = await run("ratelimit-global", {
  connections: 10,
  amount: 350,
  requests: [{ method: "GET", path: "/api/clients?limit=10", headers: { Authorization: `Bearer ${token}` } }],
});

await clearCounters();
const bruteForce = [];
for (let i = 0; i < 12; i++) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `no-existe-${Date.now()}-${i}@loadtest.local`, password: "incorrecta-123" }),
  });
  bruteForce.push(res.status);
}
await clearCounters();
await redis.quit();
save("ratelimit.json", { scenario: "ratelimit", global, bruteForceStatuses: bruteForce });
