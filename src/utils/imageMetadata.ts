/**
 * Quita los metadatos de una foto (Fase 5, antes de B13) sin dependencias:
 * recorre la estructura del archivo y CONSERVA SOLO lo conocido como seguro
 * (lista de permitidos); lo demás se descarta. EXIF (con la ubicación GPS, el
 * modelo de la cámara, la fecha), XMP, perfiles ICC, comentarios, textos y
 * cualquier dato después del final de la imagen no llegan al almacenamiento.
 *
 * Si la estructura no se puede analizar (archivo truncado, longitudes fuera
 * de rango, CRC incorrecto, sin final), se lanza UnreadableImageError y la
 * foto se rechaza: nunca se guarda el original.
 *
 * No decodifica los píxeles (no hace falta para quitar metadatos): la imagen
 * comprimida se copia byte a byte, así que no pierde calidad.
 */

export class UnreadableImageError extends Error {
  constructor(reason: string) {
    super(`Imagen ilegible: ${reason}`);
    this.name = "UnreadableImageError";
  }
}

const fail = (reason: string): never => {
  throw new UnreadableImageError(reason);
};

export function stripImageMetadata(mimetype: string, buffer: Buffer): Buffer {
  if (mimetype === "image/jpeg") return stripJpeg(buffer);
  if (mimetype === "image/png") return stripPng(buffer);
  return fail(`tipo no soportado (${mimetype})`);
}

// ---------- JPEG ----------

// Segmentos que se conservan tal cual: tablas de cuantización y Huffman,
// codificación aritmética, intervalo de reinicio y los SOFn (marco: tamaño y
// componentes). SOS se trata aparte (le siguen los datos comprimidos).
const JPEG_DQT = 0xdb;
const JPEG_DHT = 0xc4;
const JPEG_DAC = 0xcc;
const JPEG_DRI = 0xdd;
const JPEG_SOS = 0xda;
const JPEG_EOI = 0xd9;
const JPEG_SOI = 0xd8;
const JPEG_APP0 = 0xe0;
const JPEG_APP14 = 0xee;
// SOF0–SOF15 salvo C4 (DHT), C8 (reservado) y CC (DAC).
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== JPEG_DHT && m !== 0xc8 && m !== JPEG_DAC;
const KEEP_AS_IS = (m: number) => m === JPEG_DQT || m === JPEG_DHT || m === JPEG_DAC || m === JPEG_DRI || isSof(m);
const isRst = (m: number) => m >= 0xd0 && m <= 0xd7;

function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function stripJpeg(buf: Buffer): Buffer {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== JPEG_SOI) fail("JPEG sin inicio (SOI)");
  const out: Buffer[] = [Buffer.from([0xff, JPEG_SOI])];
  let pos = 2;
  let frame = false; // vio un SOFn válido
  let scans = 0;

  for (;;) {
    if (pos >= buf.length) fail("JPEG truncado (sin EOI)");
    if (buf[pos] !== 0xff) fail(`JPEG: se esperaba un marcador en ${pos}`);
    while (pos < buf.length && buf[pos] === 0xff) pos++; // bytes de relleno 0xFF
    if (pos >= buf.length) fail("JPEG truncado (marcador sin tipo)");
    const marker = buf[pos++]!;

    if (marker === JPEG_EOI) {
      if (scans === 0) fail("JPEG sin datos de imagen");
      out.push(Buffer.from([0xff, JPEG_EOI]));
      return Buffer.concat(out); // lo que venga después del EOI se descarta
    }
    if (marker === JPEG_SOI || marker === 0x00 || marker === 0x01 || isRst(marker)) {
      fail(`JPEG: marcador 0x${marker.toString(16)} fuera de lugar`);
    }

    if (pos + 2 > buf.length) fail("JPEG truncado (longitud de segmento)");
    const length = buf.readUInt16BE(pos);
    if (length < 2 || pos + length > buf.length) fail("JPEG: longitud de segmento fuera de rango");
    const payload = buf.subarray(pos + 2, pos + length);
    pos += length;

    if (marker === JPEG_APP0) {
      // JFIF: se conserva solo el encabezado (versión, unidades y densidad),
      // sin la miniatura que puede traer.
      if (payload.length >= 14 && payload.subarray(0, 5).toString("latin1") === "JFIF\0") {
        out.push(segment(JPEG_APP0, Buffer.concat([payload.subarray(0, 12), Buffer.from([0, 0])])));
      }
    } else if (marker === JPEG_APP14) {
      // Adobe: indica la transformación de color (sin él, un JPEG CMYK o
      // YCCK se vería con colores errados). Tamaño fijo, sin texto libre.
      if (payload.length === 12 && payload.subarray(0, 5).toString("latin1") === "Adobe") {
        out.push(segment(JPEG_APP14, payload));
      }
    } else if (KEEP_AS_IS(marker)) {
      if (isSof(marker)) {
        if (payload.length < 6) fail("JPEG: SOF incompleto");
        const height = payload.readUInt16BE(1);
        const width = payload.readUInt16BE(3);
        const components = payload[5]!;
        if (width === 0 || height === 0 || components === 0 || payload.length !== 6 + 3 * components) {
          fail("JPEG: SOF inválido");
        }
        if (frame) fail("JPEG con más de un marco (SOF)");
        frame = true;
      }
      out.push(segment(marker, payload));
    } else if (marker === JPEG_SOS) {
      if (!frame) fail("JPEG: datos de imagen antes del marco (SOF)");
      out.push(segment(marker, payload));
      // Datos comprimidos: hasta el próximo marcador que no sea relleno
      // (FF 00) ni reinicio (FF D0–D7).
      const start = pos;
      for (;;) {
        if (pos + 1 >= buf.length) fail("JPEG truncado (datos de imagen sin terminar)");
        if (buf[pos] === 0xff) {
          const next = buf[pos + 1]!;
          if (next !== 0x00 && next !== 0xff && !isRst(next)) break;
        }
        pos++;
      }
      out.push(buf.subarray(start, pos));
      scans++;
    }
    // Cualquier otro segmento (APP1 EXIF/XMP, APP2 ICC, APP3–APP13, APP15,
    // COM, extensiones y reservados) se descarta.
  }
}

// ---------- PNG ----------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Críticos y auxiliares de color/visualización, sin texto libre.
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "sBIT", "pHYs", "bKGD"]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function stripPng(buf: Buffer): Buffer {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) fail("PNG sin firma");
  const out: Buffer[] = [PNG_SIGNATURE];
  let pos = 8;
  let first = true;
  let idat = false;

  for (;;) {
    if (pos + 12 > buf.length) fail("PNG truncado (sin IEND)");
    const length = buf.readUInt32BE(pos);
    if (length > buf.length - pos - 12) fail("PNG: longitud de bloque fuera de rango");
    const typeAndData = buf.subarray(pos + 4, pos + 8 + length);
    const type = typeAndData.subarray(0, 4).toString("latin1");
    if (!/^[A-Za-z]{4}$/.test(type)) fail("PNG: tipo de bloque inválido");
    if (crc32(typeAndData) !== buf.readUInt32BE(pos + 8 + length)) fail(`PNG: CRC incorrecto en ${type}`);
    const chunk = buf.subarray(pos, pos + 12 + length);
    pos += 12 + length;

    if (first) {
      if (type !== "IHDR" || length !== 13) fail("PNG: el primer bloque no es IHDR");
      if (typeAndData.readUInt32BE(4) === 0 || typeAndData.readUInt32BE(8) === 0) fail("PNG: tamaño cero");
      first = false;
    }
    if (type === "IDAT") idat = true;
    if (type === "IEND") {
      if (!idat) fail("PNG sin datos de imagen");
      out.push(chunk);
      return Buffer.concat(out); // lo que venga después del IEND se descarta
    }
    if (PNG_KEEP.has(type)) out.push(chunk);
    // Un bloque crítico desconocido (mayúscula inicial) impide leer la imagen.
    else if (/^[A-Z]/.test(type)) fail(`PNG: bloque crítico desconocido ${type}`);
    // Los auxiliares no permitidos (tEXt, zTXt, iTXt, eXIf, tIME, iCCP…) se descartan.
  }
}
