import { PrismaClient } from "@prisma/client";
import { logger } from "./logger";

// Prisma NO imprime sus errores por consola: al fallar una consulta,
// su mensaje puede incluir los argumentos (ej. un passwordHash). Los
// errores se lanzan igual y los maneja error.middleware.ts, que decide qué
// se loguea. Los warnings sí se envían al logger estructurado.
export const prisma = new PrismaClient({
  log: [{ emit: "event", level: "warn" }],
});

prisma.$on("warn", (event) => logger.warn({ target: event.target }, event.message));
