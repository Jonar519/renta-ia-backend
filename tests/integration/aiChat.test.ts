import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app, authHeader, createClient, registerUser } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { embeddingsService } from "../../src/modules/ai/embeddings.service";

// Anthropic mockeado: los tests nunca llaman a la API real (ni gastan crédito).
const { createMessage } = vi.hoisted(() => ({ createMessage: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: createMessage } })),
}));

describe("POST /api/ai/chat", () => {
  let token: string;
  let clientId: string;

  beforeAll(async () => {
    const user = await registerUser();
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
});
