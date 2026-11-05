import { z } from "zod";
import { logger } from "../../config/logger";
import { getAiProvider } from "../../services/llm/provider";
import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../../services/llm/untrusted";

export type TaxConceptType =
  "gross_income" | "withholding" | "deduction" | "pension_contribution" | "health_contribution" | "other";

export interface ExtractedConcept {
  conceptType: TaxConceptType;
  description: string;
  amount: number;
  periodYear: number;
}

export const SYSTEM_PROMPT = `Eres un asistente experto en normativa tributaria colombiana.
Tu única tarea es leer el texto de un documento contable y extraer las cifras tributarias
relevantes en formato JSON. Responde ÚNICAMENTE con un arreglo JSON válido, sin texto
adicional, sin explicaciones, sin bloques de markdown. Si no encuentras ninguna cifra
relevante, responde con un arreglo vacío [].

Cada elemento del arreglo debe tener EXACTAMENTE esta forma:
{
  "conceptType": "gross_income" | "withholding" | "deduction" | "pension_contribution" | "health_contribution" | "other",
  "description": "string corto describiendo el concepto",
  "amount": number (sin puntos de miles ni comas, solo el número),
  "periodYear": number (año fiscal, ej. 2025)
}

El texto del documento llega dentro de <documento>...</documento>. ${UNTRUSTED_CONTENT_RULE}`;

/**
 * Schema de UN concepto devuelto por el LLM. Los límites coinciden con las
 * columnas/CHECKs de tax_concepts, para que un concepto que pase aquí nunca
 * haga fallar el INSERT.
 */
const extractedConceptSchema = z.object({
  conceptType: z.enum([
    "gross_income",
    "withholding",
    "deduction",
    "pension_contribution",
    "health_contribution",
    "other",
  ]),
  description: z
    .string()
    .nullish()
    .transform((value) => (value ?? "").slice(0, 255)),
  // Se acepta "1500000" además de 1500000, pero no "abc" ni negativos.
  amount: z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? Number(value) : value),
    z.number().finite().nonnegative()
  ),
  periodYear: z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? Number(value) : value),
    z.number().int().min(2000).max(2100)
  ),
});

/** Quita un bloque ```json ... ``` si el modelo lo agregó pese a la instrucción. */
function stripMarkdownFences(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]! : text.trim();
}

/**
 * Convierte la respuesta de texto del LLM en conceptos válidos. Un concepto
 * inválido se descarta individualmente (con warning) en vez de invalidar
 * toda la respuesta.
 */
export function parseExtractedConcepts(rawText: string): ExtractedConcept[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownFences(rawText));
  } catch {
    logger.warn({ preview: rawText.slice(0, 200) }, "No se pudo interpretar la respuesta del LLM como JSON");
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger.warn("La respuesta del LLM no es un arreglo JSON; se ignora");
    return [];
  }

  const concepts: ExtractedConcept[] = [];
  parsed.forEach((item, index) => {
    const result = extractedConceptSchema.safeParse(item);
    if (result.success) {
      concepts.push(result.data);
    } else {
      logger.warn(
        { index, issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
        "Concepto tributario inválido descartado"
      );
    }
  });
  return concepts;
}

/** Tope de tokens de salida de la extracción (razonamiento + JSON). */
export const EXTRACTION_MAX_TOKENS = 8000;

export const extractionService = {
  async extractTaxConcepts(documentText: string): Promise<ExtractedConcept[]> {
    const { text, stopReason } = await getAiProvider().complete({
      purpose: "extraction",
      system: SYSTEM_PROMPT,
      // Tope holgado: con Sonnet 5 el razonamiento también cuenta dentro de max_tokens, y
      // un JSON cortado se perdería entero. El tope no se cobra si no se usa.
      maxTokens: EXTRACTION_MAX_TOKENS,
      // El texto del documento es contenido externo: va delimitado y el
      // prompt de sistema indica tratarlo solo como datos.
      userContent: wrapUntrusted("documento", documentText.slice(0, 12000)),
    });
    // Una respuesta cortada no es "0 conceptos": se informa como fallo (el worker lo guarda
    // como advertencia del documento) en vez de descartarla en silencio.
    if (stopReason === "max_tokens") {
      throw new Error(
        `La respuesta de la IA quedó cortada (max_tokens = ${EXTRACTION_MAX_TOKENS}): no se guardan conceptos parciales.`
      );
    }
    return text === null ? [] : parseExtractedConcepts(text);
  },
};
