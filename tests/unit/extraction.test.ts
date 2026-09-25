import { describe, expect, it } from "vitest";
import { parseExtractedConcepts } from "../../src/modules/ai/extraction.service";

const valid = { conceptType: "gross_income", description: "Salario", amount: 85000000, periodYear: 2025 };

describe("parseExtractedConcepts (respuesta del LLM)", () => {
  it("parsea un arreglo JSON válido", () => {
    expect(parseExtractedConcepts(JSON.stringify([valid]))).toEqual([valid]);
  });

  it("tolera la respuesta envuelta en un bloque ```json de markdown", () => {
    const text = "```json\n" + JSON.stringify([valid]) + "\n```";
    expect(parseExtractedConcepts(text)).toEqual([valid]);
  });

  it("devuelve [] si el JSON es inválido", () => {
    expect(parseExtractedConcepts("Aquí están los conceptos: [{roto")).toEqual([]);
  });

  it("devuelve [] si el JSON no es un arreglo", () => {
    expect(parseExtractedConcepts(JSON.stringify(valid))).toEqual([]);
  });

  it("descarta solo los conceptos inválidos y conserva los válidos", () => {
    const text = JSON.stringify([
      valid,
      { ...valid, conceptType: "inventado" },
      { ...valid, amount: "abc" },
      { ...valid, amount: -10 },
      { ...valid, periodYear: 1850 },
      { ...valid, conceptType: "withholding", amount: "6200000" },
    ]);
    expect(parseExtractedConcepts(text)).toEqual([valid, { ...valid, conceptType: "withholding", amount: 6200000 }]);
  });

  it("recorta descripciones de más de 255 caracteres y acepta description nula", () => {
    const [long, nulo] = parseExtractedConcepts(
      JSON.stringify([
        { ...valid, description: "x".repeat(400) },
        { ...valid, description: null },
      ])
    );
    expect(long!.description).toHaveLength(255);
    expect(nulo!.description).toBe("");
  });
});
