import { describe, expect, it } from "vitest";
import { embeddingsService } from "../../src/modules/ai/embeddings.service";

const { chunkText } = embeddingsService;

describe("chunkText", () => {
  it("un texto corto produce un solo fragmento", () => {
    expect(chunkText("hola mundo")).toEqual(["hola mundo"]);
  });

  it("texto vacío o solo espacios no produce fragmentos", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("     ")).toEqual([]);
  });

  it("divide en fragmentos del tamaño indicado con superposición", () => {
    const text = "abcdefghij".repeat(3); // 30 caracteres
    const chunks = chunkText(text, 10, 2);
    expect(chunks[0]).toBe("abcdefghij");
    expect(chunks[1]).toBe(text.slice(8, 18)); // empieza 2 caracteres antes del final del anterior
    expect(chunks.every((c) => c.length <= 10)).toBe(true);
    // el último fragmento llega hasta el final del texto
    expect(text.endsWith(chunks[chunks.length - 1]!)).toBe(true);
  });

  it("con los valores por defecto (1000/100) cubre todo el texto", () => {
    const text = "x".repeat(2500);
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(3); // inicios en 0, 900 y 1800
    expect(chunks[2]).toHaveLength(700);
  });
});
