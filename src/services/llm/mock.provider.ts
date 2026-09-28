import { env } from "../../config/env";
import type { AiProvider, CompletionRequest, CompletionResult } from "./provider";

/**
 * ⚠️ PROVEEDOR DE IA FALSO — SOLO PARA PRUEBAS (E2E y pruebas de carga).
 *
 * Se activa únicamente con AI_PROVIDER=mock y se niega a crearse con
 * NODE_ENV=production. No llama a ninguna API ni consume crédito: devuelve
 * respuestas deterministas y marcadas como simuladas, para que el flujo
 * completo (subida → worker → conceptos → embeddings → chat/resumen) se
 * pueda probar sin claves reales.
 *
 * AI_MOCK_LATENCY_MS (por defecto 0) agrega una espera artificial a cada
 * llamada, para que las pruebas de carga se parezcan más a un LLM real.
 */

export const MOCK_NOTICE = "[Respuesta simulada · AI_PROVIDER=mock · solo para pruebas]";
const EMBEDDING_DIMENSIONS = 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Palabras clave → tipo de concepto, para una "extracción" determinista.
const CONCEPT_KEYWORDS: [RegExp, string][] = [
  [/ingresos?\s+(brutos?|laborales?)/i, "gross_income"],
  [/retenci[oó]n/i, "withholding"],
  [/deducci[oó]n|deducible/i, "deduction"],
  [/pensi[oó]n/i, "pension_contribution"],
  [/salud/i, "health_contribution"],
];

/**
 * Busca líneas "Etiqueta: $ 1.234.567" en el texto y devuelve un arreglo
 * JSON con la misma forma que pide el prompt real de extracción.
 */
function mockExtraction(documentText: string): string {
  const year = Number(documentText.match(/\b(20\d{2})\b/)?.[1] ?? new Date().getFullYear() - 1);
  const concepts = documentText
    .split(/\r?\n/)
    .map((line) => {
      const type = CONCEPT_KEYWORDS.find(([regex]) => regex.test(line))?.[1];
      // Monto al final de la línea con separador de miles (85.000.000) o de 5+
      // dígitos: así un año ("2025") nunca se toma como monto.
      const amount = line.match(/(\d{1,3}(?:\.\d{3})+|\d{5,})(?:,\d{1,2})?\s*$/)?.[1];
      if (!type || !amount) return null;
      return {
        conceptType: type,
        description: line.split(":")[0]!.trim().slice(0, 100),
        amount: Number(amount.replace(/\./g, "")),
        periodYear: year,
      };
    })
    .filter(Boolean);
  return JSON.stringify(concepts);
}

/** Vector determinista y normalizado a partir del texto (FNV-1a + xorshift). */
function mockEmbedding(text: string): number[] {
  let seed = 2166136261;
  for (let i = 0; i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  const vector = new Array<number>(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    vector[i] = seed / 0xffffffff - 0.5;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
}

function mockCompletion(request: CompletionRequest): string {
  switch (request.purpose) {
    case "extraction":
      return mockExtraction(request.userContent);
    case "summary":
      return `${MOCK_NOTICE} Resumen generado a partir de las cifras calculadas por el sistema: ${request.userContent.slice(0, 400)}`;
    case "chat": {
      const fragments = (request.userContent.match(/<fragmento /g) ?? []).length;
      return `${MOCK_NOTICE} Se consultaron ${fragments} fragmento(s) de los documentos del cliente.`;
    }
  }
}

export function createMockProvider(): AiProvider {
  if (env.nodeEnv === "production") {
    throw new Error("AI_PROVIDER=mock no está permitido con NODE_ENV=production.");
  }

  return {
    name: "mock",

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      if (env.aiMockLatencyMs > 0) await sleep(env.aiMockLatencyMs);
      const text = mockCompletion(request);
      // Estimación simple de tokens (~4 caracteres por token) para las métricas.
      return { text, inputTokens: Math.ceil(request.userContent.length / 4), outputTokens: Math.ceil(text.length / 4) };
    },

    async embed(texts: string[]): Promise<number[][]> {
      if (env.aiMockLatencyMs > 0) await sleep(env.aiMockLatencyMs);
      return texts.map(mockEmbedding);
    },
  };
}
