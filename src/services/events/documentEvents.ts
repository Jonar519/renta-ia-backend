import { EventEmitter } from "events";
import IORedis from "ioredis";
import { env } from "../../config/env";
import { logger } from "../../config/logger";

/**
 * Eventos de estado de documentos, del worker hacia la API (y de ahí al
 * navegador por WebSocket).
 *
 *   worker ──PUBLISH──▶ Redis canal "renta-ia:document-events" ──▶ API ──▶ WebSocket del dueño
 *
 * Son procesos distintos, por eso se usa Redis pub/sub y no un EventEmitter.
 * En tests (NODE_ENV=test) se usa un bus en memoria para no depender de Redis.
 * pub/sub no guarda mensajes: si la API está caída, el evento se pierde; el
 * navegador lo compensa con polling (ver frontend src/realtime/).
 */

export interface DocumentEvent {
  type: "document.updated";
  documentId: string;
  clientId: string;
  /** Contador dueño del cliente: la API solo reenvía el evento a él (y a los admin). */
  accountantUserId: string;
  status: "uploaded" | "processing" | "processed" | "error";
  errorMessage: string | null;
  at: string;
}

export const DOCUMENT_EVENTS_CHANNEL = "renta-ia:document-events";

export interface DocumentEventBus {
  publish(event: DocumentEvent): Promise<void>;
  /** Devuelve una función para cancelar la suscripción. */
  subscribe(handler: (event: DocumentEvent) => void): Promise<() => Promise<void>>;
}

function createInMemoryBus(): DocumentEventBus {
  const emitter = new EventEmitter();
  return {
    async publish(event) {
      emitter.emit("event", event);
    },
    async subscribe(handler) {
      emitter.on("event", handler);
      return async () => {
        emitter.off("event", handler);
      };
    },
  };
}

function createRedisBus(): DocumentEventBus {
  let publisher: IORedis | null = null;
  return {
    async publish(event) {
      publisher ??= new IORedis(env.redisUrl, { maxRetriesPerRequest: 2 });
      await publisher.publish(DOCUMENT_EVENTS_CHANNEL, JSON.stringify(event));
    },
    async subscribe(handler) {
      // Una conexión en modo "subscriber" no puede ejecutar otros comandos:
      // necesita su propia conexión.
      const subscriber = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
      await subscriber.subscribe(DOCUMENT_EVENTS_CHANNEL);
      subscriber.on("message", (_channel, message) => {
        try {
          handler(JSON.parse(message) as DocumentEvent);
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : err }, "Evento de documento inválido descartado");
        }
      });
      return async () => {
        await subscriber.quit();
      };
    },
  };
}

export const documentEventBus: DocumentEventBus = env.nodeEnv === "test" ? createInMemoryBus() : createRedisBus();

/**
 * Publica sin interrumpir a quien llama: una notificación fallida (Redis
 * caído) nunca debe hacer fallar el procesamiento de un documento.
 */
export async function publishDocumentEvent(event: Omit<DocumentEvent, "type" | "at">): Promise<void> {
  try {
    await documentEventBus.publish({ type: "document.updated", at: new Date().toISOString(), ...event });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, documentId: event.documentId },
      "No se pudo publicar el evento del documento"
    );
  }
}
