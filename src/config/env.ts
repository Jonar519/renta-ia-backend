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
 * Proveedor de correo (services/email). Regla de proveedores externos:
 *  - "mock" (por defecto fuera de producción): no envía nada; guarda cada
 *    correo, con su contenido, en la tabla email_outbox para pruebas y demos.
 *    Prohibido con NODE_ENV=production (el cuerpo puede llevar un token).
 *  - "ses" (Amazon SES v2): exige SES_REGION y EMAIL_FROM al arrancar. Las
 *    credenciales las resuelve el SDK (variables AWS_*, perfil o rol IAM) en
 *    el momento de enviar; sin ellas el envío falla y queda registrado.
 */
function emailProvider(): "mock" | "ses" {
  // || y no ??: una línea "EMAIL_PROVIDER=" vacía en el .env cuenta como no definida.
  const value = process.env.EMAIL_PROVIDER || (nodeEnv === "production" ? "ses" : "mock");
  if (value !== "mock" && value !== "ses") {
    throw new Error(`EMAIL_PROVIDER="${value}" no es válido. Usa "mock" o "ses".`);
  }
  if (value === "mock" && nodeEnv === "production") {
    throw new Error("EMAIL_PROVIDER=mock es solo para desarrollo y pruebas y no puede usarse con NODE_ENV=production.");
  }
  if (value === "ses") {
    for (const name of ["SES_REGION", "EMAIL_FROM"]) {
      if (!process.env[name]) throw new Error(`EMAIL_PROVIDER=ses requiere la variable de entorno ${name}.`);
    }
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

/**
 * Clave de cifrado de los secretos TOTP (AES-256-GCM): 32 bytes en base64.
 * Generarla: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *  - Obligatoria en producción (el servidor no arranca sin ella).
 *  - Fuera de producción es opcional: sin ella la API arranca igual y solo
 *    las rutas de MFA responden 503 explicando qué falta.
 *  - Si se pierde o se cambia, los secretos guardados no se pueden descifrar
 *    y cada cuenta con MFA tendría que volver a configurarlo.
 */
function mfaEncryptionKey(): Buffer | undefined {
  const value = process.env.MFA_ENCRYPTION_KEY;
  if (!value) {
    if (nodeEnv === "production") required("MFA_ENCRYPTION_KEY");
    return undefined;
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error("MFA_ENCRYPTION_KEY debe ser exactamente 32 bytes codificados en base64 (44 caracteres).");
  }
  return key;
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
  // Cifrado de los secretos TOTP (ver mfaEncryptionKey).
  mfaEncryptionKey: mfaEncryptionKey(),
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
  // Espera entre "/ready = 503" y dejar de aceptar conexiones, para que el
  // balanceador alcance a ver el 503 y saque la instancia. 0 en local; en
  // producción, al menos el intervalo del health check del balanceador.
  shutdownDrainDelayMs: Number(process.env.SHUTDOWN_DRAIN_DELAY_MS ?? 0),

  // Cola de tareas
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  // IA — opcionales: el servidor principal arranca sin ellas.
  // Solo se exigen en el momento de procesar un documento o usar el chat.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  voyageApiKey: process.env.VOYAGE_API_KEY,
  // "anthropic" (real, por defecto) o "mock" (SOLO pruebas; prohibido en producción).
  aiProvider: aiProvider(),
  aiMockLatencyMs: Number(process.env.AI_MOCK_LATENCY_MS ?? 0),

  // Correo (ver emailProvider): "mock" por defecto fuera de producción.
  emailProvider: emailProvider(),
  // URL pública del frontend: base de los enlaces que viajan por correo
  // (invitación, recuperación…). Obligatoria en producción.
  appUrl: (process.env.APP_URL || (nodeEnv === "production" ? required("APP_URL") : "http://localhost:5173")).replace(
    /\/+$/,
    ""
  ),
  emailFrom: process.env.EMAIL_FROM ?? "Renta IA <no-responder@renta-ia.local>",
  sesRegion: process.env.SES_REGION,

  // Almacenamiento de documentos (Fase 3: disco local · Fase 6: S3)
  storageDriver: process.env.STORAGE_DRIVER ?? "local",
  storageLocalPath: process.env.STORAGE_LOCAL_PATH ?? "./uploads",
};
