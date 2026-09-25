import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { prisma } from "./config/prisma";

const app = createApp();

async function main() {
  await prisma.$connect();
  logger.info("Conectado a la base de datos.");

  app.listen(env.port, () => {
    logger.info(`Servidor escuchando en http://localhost:${env.port}`);
  });
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? { name: err.name, message: err.message } : String(err) }, "Error al iniciar el servidor");
  process.exit(1);
});
