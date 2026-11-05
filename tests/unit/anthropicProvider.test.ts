import { beforeEach, describe, expect, it, vi } from "vitest";
import { anthropicProvider, CLAUDE_MODEL } from "../../src/services/llm/anthropic.provider";
import { AiRefusalError } from "../../src/services/llm/provider";
import { EXTRACTION_MAX_TOKENS, extractionService } from "../../src/modules/ai/extraction.service";

/**
 * Proveedor real (Claude) con el SDK simulado. Las respuestas imitan las de Sonnet 5, que
 * razona por defecto: un bloque "thinking" antes del texto, y ese razonamiento cuenta
 * dentro de max_tokens. Lo que se prueba es cómo se traduce stop_reason.
 */
const createMessage = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  // `function` (no flecha): vitest 4 exige un constructor para `new Anthropic(...)`.
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: createMessage } };
  }),
}));

const usage = { input_tokens: 120, output_tokens: 80 };
const request = { purpose: "chat" as const, system: "sistema", userContent: "pregunta", maxTokens: 4000 };

// Cuerpo de bloque a propósito: si beforeEach DEVUELVE una función, Vitest la ejecuta como teardown.
beforeEach(() => {
  createMessage.mockReset();
});

describe("anthropicProvider.complete", () => {
  it("manda el modelo, el sistema y max_tokens tal cual; devuelve texto, tokens y stopReason", async () => {
    createMessage.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "Hola" }], usage });
    await expect(anthropicProvider.complete(request)).resolves.toEqual({
      text: "Hola",
      inputTokens: 120,
      outputTokens: 80,
      stopReason: "end_turn",
    });
    expect(createMessage).toHaveBeenCalledWith({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      system: "sistema",
      messages: [{ role: "user", content: "pregunta" }],
    });
  });

  it("con razonamiento (bloque thinking primero), toma el texto del bloque de texto", async () => {
    createMessage.mockResolvedValue({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "", signature: "firma" },
        { type: "text", text: "Respuesta final" },
      ],
      usage,
    });
    const result = await anthropicProvider.complete(request);
    expect(result.text).toBe("Respuesta final");
    expect(result.stopReason).toBe("end_turn");
  });

  it("si max_tokens se agota razonando, no hay texto y stopReason lo dice", async () => {
    createMessage.mockResolvedValue({
      stop_reason: "max_tokens",
      content: [{ type: "thinking", thinking: "", signature: "firma" }],
      usage: { input_tokens: 120, output_tokens: 4000 },
    });
    await expect(anthropicProvider.complete(request)).resolves.toMatchObject({ text: null, stopReason: "max_tokens" });
  });

  it("un 'refusal' lanza AiRefusalError (aunque traiga texto parcial) con el uso que lo provocó", async () => {
    createMessage.mockResolvedValue({ stop_reason: "refusal", content: [{ type: "text", text: "parcial" }], usage });
    const error = await anthropicProvider.complete({ ...request, purpose: "summary" }).catch((e) => e);
    expect(error).toBeInstanceOf(AiRefusalError);
    expect(error.purpose).toBe("summary");
  });
});

describe("extracción con stop_reason", () => {
  const concept = { conceptType: "gross_income", description: "Salario", amount: 85000000, periodYear: 2025 };

  it("pide max_tokens holgado (EXTRACTION_MAX_TOKENS) y parsea el JSON aunque venga después del razonamiento", async () => {
    createMessage.mockResolvedValue({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "", signature: "firma" },
        { type: "text", text: JSON.stringify([concept]) },
      ],
      usage,
    });
    await expect(extractionService.extractTaxConcepts("Salario $ 85.000.000 año 2025")).resolves.toEqual([concept]);
    expect(createMessage.mock.calls[0]![0].max_tokens).toBe(EXTRACTION_MAX_TOKENS);
    expect(EXTRACTION_MAX_TOKENS).toBeGreaterThanOrEqual(8000);
  });

  it("una respuesta cortada (max_tokens) es un error explícito, no '0 conceptos' en silencio", async () => {
    createMessage.mockResolvedValue({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: '[{"conceptType":"gross_income","descr' }],
      usage,
    });
    await expect(extractionService.extractTaxConcepts("texto")).rejects.toThrow(/quedó cortada \(max_tokens = 8000\)/);
  });

  it("un rechazo del modelo llega al worker como error (que lo guarda como advertencia)", async () => {
    createMessage.mockResolvedValue({ stop_reason: "refusal", content: [], usage });
    await expect(extractionService.extractTaxConcepts("texto")).rejects.toBeInstanceOf(AiRefusalError);
  });
});
