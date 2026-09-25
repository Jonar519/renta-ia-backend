import fs from "fs";
import path from "path";
import { Client } from "pg";
import { TEST_DATABASE_URL } from "./testEnv";

/**
 * Recrea la base de pruebas y le aplica las migraciones SQL del repositorio
 * renta-ia-database (el dueño del esquema). Por defecto las busca en el
 * repo hermano (../renta-ia-database/migrations); en CI se puede indicar
 * otra ruta con MIGRATIONS_DIR.
 */
export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith("_test")) {
    throw new Error(`Por seguridad, la base de pruebas debe terminar en "_test" (recibido: "${dbName}")`);
  }

  const migrationsDir = path.resolve(
    process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "../renta-ia-database/migrations")
  );
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`No se encontraron las migraciones en ${migrationsDir}. Define MIGRATIONS_DIR.`);
  }

  const adminUrl = new URL(url.toString());
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    await db.query(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  await db.end();
}
