import { PrismaClient } from "@prisma/client";
import { env } from "./env";

export const prisma = new PrismaClient({
  log: env.nodeEnv === "development" ? ["error", "warn"] : ["error"],
});
