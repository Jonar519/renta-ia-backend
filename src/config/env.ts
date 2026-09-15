import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}. Revisa tu archivo .env`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "1d",
  nodeEnv: process.env.NODE_ENV ?? "development",

  // Cola de tareas
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  // IA — opcionales: el servidor principal arranca sin ellas.
  // Solo se exigen en el momento de procesar un documento o usar el chat.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  voyageApiKey: process.env.VOYAGE_API_KEY,

  // Almacenamiento de documentos (Fase 3: disco local · Fase 6: S3)
  storageDriver: process.env.STORAGE_DRIVER ?? "local",
  storageLocalPath: process.env.STORAGE_LOCAL_PATH ?? "./uploads",
};
