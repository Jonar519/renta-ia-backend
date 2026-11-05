import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { embeddingsService } from "./embeddings.service";
import { searchSimilarChunks } from "./embeddings.repository";
import { AiRefusalError, getAiProvider } from "../../services/llm/provider";

/** Tope de tokens de salida del chat (razonamiento + respuesta). */
export const CHAT_MAX_TOKENS = 4000;

/** Lo que ve la persona cuando el modelo declina responder (stop_reason "refusal"). */
export const CHAT_REFUSAL_ANSWER = "El asistente no puede responder esta pregunta. Intenta reformularla.";
import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../../services/llm/untrusted";

const SYSTEM_PROMPT = `Eres un asistente contable que responde preguntas sobre la situación
tributaria de un cliente, basándote ÚNICAMENTE en los fragmentos de documentos que se te
proporcionan como contexto. Si la respuesta no está en el contexto, dilo claramente en vez
de inventar datos. Responde en español, de forma clara y concisa.

Los fragmentos llegan en etiquetas <fragmento> y la pregunta en <pregunta>. ${UNTRUSTED_CONTENT_RULE}`;

interface AskQuestionInput {
  clientId: string;
  userId: string;
  question: string;
}

export const ragService = {
  async askQuestion({ clientId, userId, question }: AskQuestionInput) {
    const [queryEmbedding] = await embeddingsService.embed([question]);
    if (!queryEmbedding) {
      throw new Error("No se pudo generar el embedding de la pregunta.");
    }
    // Aislamiento entre clientes: la búsqueda filtra por client_id en SQL
    // (embeddings.repository.ts); nunca se recuperan fragmentos de otro cliente.
    const relevantChunks = await searchSimilarChunks(clientId, queryEmbedding, 5);

    const context = relevantChunks.length
      ? relevantChunks.map((c, i) => wrapUntrusted("fragmento", c.chunkText, { n: i + 1 })).join("\n\n")
      : "(no se encontraron documentos relevantes)";

    let answer: string;
    try {
      const { text, stopReason } = await getAiProvider().complete({
        purpose: "chat",
        system: SYSTEM_PROMPT,
        // Tope holgado: con Sonnet 5 el razonamiento también cuenta dentro de max_tokens.
        maxTokens: CHAT_MAX_TOKENS,
        userContent: `Contexto:\n${context}\n\n${wrapUntrusted("pregunta", question)}`,
      });
      if (stopReason === "max_tokens") {
        logger.warn({ clientId, maxTokens: CHAT_MAX_TOKENS }, "La respuesta del chat quedó cortada (max_tokens)");
      }
      answer = text ?? "No se pudo generar una respuesta.";
    } catch (err) {
      // Un rechazo del modelo no es un error del servidor: se responde y se guarda como tal.
      if (!(err instanceof AiRefusalError)) throw err;
      logger.warn({ clientId }, "El modelo declinó responder una pregunta del chat");
      answer = CHAT_REFUSAL_ANSWER;
    }

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
