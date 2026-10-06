import { encode } from "uqr";

/**
 * QR del enlace otpauth:// como SVG, generado en el SERVIDOR (Fase 5, B9).
 *
 * Medido antes de decidir: una librería de QR en el navegador pesa de 4,4 KB
 * (uqr, lean-qr) a 9,7 KB (qrcode) en gzip, y el presupuesto de JS total
 * (42 KB) no tiene ese margen. Aquí el cliente no descarga código: recibe el
 * SVG en la respuesta de /setup y lo muestra con <img src="data:…"> (la CSP ya
 * permite img-src data:), sin insertar marcado en el DOM.
 *
 * uqr (MIT, sin dependencias) calcula la matriz; el SVG se dibuja aquí con un
 * rectángulo por cada tramo horizontal de módulos oscuros (no uno por módulo),
 * con el margen de 4 módulos que pide la norma para que lo lean las cámaras.
 */
export function qrSvg(text: string): string {
  const { size, data } = encode(text, { ecc: "M", border: 4 });
  let path = "";
  data.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < size && row[x]) x += 1;
      path += `M${start} ${y}h${x - start}v1H${start}z`;
    }
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  );
}
