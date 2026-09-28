import { env } from "../../config/env";
import { anthropicProvider } from "./anthropic.provider";
import { createMockProvider } from "./mock.provider";

/** Para qué se usa una llamada al modelo (etiqueta de métricas y logs). */
export type AiPurpose = "extraction" | "chat" | "summary";

export interface CompletionRequest {
  purpose: AiPurpose;
  system: string;
  userContent: string;
  maxTokens: number;
}

export interface CompletionResult {
  /** Texto del primer bloque de texto de la respuesta, o null si no hubo. */
  text: string | null;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Proveedor de IA. En producción siempre es "anthropic" (Claude + Voyage).
 * "mock" existe SOLO para E2E y pruebas de carga (AI_PROVIDER=mock): env.ts
 * rechaza esa combinación con NODE_ENV=production al arrancar, y la fábrica
 * del proveedor falso lanza un error si aun así se intenta crear.
 */
export interface AiProvider {
  readonly name: "anthropic" | "mock";
  complete(request: CompletionRequest): Promise<CompletionResult>;
  embed(texts: string[]): Promise<number[][]>;
}

let provider: AiProvider | null = null;

export function getAiProvider(): AiProvider {
  provider ??= env.aiProvider === "mock" ? createMockProvider() : anthropicProvider;
  return provider;
}
