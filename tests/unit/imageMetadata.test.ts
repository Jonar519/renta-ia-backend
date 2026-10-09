import { describe, expect, it } from "vitest";
import { stripImageMetadata, UnreadableImageError } from "../../src/utils/imageMetadata";
import {
  GPS_LATITUDE,
  jpegWithGps,
  pngChunk,
  pngWith,
  pngWithMetadata,
  REAL_JPEG,
  REAL_PNG,
} from "../fixtures/images";

/**
 * Quitar metadatos de las fotos (utils/imageMetadata): lista de permitidos,
 * y lo que no se puede analizar se rechaza.
 */

/** Marcadores de los segmentos de un JPEG (sin entrar a los datos comprimidos). */
function jpegMarkers(buf: Buffer): number[] {
  const markers: number[] = [];
  let p = 2;
  while (p < buf.length) {
    const m = buf[p + 1];
    markers.push(m);
    if (m === 0xd9) break;
    p += 2 + buf.readUInt16BE(p + 2);
    if (m === 0xda) while (!(buf[p] === 0xff && buf[p + 1] !== 0 && !(buf[p + 1] >= 0xd0 && buf[p + 1] <= 0xd7))) p++;
  }
  return markers;
}

/** Tipos de bloque de un PNG. */
function pngTypes(buf: Buffer): string[] {
  const types: string[] = [];
  for (let p = 8; p < buf.length; p += 12 + buf.readUInt32BE(p)) types.push(buf.toString("latin1", p + 4, p + 8));
  return types;
}

/** Los bytes de un RATIONAL de la latitud, como quedan en el EXIF. */
const latitudeBytes = () => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(GPS_LATITUDE[0]);
  b.writeUInt32LE(1, 4);
  return b;
};

const unreadable = (mime: string, buf: Buffer) => () => stripImageMetadata(mime, buf);

describe("JPEG", () => {
  it("con EXIF y GPS: quita EXIF, XMP, IPTC, comentario e ICC; conserva la imagen byte a byte", () => {
    const withGps = jpegWithGps();
    const clean = stripImageMetadata("image/jpeg", withGps);

    for (const text of ["Exif", "TelefonoX", "xmpmeta", "Calle 26", "Photoshop", "Ana", "ICC_PROFILE"]) {
      expect(clean.includes(Buffer.from(text, "latin1")), text).toBe(false);
    }
    expect(clean.includes(latitudeBytes())).toBe(false);
    // Solo segmentos permitidos: SOI implícito, APP0 JFIF, DQT, SOF0, DHT, SOS, EOI.
    expect(new Set(jpegMarkers(clean))).toEqual(new Set([0xe0, 0xdb, 0xc0, 0xc4, 0xda, 0xd9]));
    // La imagen no cambia: el resultado es el mismo que limpiar la foto sin metadatos agregados,
    // y los datos comprimidos de la foto original están intactos.
    expect(clean.equals(stripImageMetadata("image/jpeg", REAL_JPEG))).toBe(true);
    const sos = REAL_JPEG.indexOf(Buffer.from([0xff, 0xda]));
    expect(clean.includes(REAL_JPEG.subarray(sos))).toBe(true);
    // Limpiar dos veces no cambia nada.
    expect(stripImageMetadata("image/jpeg", clean).equals(clean)).toBe(true);
  });

  it("descarta lo que viene después del final de la imagen (EOI)", () => {
    const appended = Buffer.concat([REAL_JPEG, Buffer.from("PK\x03\x04 un zip escondido", "latin1")]);
    const clean = stripImageMetadata("image/jpeg", appended);
    expect(clean.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(clean.includes(Buffer.from("zip", "latin1"))).toBe(false);
  });

  it("la miniatura de JFIF no se conserva", () => {
    const app0 = Buffer.from([0xff, 0xe0, 0, 0, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 2, 1]);
    const withThumb = Buffer.concat([app0, Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])]);
    withThumb.writeUInt16BE(withThumb.length - 2, 2);
    const jpeg = Buffer.concat([REAL_JPEG.subarray(0, 2), withThumb, REAL_JPEG.subarray(2 + 18)]);
    const clean = stripImageMetadata("image/jpeg", jpeg);
    expect(clean.includes(Buffer.from([0xaa, 0xbb, 0xcc]))).toBe(false);
    expect(clean.readUInt16BE(4)).toBe(16); // JFIF sin miniatura: 16 bytes
  });

  it("truncado (cortado a la mitad de los datos de imagen): se rechaza", () => {
    expect(unreadable("image/jpeg", jpegWithGps().subarray(0, jpegWithGps().length - 40))).toThrow(
      UnreadableImageError
    );
    expect(unreadable("image/jpeg", REAL_JPEG.subarray(0, 300))).toThrow(UnreadableImageError);
    expect(unreadable("image/jpeg", REAL_JPEG.subarray(0, 3))).toThrow(UnreadableImageError);
  });

  it("malformado: longitud fuera de rango, basura en vez de marcador, sin imagen o sin marco", () => {
    // Un segmento que dice medir más que el archivo.
    const longSegment = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(40)]);
    expect(unreadable("image/jpeg", longSegment)).toThrow(/longitud de segmento fuera de rango/);
    // Solo la firma y bytes cualquiera (lo que antes aceptaba la validación por firma).
    const signatureOnly = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
    expect(unreadable("image/jpeg", signatureOnly)).toThrow(UnreadableImageError);
    // Basura donde debería ir un marcador.
    expect(unreadable("image/jpeg", Buffer.from([0xff, 0xd8, 0x41, 0x41, 0x41, 0x41]))).toThrow(
      UnreadableImageError
    );
    // Bytes sueltos entre dos segmentos que, leídos sin exigir el 0xFF, parecerían un comentario.
    const stray = Buffer.concat([REAL_JPEG.subarray(0, 20), Buffer.from([0xfe, 0x00, 0x04, 0x41, 0x41]), REAL_JPEG.subarray(20)]);
    expect(unreadable("image/jpeg", stray)).toThrow(/se esperaba un marcador/);
    // EOI sin datos de imagen.
    expect(unreadable("image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toThrow(UnreadableImageError);
    // Datos de imagen (SOS) sin marco (SOF): se quita el SOF0 de la foto real.
    const sof = REAL_JPEG.indexOf(Buffer.from([0xff, 0xc0]));
    const noFrame = Buffer.concat([REAL_JPEG.subarray(0, sof), REAL_JPEG.subarray(sof + 2 + 17)]);
    expect(unreadable("image/jpeg", noFrame)).toThrow(UnreadableImageError);
  });
});

describe("PNG", () => {
  it("con metadatos (tEXt, iTXt, eXIf, tIME, iCCP): se quitan y queda el PNG original exacto", () => {
    const withMetadata = pngWithMetadata();
    expect(pngTypes(withMetadata)).toEqual(["IHDR", "tEXt", "iTXt", "eXIf", "tIME", "iCCP", "IDAT", "IEND"]);
    const clean = stripImageMetadata("image/png", withMetadata);
    expect(pngTypes(clean)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(clean.equals(REAL_PNG)).toBe(true);
    for (const text of ["GPS", "xmpmeta", "TelefonoX", "Perfil"]) {
      expect(clean.includes(Buffer.from(text, "latin1")), text).toBe(false);
    }
  });

  it("conserva los bloques de color y visualización permitidos", () => {
    const srgb = pngChunk("sRGB", Buffer.from([0]));
    const phys = pngChunk("pHYs", Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]));
    const clean = stripImageMetadata("image/png", pngWith([srgb, phys]));
    expect(pngTypes(clean)).toEqual(["IHDR", "sRGB", "pHYs", "IDAT", "IEND"]);
  });

  it("descarta lo que viene después de IEND", () => {
    const appended = Buffer.concat([REAL_PNG, Buffer.from("datos escondidos", "latin1")]);
    expect(stripImageMetadata("image/png", appended).equals(REAL_PNG)).toBe(true);
  });

  it("truncado (sin IEND o cortado a mitad de un bloque): se rechaza", () => {
    expect(unreadable("image/png", REAL_PNG.subarray(0, REAL_PNG.length - 12))).toThrow(UnreadableImageError);
    expect(unreadable("image/png", REAL_PNG.subarray(0, 40))).toThrow(UnreadableImageError);
    expect(unreadable("image/png", pngWithMetadata().subarray(0, 60))).toThrow(UnreadableImageError);
  });

  it("malformado: CRC incorrecto, longitud fuera de rango, sin IHDR o bloque crítico desconocido", () => {
    const badCrc = Buffer.from(REAL_PNG);
    badCrc[8 + 8 + 2] ^= 0xff; // un byte del ancho de IHDR
    expect(unreadable("image/png", badCrc)).toThrow(/CRC/);
    const badLength = Buffer.from(REAL_PNG);
    badLength.writeUInt32BE(0x7fffffff, 8);
    expect(unreadable("image/png", badLength)).toThrow(UnreadableImageError);
    const noIhdr = Buffer.concat([REAL_PNG.subarray(0, 8), REAL_PNG.subarray(33)]);
    expect(unreadable("image/png", noIhdr)).toThrow(UnreadableImageError);
    expect(unreadable("image/png", pngWith([pngChunk("ABCD", Buffer.from("x"))]))).toThrow(/crítico/);
  });
});

it("un tipo que no es PNG ni JPEG no se analiza", () => {
  expect(unreadable("image/gif", Buffer.from("GIF89a"))).toThrow(UnreadableImageError);
});
