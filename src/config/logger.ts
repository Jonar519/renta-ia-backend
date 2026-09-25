import pino from "pino";
import { env } from "./env";

/**
 * Logger estructurado. `redact` reemplaza por "[REDACTED]" cualquier campo
 * sensible que termine dentro de un log, aunque se loguee por accidente
 * un objeto completo (headers, body de login, configuración, etc.).
 */
export const logger = pino({
  level: env.logLevel,
  redact: {
    paths: [
      "req.headers.authorization",
      "headers.authorization",
      "authorization",
      "password",
      "passwordHash",
      "token",
      "apiKey",
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.apiKey",
      "*.jwtSecret",
      "*.anthropicApiKey",
      "*.voyageApiKey",
      "*.databaseUrl",
    ],
    censor: "[REDACTED]",
  },
  ...(env.nodeEnv === "development"
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } } }
    : {}),
});
