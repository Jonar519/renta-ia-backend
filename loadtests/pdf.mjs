// Genera un PDF mínimo válido (con xref correcta) y texto extraíble.
// Cada llamada con un `seed` distinto produce un archivo distinto (distinto
// SHA-256), para que la deduplicación de subidas no descarte la ráfaga.
export function syntheticCertificate(seed) {
  const lines = [
    "Certificado de ingresos y retenciones - ano gravable 2025 (DATOS SINTETICOS DE PRUEBA DE CARGA)",
    `Referencia de prueba: ${seed}`,
    "Ingresos laborales: $ 85.000.000",
    "Retencion en la fuente: $ 6.200.000",
    "Aportes a pension: $ 3.400.000",
    "Aportes a salud: $ 3.400.000",
  ];
  const text = lines.map((l, i) => `BT /F1 12 Tf 50 ${750 - i * 20} Td (${l}) Tj ET`).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out +=
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
