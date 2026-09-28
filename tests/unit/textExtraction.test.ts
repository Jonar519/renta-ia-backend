import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { textExtractionService } from "../../src/modules/ai/text-extraction.service";

// PDF sintético de ~1,4 KB (generado con pdf-lib; datos ficticios).
const fixture = fs.readFileSync(path.join(__dirname, "../fixtures/certificado-pequeno.pdf"));

/**
 * Reproduce de forma determinista lo que hace fs.readFileSync con un archivo
 * pequeño: devolver un Buffer que es una vista (byteOffset 8) dentro de un
 * ArrayBuffer compartido más grande.
 */
function pooledView(bytes: Buffer): Buffer {
  const pool = new ArrayBuffer(8192);
  const view = Buffer.from(pool, 8, bytes.length);
  bytes.copy(view);
  return view;
}

describe("textExtractionService (PDF)", () => {
  it("extrae el texto de un PDF pequeño aunque el Buffer sea una vista de un pool", async () => {
    const view = pooledView(fixture);
    expect(view.byteOffset).toBe(8);
    const text = await textExtractionService.extractText(view, "certificado.pdf");
    expect(text).toContain("Ingresos laborales: $ 85.000.000");
    expect(text).toContain("Retencion en la fuente: $ 6.200.000");
  });

  it("rechaza extensiones no soportadas", async () => {
    await expect(textExtractionService.extractText(fixture, "archivo.docx")).rejects.toThrow(/no soportado/);
  });
});
