import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app, authHeader, createClient, createDocument, registerUser } from "../helpers";
import { embeddingsService } from "../../src/modules/ai/embeddings.service";
import { replaceEmbeddings, searchSimilarChunks } from "../../src/modules/ai/embeddings.repository";

// Anthropic mockeado: se captura el prompt para ver qué fragmentos llegan al LLM.
const { createMessage } = vi.hoisted(() => ({ createMessage: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: createMessage } })),
}));

/**
 * Amenaza (docs/threat-model.md, "fuga entre clientes vía RAG"): que el chat
 * sobre el cliente A recupere fragmentos del cliente B. Para ponerlo difícil,
 * los fragmentos de B son EXACTAMENTE el vector de la pregunta (distancia 0)
 * y los de A están lejos: si el filtro por cliente fallara, B ganaría siempre.
 */
const DIM = 1024;
const QUERY = new Array(DIM).fill(0).map((_, i) => (i % 2 === 0 ? 1 : 0));
const FAR = new Array(DIM).fill(0).map((_, i) => (i % 2 === 0 ? 0 : 1));
const SECRET_B = "SECRETO-DEL-CLIENTE-B ingresos 999.999.999";

describe("Aislamiento del RAG entre clientes", () => {
  let token: string;
  let clientA: string;
  let clientSameAccountant: string;
  let clientOtherAccountant: string;

  beforeAll(async () => {
    const owner = await registerUser("Contador dueño");
    const other = await registerUser("Otro contador");
    token = owner.token;
    clientA = (await createClient(owner.token)).id;
    // B1: otro cliente del MISMO contador (el caso más fácil de filtrar mal).
    clientSameAccountant = (await createClient(owner.token)).id;
    // B2: cliente de otro contador.
    clientOtherAccountant = (await createClient(other.token)).id;

    const docA = await createDocument(clientA, owner.user.id);
    await replaceEmbeddings(docA.id, [{ chunkText: "Fragmento del cliente A", embedding: FAR }]);
    for (const [clientId, uploader] of [
      [clientSameAccountant, owner.user.id],
      [clientOtherAccountant, other.user.id],
    ] as const) {
      const doc = await createDocument(clientId, uploader);
      await replaceEmbeddings(doc.id, [
        { chunkText: SECRET_B, embedding: QUERY },
        { chunkText: `${SECRET_B} (2)`, embedding: QUERY },
      ]);
    }
  });

  beforeEach(() => {
    createMessage.mockReset();
  });

  afterEach(() => {
    vi.mocked(embeddingsService.embed).mockRestore?.();
  });

  it("la búsqueda vectorial solo devuelve fragmentos del cliente pedido, aunque otros estén más cerca", async () => {
    const chunks = await searchSimilarChunks(clientA, QUERY, 10);
    expect(chunks.map((c) => c.chunkText)).toEqual(["Fragmento del cliente A"]);
  });

  it("el prompt que llega al LLM no contiene texto de otros clientes", async () => {
    vi.spyOn(embeddingsService, "embed").mockResolvedValue([QUERY]);
    createMessage.mockResolvedValue({ content: [{ type: "text", text: "Respuesta." }] });

    const res = await request(app)
      .post("/api/ai/chat")
      .set(authHeader(token))
      .send({ clientId: clientA, question: "¿Cuáles fueron los ingresos?" });

    expect(res.status).toBe(200);
    expect(res.body.sources).toBe(1);
    const prompt = JSON.stringify(createMessage.mock.calls[0]![0]);
    expect(prompt).toContain("Fragmento del cliente A");
    expect(prompt).not.toContain("SECRETO-DEL-CLIENTE-B");
  });

  it("no se puede consultar el RAG de un cliente ajeno (404, sin llamar al LLM)", async () => {
    const res = await request(app)
      .post("/api/ai/chat")
      .set(authHeader(token))
      .send({ clientId: clientOtherAccountant, question: "¿Cuáles fueron los ingresos?" });
    expect(res.status).toBe(404);
    expect(createMessage).not.toHaveBeenCalled();
  });
});
