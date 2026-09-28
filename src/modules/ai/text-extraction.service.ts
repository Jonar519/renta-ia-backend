import path from "path";
import pdfParse from "pdf-parse";
import { createWorker } from "tesseract.js";

/**
 * Extrae el texto de un documento.
 *
 * Alcance de esta fase (curso):
 *  - PDF con capa de texto (generado digitalmente, no escaneado): se lee
 *    directamente con pdf-parse. Es el caso más común para certificados
 *    de ingresos, extractos bancarios digitales, etc.
 *  - Imagen (jpg/png): se usa OCR real con Tesseract.js (español).
 *  - PDF escaneado (imagen dentro de un PDF, sin texto): NO soportado en
 *    esta fase — lanza un error claro pidiendo subir el documento como
 *    imagen. En producción esto se resolvería con un servicio de OCR en
 *    la nube (AWS Textract), tal como está previsto en la arquitectura.
 */
export const textExtractionService = {
  async extractText(buffer: Buffer, originalName: string): Promise<string> {
    const ext = path.extname(originalName).toLowerCase();

    if (ext === ".pdf") {
      // Copia a un Uint8Array con memoria propia: fs.readFileSync devuelve,
      // para archivos pequeños (< 4 KB), un Buffer que es una VISTA dentro
      // del pool compartido de Node (byteOffset ≠ 0), y el pdf.js que usa
      // pdf-parse lee su ArrayBuffer subyacente ignorando ese desplazamiento
      // → "bad XRef entry" en PDFs válidos. La copia cuesta O(tamaño).
      const result = await pdfParse(new Uint8Array(buffer) as unknown as Buffer);
      const text = (result.text ?? "").trim();

      if (text.length > 20) {
        return text;
      }

      throw new Error(
        "El PDF no tiene texto extraíble (parece un documento escaneado). " +
          "Por ahora, sube el documento como imagen (JPG/PNG) para que el OCR pueda leerlo."
      );
    }

    if ([".png", ".jpg", ".jpeg"].includes(ext)) {
      const worker = await createWorker("spa");
      try {
        const {
          data: { text },
        } = await worker.recognize(buffer);
        return text;
      } finally {
        await worker.terminate();
      }
    }

    throw new Error(`Tipo de archivo no soportado para extracción de texto: "${ext}"`);
  },
};
