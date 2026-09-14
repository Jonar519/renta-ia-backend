import { createApp } from "./app";
import { env } from "./config/env";
import { prisma } from "./config/prisma";

const app = createApp();

async function main() {
  await prisma.$connect();
  console.log("Conectado a la base de datos.");

  app.listen(env.port, () => {
    console.log(`Servidor escuchando en http://localhost:${env.port}`);
  });
}

main().catch((err) => {
  console.error("Error al iniciar el servidor:", err);
  process.exit(1);
});
