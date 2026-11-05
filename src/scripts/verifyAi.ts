/**
 * npm run ai:verify — verificación de la IA REAL antes y después del despliegue (ensayo).
 *
 * Hace una llamada por cada uso (extracción, chat y resumen) con su prompt de sistema y su
 * max_tokens reales, por el proveedor real (Claude), y un embedding de Voyage. Muestra por
 * qué terminó cada respuesta (stop_reason), los tokens y la latencia. Sale con código 1 si
 * alguna no terminó en "end_turn", si no trajo texto o si el embedding no tiene 1024
 * dimensiones (la columna vector(1024)).
 *
 * Usa ANTHROPIC_API_KEY y VOYAGE_API_KEY del entorno y NUNCA las muestra. Cuesta unos
 * centavos. Datos ficticios: no se envía nada de la base.
 */
import { anthropicProvider, CLAUDE_MODEL } from "../services/llm/anthropic.provider";
import { AiRefusalError, CompletionRequest } from "../services/llm/provider";
import { wrapUntrusted } from "../services/llm/untrusted";
import { EXTRACTION_MAX_TOKENS, SYSTEM_PROMPT as EXTRACTION_PROMPT } from "../modules/ai/extraction.service";
import { CHAT_MAX_TOKENS, SYSTEM_PROMPT as CHAT_PROMPT } from "../modules/ai/rag.service";
import { SUMMARY_MAX_TOKENS, SUMMARY_SYSTEM_PROMPT } from "../modules/clients/summary.service";

const EMBEDDING_DIMENSIONS = 1024;

const certificado = [
  "CERTIFICADO DE INGRESOS Y RETENCIONES (datos ficticios) · Año gravable 2025",
  "Pagos por salarios: $ 85.000.000",
  "Aportes obligatorios a pensión a cargo del trabajador: $ 3.400.000",
  "Retención en la fuente por ingresos laborales: $ 6.200.000",
].join("\n");

const usos: CompletionRequest[] = [
  {
    purpose: "extraction",
    system: EXTRACTION_PROMPT,
    maxTokens: EXTRACTION_MAX_TOKENS,
    userContent: wrapUntrusted("documento", certificado),
  },
  {
    purpose: "chat",
    system: CHAT_PROMPT,
    maxTokens: CHAT_MAX_TOKENS,
    userContent: `Contexto:\n${wrapUntrusted("fragmento", certificado, { n: 1 })}\n\n${wrapUntrusted(
      "pregunta",
      "¿Cuánto le retuvieron en la fuente en 2025?"
    )}`,
  },
  {
    purpose: "summary",
    system: SUMMARY_SYSTEM_PROMPT,
    maxTokens: SUMMARY_MAX_TOKENS,
    userContent: JSON.stringify({ periodo: 2025, totales: { ingresosBrutos: 85000000, retenciones: 6200000 } }),
  },
];

async function main(): Promise<number> {
  console.log(`Modelo: ${CLAUDE_MODEL}`);
  let fallas = 0;
  for (const uso of usos) {
    const inicio = Date.now();
    try {
      const r = await anthropicProvider.complete(uso);
      const ok = r.stopReason === "end_turn" && r.text !== null && r.text.length > 0;
      if (!ok) fallas++;
      console.log(
        `${ok ? "OK   " : "FALLA"} ${uso.purpose.padEnd(10)} max_tokens=${uso.maxTokens} stop_reason=${r.stopReason} ` +
          `tokens=${r.inputTokens}/${r.outputTokens} texto=${r.text === null ? "null" : `${r.text.length} car.`} ` +
          `${Date.now() - inicio} ms`
      );
    } catch (err) {
      fallas++;
      const motivo = err instanceof AiRefusalError ? "refusal" : err instanceof Error ? err.message : String(err);
      console.log(`FALLA ${uso.purpose.padEnd(10)} ${motivo.slice(0, 200)}`);
    }
  }
  try {
    const [vector] = await anthropicProvider.embed(["Retención en la fuente 2025"]);
    const ok = vector?.length === EMBEDDING_DIMENSIONS;
    if (!ok) fallas++;
    console.log(
      `${ok ? "OK   " : "FALLA"} embeddings dimensiones=${vector?.length ?? 0} (se esperan ${EMBEDDING_DIMENSIONS})`
    );
  } catch (err) {
    fallas++;
    console.log(`FALLA embeddings ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
  }
  console.log(fallas === 0 ? "IA real verificada." : `${fallas} verificación(es) fallida(s).`);
  return fallas === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
