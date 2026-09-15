import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env";

function getClient(): Anthropic {
  if (!env.anthropicApiKey) {
    throw new Error(
      "Falta configurar ANTHROPIC_API_KEY en el archivo .env para poder usar la extracción con IA."
    );
  }
  return new Anthropic({ apiKey: env.anthropicApiKey });
}

export type TaxConceptType =
  | "gross_income"
  | "withholding"
  | "deduction"
  | "pension_contribution"
  | "health_contribution"
  | "other";

export interface ExtractedConcept {
  conceptType: TaxConceptType;
  description: string;
  amount: number;
  periodYear: number;
}

const SYSTEM_PROMPT = `Eres un asistente experto en normativa tributaria colombiana.
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
}`;

export const extractionService = {
  async extractTaxConcepts(documentText: string): Promise<ExtractedConcept[]> {
    const client = getClient();

    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Texto del documento:\n\n${documentText.slice(0, 12000)}`,
        },
      ],
    });

    const textBlock = message.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return [];
    }

    try {
      const parsed = JSON.parse(textBlock.text);
      return Array.isArray(parsed) ? (parsed as ExtractedConcept[]) : [];
    } catch (err) {
      console.error("No se pudo interpretar la respuesta del LLM como JSON:", textBlock.text);
      return [];
    }
  },
};
