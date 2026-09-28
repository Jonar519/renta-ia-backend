import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}. Revisa tu archivo .env`);
  }
  return value;
}

const nodeEnv = process.env.NODE_ENV ?? "development";

function aiProvider(): "anthropic" | "mock" {
  const value = process.env.AI_PROVIDER ?? "anthropic";
  if (value !== "anthropic" && value !== "mock") {
    throw new Error(`AI_PROVIDER="${value}" no es válido. Usa "anthropic" o "mock".`);
  }
  if (value === "mock" && nodeEnv === "production") {
    throw new Error("AI_PROVIDER=mock es solo para pruebas y no puede usarse con NODE_ENV=production.");
  }
  return value;
}

/**
 * Multiplicador de TODOS los límites de rate limiting. Existe solo para las
 * pruebas de carga (loadtests/): con el valor por defecto (1) un solo equipo
 * choca contra el límite global de 300 solicitudes / 15 min en segundos.
 * Igual que AI_PROVIDER=mock, se rechaza cualquier valor distinto de 1 en producción.
 */
function rateLimitScale(): number {
  const value = Number(process.env.RATE_LIMIT_SCALE ?? 1);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`RATE_LIMIT_SCALE="${process.env.RATE_LIMIT_SCALE}" no es válido (número >= 1).`);
  }
  if (value !== 1 && nodeEnv === "production") {
    throw new Error("RATE_LIMIT_SCALE es solo para pruebas de carga y no puede usarse con NODE_ENV=production.");
  }
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} debe ser un entero positivo.`);
  return value;
}

// Orígenes permitidos por CORS, separados por coma. En producción es
// obligatorio definirlo; en desarrollo se usa el puerto por defecto de Vite.
const corsOrigins = (
  process.env.CORS_ORIGIN ?? (nodeEnv === "production" ? required("CORS_ORIGIN") : "http://localhost:5173")
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  // Access token: corto, solo en memoria del navegador (nunca en localStorage).
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "15m",
  // Refresh token (cookie httpOnly, rotativo): días de vida de una sesión inactiva.
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7),
  // Cookie Secure (solo HTTPS). Por defecto en producción; en local (http) no.
  cookieSecure: (process.env.COOKIE_SECURE ?? (nodeEnv === "production" ? "true" : "false")) === "true",
  nodeEnv,
  logLevel: process.env.LOG_LEVEL ?? (nodeEnv === "test" ? "silent" : "info"),

  // Seguridad HTTP
  corsOrigins,
  // Número de proxies delante de la app (ej. 1 detrás de un ALB). Necesario
  // para que el rate limiting vea la IP real del cliente y no la del proxy.
  trustProxy: Number(process.env.TRUST_PROXY ?? 0),
  rateLimitScale: rateLimitScale(),

  // Observabilidad: GET /metrics (Prometheus) solo con "Authorization: Bearer
  // <METRICS_TOKEN>". Sin token configurado, /metrics responde 404.
  metricsToken: process.env.METRICS_TOKEN || undefined,
  // El worker expone sus propias métricas en este puerto (mismo token).
  workerMetricsPort: positiveInt("WORKER_METRICS_PORT", 9464),
  // Documentos que el worker procesa en paralelo.
  workerConcurrency: positiveInt("WORKER_CONCURRENCY", 2),
  // Tiempo máximo del apagado ordenado (SIGTERM/SIGINT) antes de forzar la salida.
  shutdownTimeoutMs: positiveInt("SHUTDOWN_TIMEOUT_MS", 10_000),

  // Cola de tareas
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  // IA — opcionales: el servidor principal arranca sin ellas.
  // Solo se exigen en el momento de procesar un documento o usar el chat.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  voyageApiKey: process.env.VOYAGE_API_KEY,
  // "anthropic" (real, por defecto) o "mock" (SOLO pruebas; prohibido en producción).
  aiProvider: aiProvider(),
  aiMockLatencyMs: Number(process.env.AI_MOCK_LATENCY_MS ?? 0),

  // Almacenamiento de documentos (Fase 3: disco local · Fase 6: S3)
  storageDriver: process.env.STORAGE_DRIVER ?? "local",
  storageLocalPath: process.env.STORAGE_LOCAL_PATH ?? "./uploads",
};
