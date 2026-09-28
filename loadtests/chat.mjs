// Escenario: chat con IA (POST /api/ai/chat) con AI_PROVIDER=mock en la API.
// La latencia del "modelo" es SIMULADA (AI_MOCK_LATENCY_MS por llamada: una
// para el embedding de la pregunta y otra para la respuesta). Mide nuestro
// costo alrededor de la IA (auth, búsqueda en pgvector, persistencia), no a Anthropic.
import { login, readState, run, save } from "./lib.mjs";

const state = readState();
const token = await login(state.chat.email);
const connections = Number(process.env.LOADTEST_CONNECTIONS || 20);
const label = process.env.LOADTEST_LABEL ? `-${process.env.LOADTEST_LABEL}` : "";

const result = await run("chat", {
  connections,
  requests: [
    {
      method: "POST",
      path: "/api/ai/chat",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: state.chat.clientId, question: "¿Cuál fue el ingreso bruto del año?" }),
    },
  ],
});
save(`chat-c${connections}${label}.json`, {
  scenario: "chat",
  aiProvider: "mock",
  aiMockLatencyMsPerCall: process.env.LOADTEST_AI_MOCK_LATENCY_MS ?? "no indicado",
  result,
});
