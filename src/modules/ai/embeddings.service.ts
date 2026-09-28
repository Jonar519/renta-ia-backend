import { getAiProvider } from "../../services/llm/provider";

/**
 * Divide un texto largo en fragmentos ("chunks") con superposición, para que
 * cada fragmento tenga contexto suficiente al generarle un embedding.
 */
function chunkText(text: string, chunkSize = 1000, overlap = 100): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap;
  }

  return chunks.filter((c) => c.trim().length > 0);
}

/** Embeddings de los textos (Voyage en producción; ver services/llm/provider.ts). */
async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  return getAiProvider().embed(texts);
}

export const embeddingsService = {
  chunkText,
  embed,
};
