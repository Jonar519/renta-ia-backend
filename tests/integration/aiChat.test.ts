import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app, authHeader, createClient, createAccount } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { embeddingsService } from "../../src/modules/ai/embeddings.service";
import { CHAT_MAX_TOKENS, CHAT_REFUSAL_ANSWER } from "../../src/modules/ai/rag.service";

// Anthropic mockeado: los tests nunca llaman a la API real (ni gastan crédito).
const { createMessage } = vi.hoisted(() => ({ createMessage: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  // `function` (no flecha): vitest 4 exige un constructor para `new Anthropic(...)`.
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: createMessage } };
  }),
}));

describe("POST /api/ai/chat", () => {
  let token: string;
  let clientId: string;

  beforeAll(async () => {
    const user = await createAccount();
    token = user.token;
    clientId = (await createClient(token)).id;
  });

  beforeEach(() => {
    createMessage.mockReset();
  });

  afterEach(() => {
    vi.mocked(embeddingsService.embed).mockRestore?.();
  });

  const chat = (body: object) => request(app).post("/api/ai/chat").set(authHeader(token)).send(body);

  it("400 si falta la pregunta", async () => {
    const res = await chat({ clientId });
    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual(expect.objectContaining({ field: "body.question" }));
  });

  it("400 si la pregunta es demasiado corta", async () => {
    expect((await chat({ clientId, question: "hi" })).status).toBe(400);
  });

  it("400 si la pregunta supera 1000 caracteres", async () => {
    const res = await chat({ clientId, question: "a".repeat(1001) });
    expect(res.status).toBe(400);
    expect(res.body.details[0].message).toMatch(/1000/);
  });

  it("400 si clientId no es un UUID", async () => {
    const res = await chat({ clientId: "no-es-uuid", question: "¿Cuál fue el ingreso bruto?" });
    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual(expect.objectContaining({ field: "body.clientId" }));
  });

  it("caso feliz: responde con Anthropic/Voyage mockeados y persiste la conversación", async () => {
    const embedSpy = vi.spyOn(embeddingsService, "embed").mockResolvedValue([new Array(1024).fill(0.01)]);
    createMessage.mockResolvedValue({ content: [{ type: "text", text: "El ingreso bruto fue $85.000.000." }] });

    const question = "¿Cuál fue el ingreso bruto reportado?";
    const res = await chat({ clientId, question });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe("El ingreso bruto fue $85.000.000.");
    expect(res.body.conversationId).toEqual(expect.any(String));
    expect(embedSpy).toHaveBeenCalledWith([question]);
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage.mock.calls[0]![0].messages[0].content).toContain(question);

    const conversation = await prisma.aiConversation.findUniqueOrThrow({
      where: { id: res.body.conversationId },
      include: { messages: true },
    });
    expect(conversation.clientId).toBe(clientId);
    expect(conversation.messages.map((m) => [m.role, m.content]).sort()).toEqual(
      [
        ["assistant", "El ingreso bruto fue $85.000.000."],
        ["user", question],
      ].sort()
    );
  });

  it(`pide max_tokens = CHAT_MAX_TOKENS (${CHAT_MAX_TOKENS}): con Sonnet 5 el razonamiento cuenta dentro`, async () => {
    vi.spyOn(embeddingsService, "embed").mockResolvedValue([new Array(1024).fill(0.01)]);
    createMessage.mockResolvedValue({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "", signature: "firma" },
        { type: "text", text: "Respuesta." },
      ],
    });
    const res = await chat({ clientId, question: "¿Cuánto le retuvieron?" });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe("Respuesta.");
    expect(createMessage.mock.calls[0]![0].max_tokens).toBe(CHAT_MAX_TOKENS);
  });

  it("si el modelo declina (refusal), responde 200 con un mensaje claro y lo guarda, sin texto parcial", async () => {
    vi.spyOn(embeddingsService, "embed").mockResolvedValue([new Array(1024).fill(0.01)]);
    createMessage.mockResolvedValue({ stop_reason: "refusal", content: [{ type: "text", text: "parcial" }] });

    const res = await chat({ clientId, question: "Pregunta que el modelo declina" });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe(CHAT_REFUSAL_ANSWER);
    const messages = await prisma.aiMessage.findMany({ where: { conversationId: res.body.conversationId } });
    expect(messages.find((m) => m.role === "assistant")?.content).toBe(CHAT_REFUSAL_ANSWER);
  });

  it("si la respuesta se corta (max_tokens), se devuelve lo que llegó", async () => {
    vi.spyOn(embeddingsService, "embed").mockResolvedValue([new Array(1024).fill(0.01)]);
    createMessage.mockResolvedValue({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "Respuesta a medias" }],
    });
    const res = await chat({ clientId, question: "Pregunta larga" });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe("Respuesta a medias");
  });

  it("otros errores del proveedor siguen siendo errores (no se disfrazan de rechazo)", async () => {
    vi.spyOn(embeddingsService, "embed").mockResolvedValue([new Array(1024).fill(0.01)]);
    createMessage.mockRejectedValue(new Error("Your credit balance is too low"));
    const res = await chat({ clientId, question: "¿Algo?" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.answer).toBeUndefined();
  });
});
