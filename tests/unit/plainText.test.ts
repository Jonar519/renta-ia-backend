import { describe, expect, it } from "vitest";
import { PLAIN_TEXT_RULE, stripMarkdownEmphasis } from "../../src/services/llm/plainText";
import { SYSTEM_PROMPT as CHAT_PROMPT } from "../../src/modules/ai/rag.service";
import { SUMMARY_SYSTEM_PROMPT } from "../../src/modules/clients/summary.service";

describe("stripMarkdownEmphasis: el texto del modelo se muestra sin asteriscos", () => {
  it.each([
    ["el caso de producción", "El ingreso bruto fue de **$2.150.000**.", "El ingreso bruto fue de $2.150.000."],
    ["cursiva", "Es un saldo *a favor* del cliente.", "Es un saldo a favor del cliente."],
    ["negrita y cursiva juntas", "***Importante***: revisa el certificado.", "Importante: revisa el certificado."],
    ["negrita sin pareja (respuesta cortada)", "El total es **$85.000.000", "El total es $85.000.000"],
    ["asterisco suelto pegado", "Valor estimado*", "Valor estimado"],
    ["varias en una línea", "**Ingresos**: $1 y **retenciones**: $2", "Ingresos: $1 y retenciones: $2"],
  ])("%s", (_label, input, expected) => {
    expect(stripMarkdownEmphasis(input)).toBe(expected);
  });

  it("las viñetas con * pasan a guiones y conservan la sangría", () => {
    expect(stripMarkdownEmphasis("Conceptos:\n* Salarios: **$85.000.000**\n  * Pensión: $3.400.000")).toBe(
      "Conceptos:\n- Salarios: $85.000.000\n  - Pensión: $3.400.000"
    );
  });

  it("no toca multiplicaciones ni el resto del texto", () => {
    expect(stripMarkdownEmphasis("Base: 2 * 3 = 6 y 4*5 = 20")).toBe("Base: 2 * 3 = 6 y 4*5 = 20");
    const plain = "Sin formato: $2.150.000 (20 %), guiones - y <etiquetas> intactas.";
    expect(stripMarkdownEmphasis(plain)).toBe(plain);
  });

  it("la negrita no cruza saltos de línea", () => {
    expect(stripMarkdownEmphasis("**uno\ndos**")).toBe("uno\ndos");
  });
});

describe("Los prompts del chat y del resumen piden texto plano", () => {
  it.each([
    ["chat", CHAT_PROMPT],
    ["resumen", SUMMARY_SYSTEM_PROMPT],
  ])("%s", (_label, prompt) => {
    expect(prompt).toContain(PLAIN_TEXT_RULE);
    expect(PLAIN_TEXT_RULE).toMatch(/sin Markdown/);
  });
});
