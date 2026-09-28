import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env";
import type { AiProvider, CompletionRequest, CompletionResult } from "./provider";

/** Modelo usado por la extracción de conceptos, el chat (RAG) y el resumen. */
export const CLAUDE_MODEL = "claude-sonnet-5";
/** Modelo de embeddings de Voyage (1024 dimensiones = vector(1024) en la BD). */
const VOYAGE_MODEL = "voyage-2";
const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";

const FEATURE_LABEL: Record<CompletionRequest["purpose"], string> = {
  extraction: "poder usar la extracción con IA",
  chat: "usar el chat",
  summary: "generar el resumen ejecutivo",
};

let client: Anthropic | null = null;

/**
 * Cliente de Anthropic compartido. La API key es opcional al arrancar el
 * servidor: solo se exige aquí, cuando una funcionalidad de IA la necesita.
 */
function getAnthropicClient(feature: string): Anthropic {
  if (!env.anthropicApiKey) {
    throw new Error(`Falta configurar ANTHROPIC_API_KEY en el archivo .env para ${feature}.`);
  }
  client ??= new Anthropic({ apiKey: env.anthropicApiKey });
  return client;
}

/** Texto del primer bloque de tipo "text" de la respuesta, o null si no hay. */
export function firstTextBlock(message: Anthropic.Message): string | null {
  const block = message.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : null;
}

export const anthropicProvider: AiProvider = {
  name: "anthropic",

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const message = await getAnthropicClient(FEATURE_LABEL[request.purpose]).messages.create({
      model: CLAUDE_MODEL,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: "user", content: request.userContent }],
    });
    return {
      text: firstTextBlock(message),
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
    };
  },

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!env.voyageApiKey) {
      throw new Error("Falta configurar VOYAGE_API_KEY en el archivo .env para generar embeddings.");
    }

    const response = await fetch(VOYAGE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.voyageApiKey}` },
      body: JSON.stringify({ input: texts, model: VOYAGE_MODEL }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Error al generar embeddings (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as { data: { embedding: number[] }[] };
    return data.data.map((d) => d.embedding);
  },
};
