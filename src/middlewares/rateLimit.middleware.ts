import { Request } from "express";
import { rateLimit, ipKeyGenerator, Options } from "express-rate-limit";
import { RedisStore, RedisReply } from "rate-limit-redis";
import { env } from "../config/env";
import { redisConnection } from "../config/redis";

/**
 * Rate limiting con contadores en Redis (compartidos entre instancias de la
 * API). En tests se usa el store en memoria para no depender de Redis.
 */
function store(prefix: string): Options["store"] | undefined {
  if (env.nodeEnv === "test") return undefined;
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: (command: string, ...args: string[]) => redisConnection.call(command, ...args) as Promise<RedisReply>,
  });
}

function limiter(prefix: string, windowMs: number, limit: number, message: string, extra: Partial<Options> = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    store: store(prefix),
    message: { error: message },
    ...extra,
  });
}

const MINUTE = 60 * 1000;

// Clave por usuario autenticado (cae a la IP si no hay usuario). Debe usarse
// DESPUÉS de authMiddleware.
const byUser = (req: Request) => req.user?.userId ?? ipKeyGenerator(req.ip ?? "");

/** Límite general por IP para toda la API. */
export const globalLimiter = limiter(
  "global",
  15 * MINUTE,
  300,
  "Demasiadas solicitudes. Intenta de nuevo en unos minutos."
);

/** Anti fuerza bruta en /api/auth/*: solo cuentan los intentos fallidos. */
export const authLimiter = limiter(
  "auth",
  15 * MINUTE,
  10,
  "Demasiados intentos fallidos de autenticación. Espera 15 minutos.",
  { skipSuccessfulRequests: true }
);

/** Chat con IA: cada pregunta consume créditos de Anthropic y Voyage. */
export const aiChatLimiter = limiter(
  "ai-chat",
  60 * MINUTE,
  30,
  "Alcanzaste el límite de preguntas a la IA por hora.",
  {
    keyGenerator: byUser,
  }
);

/** Subida de documentos: cada archivo dispara OCR + LLM + embeddings. */
export const uploadLimiter = limiter(
  "upload",
  60 * MINUTE,
  30,
  "Alcanzaste el límite de documentos subidos por hora.",
  {
    keyGenerator: byUser,
  }
);
