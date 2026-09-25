import os from "os";
import path from "path";
import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./tests/testEnv";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Crea la base de pruebas desde cero y aplica las migraciones SQL.
    globalSetup: ["tests/globalSetup.ts"],
    // Mocks globales (Redis y la cola de BullMQ): los tests no necesitan Redis.
    setupFiles: ["tests/setup.ts"],
    // Los tests de integración comparten una misma base de datos.
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: "test-jwt-secret-solo-para-pruebas",
      ANTHROPIC_API_KEY: "test-anthropic-key",
      VOYAGE_API_KEY: "test-voyage-key",
      CORS_ORIGIN: "http://localhost:5173",
      STORAGE_LOCAL_PATH: path.join(os.tmpdir(), "renta-ia-test-uploads"),
    },
  },
});
