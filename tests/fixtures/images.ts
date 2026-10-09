import fs from "fs";
import path from "path";

/**
 * Imágenes reales para las pruebas de la foto de perfil y de los metadatos.
 *  - JPEG de 16×16 generado por Chrome (canvas.toDataURL; trae un perfil ICC
 *    en APP2, como las fotos de verdad).
 *  - PNG de 1×1.
 * Y constructores para agregarles metadatos como los de una cámara o un
 * teléfono: EXIF con ubicación GPS, XMP, comentarios, textos PNG.
 */
export const REAL_JPEG = fs.readFileSync(path.join(__dirname, "foto-chrome-16x16.jpg"));
export const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** Coordenadas de prueba (Bogotá) tal como quedan dentro del EXIF. */
export const GPS_LATITUDE = [4, 36, 35];
export const GPS_LONGITUDE = [74, 4, 54];

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/**
 * APP1 EXIF real (TIFF little-endian): IFD0 con Make y el puntero GPSInfo;
 * el IFD de GPS con latitud N y longitud W en grados/minutos/segundos.
 */
export function exifWithGps(): Buffer {
  const tiff = Buffer.alloc(200);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 en 8
  // IFD0: 2 entradas (Make, GPSInfo).
  let p = 8;
  tiff.writeUInt16LE(2, p);
  p += 2;
  const entry = (tag: number, type: number, count: number, value: number) => {
    tiff.writeUInt16LE(tag, p);
    tiff.writeUInt16LE(type, p + 2);
    tiff.writeUInt32LE(count, p + 4);
    tiff.writeUInt32LE(value, p + 8);
    p += 12;
  };
  entry(0x010f, 2, 10, 120); // Make (ASCII) → "TelefonoX\0" en 120
  entry(0x8825, 4, 1, 38); // GPSInfo → IFD de GPS en 38
  tiff.writeUInt32LE(0, p); // sin IFD siguiente (p = 34)
  // IFD de GPS en 38: 4 entradas.
  p = 38;
  tiff.writeUInt16LE(4, p);
  p += 2;
  const ascii2 = (s: string) => s.charCodeAt(0); // "N\0" cabe en el valor
  entry(0x0001, 2, 2, ascii2("N")); // GPSLatitudeRef
  entry(0x0002, 5, 3, 140); // GPSLatitude (3 RATIONAL) en 140
  entry(0x0003, 2, 2, ascii2("W")); // GPSLongitudeRef
  entry(0x0004, 5, 3, 164); // GPSLongitude en 164
  tiff.writeUInt32LE(0, p);
  tiff.write("TelefonoX\0", 120, "latin1");
  GPS_LATITUDE.forEach((v, i) => {
    tiff.writeUInt32LE(v, 140 + i * 8);
    tiff.writeUInt32LE(1, 144 + i * 8);
  });
  GPS_LONGITUDE.forEach((v, i) => {
    tiff.writeUInt32LE(v, 164 + i * 8);
    tiff.writeUInt32LE(1, 168 + i * 8);
  });
  return jpegSegment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]));
}

/** El JPEG real con EXIF+GPS, XMP, un comentario y un APP13 (Photoshop/IPTC) tras el SOI. */
export function jpegWithGps(base = REAL_JPEG): Buffer {
  return Buffer.concat([
    base.subarray(0, 2),
    exifWithGps(),
    jpegSegment(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Calle 26 # 57-41</x:xmpmeta>", "latin1")),
    jpegSegment(0xed, Buffer.from("Photoshop 3.0\0IPTC: Ana Pérez", "latin1")),
    jpegSegment(0xfe, Buffer.from("Tomada en la oficina de Ana", "latin1")),
    base.subarray(2),
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (data: Buffer) => {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Un bloque PNG con su CRC correcto. */
export function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

const AFTER_IHDR = 8 + 12 + 13;

/** Inserta bloques justo después de IHDR. */
export function pngWith(chunks: Buffer[], base = REAL_PNG): Buffer {
  return Buffer.concat([base.subarray(0, AFTER_IHDR), ...chunks, base.subarray(AFTER_IHDR)]);
}

/** El PNG real con texto, iTXt (XMP), eXIf, tIME e iCCP: todo lo que una app suele agregar. */
export function pngWithMetadata(): Buffer {
  return pngWith([
    pngChunk("tEXt", Buffer.from("Comment\0GPS 4.6097,-74.0817", "latin1")),
    pngChunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>Calle 26</x:xmpmeta>", "latin1")),
    pngChunk("eXIf", exifWithGps().subarray(10)), // el TIFF, sin el "Exif\0\0"
    pngChunk("tIME", Buffer.from([0x07, 0xea, 10, 9, 12, 0, 0])),
    pngChunk("iCCP", Buffer.from("Perfil de TelefonoX\0\0", "latin1")),
  ]);
}
