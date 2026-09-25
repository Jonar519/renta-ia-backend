import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env";

/** Modelo usado por la extracción de conceptos y por el chat (RAG). */
export const CLAUDE_MODEL = "claude-sonnet-5";

let client: Anthropic | null = null;

/**
 * Cliente de Anthropic compartido. La API key es opcional al arrancar el
 * servidor: solo se exige aquí, cuando una funcionalidad de IA la necesita.
 *
 * @param feature Para qué se usa (aparece en el error si falta la key).
 */
export function getAnthropicClient(feature: string): Anthropic {
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
