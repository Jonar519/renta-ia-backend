import { env } from "../../config/env";

const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";

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

async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  if (!env.voyageApiKey) {
    throw new Error("Falta configurar VOYAGE_API_KEY en el archivo .env para generar embeddings.");
  }

  const response = await fetch(VOYAGE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.voyageApiKey}`,
    },
    body: JSON.stringify({ input: texts, model: "voyage-2" }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Error al generar embeddings (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

export const embeddingsService = {
  chunkText,
  embed,
};
