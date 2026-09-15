import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { embeddingsService } from "./embeddings.service";
import { searchSimilarChunks } from "./embeddings.repository";

function getClient(): Anthropic {
  if (!env.anthropicApiKey) {
    throw new Error("Falta configurar ANTHROPIC_API_KEY en el archivo .env para usar el chat.");
  }
  return new Anthropic({ apiKey: env.anthropicApiKey });
}

const SYSTEM_PROMPT = `Eres un asistente contable que responde preguntas sobre la situación
tributaria de un cliente, basándote ÚNICAMENTE en los fragmentos de documentos que se te
proporcionan como contexto. Si la respuesta no está en el contexto, dilo claramente en vez
de inventar datos. Responde en español, de forma clara y concisa.`;

interface AskQuestionInput {
  clientId: string;
  userId: string;
  question: string;
}

export const ragService = {
  async askQuestion({ clientId, userId, question }: AskQuestionInput) {
    const [queryEmbedding] = await embeddingsService.embed([question]);
    const relevantChunks = await searchSimilarChunks(clientId, queryEmbedding, 5);

    const context = relevantChunks
      .map((c, i) => `[Fragmento ${i + 1}]\n${c.chunkText}`)
      .join("\n\n");

    const client = getClient();
    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Contexto:\n${context || "(no se encontraron documentos relevantes)"}\n\nPregunta: ${question}`,
        },
      ],
    });

    const textBlock = message.content.find((block) => block.type === "text");
    const answer = textBlock && textBlock.type === "text" ? textBlock.text : "No se pudo generar una respuesta.";

    const conversation = await prisma.aiConversation.create({ data: { clientId, userId } });

    await prisma.aiMessage.createMany({
      data: [
        { conversationId: conversation.id, role: "user", content: question },
        { conversationId: conversation.id, role: "assistant", content: answer },
      ],
    });

    return { conversationId: conversation.id, answer, sources: relevantChunks.length };
  },
};
