import { env } from "../../config/env";
import { anthropicProvider } from "./anthropic.provider";
import { createMockProvider } from "./mock.provider";
import { llmRequestDuration, llmTokens } from "../../observability/metrics";

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

/** Envuelve un proveedor para medir latencia y tokens (renta_ia_llm_*). */
export function instrumentProvider(inner: AiProvider): AiProvider {
  return {
    name: inner.name,
    async complete(request) {
      const end = llmRequestDuration.startTimer({
        provider: inner.name,
        operation: "complete",
        purpose: request.purpose,
      });
      try {
        const result = await inner.complete(request);
        end({ outcome: "ok" });
        llmTokens.inc({ provider: inner.name, purpose: request.purpose, direction: "input" }, result.inputTokens);
        llmTokens.inc({ provider: inner.name, purpose: request.purpose, direction: "output" }, result.outputTokens);
        return result;
      } catch (err) {
        end({ outcome: "error" });
        throw err;
      }
    },
    async embed(texts) {
      const end = llmRequestDuration.startTimer({ provider: inner.name, operation: "embed", purpose: "embeddings" });
      try {
        const vectors = await inner.embed(texts);
        end({ outcome: "ok" });
        return vectors;
      } catch (err) {
        end({ outcome: "error" });
        throw err;
      }
    },
  };
}

let provider: AiProvider | null = null;

export function getAiProvider(): AiProvider {
  provider ??= instrumentProvider(env.aiProvider === "mock" ? createMockProvider() : anthropicProvider);
  return provider;
}
