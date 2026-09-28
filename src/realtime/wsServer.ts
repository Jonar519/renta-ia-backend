import type { IncomingMessage, Server } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { verifyAccessToken } from "../modules/auth/tokens";
import type { AuthPayload } from "../middlewares/auth.middleware";
import { DocumentEvent, documentEventBus } from "../services/events/documentEvents";

/**
 * Notificaciones en tiempo real por WebSocket (ruta /ws, mismo puerto que la API).
 *
 * Protocolo (JSON):
 *   cliente → { "type": "auth", "token": "<access token>" }   (primer mensaje, antes de AUTH_TIMEOUT_MS)
 *   servidor → { "type": "ready" }
 *   servidor → { "type": "document.updated", documentId, clientId, status, errorMessage, at }
 *
 * Seguridad:
 *  - Origin debe estar en CORS_ORIGIN: evita que otra web abra un socket
 *    con la sesión del usuario (cross-site WebSocket hijacking).
 *  - El token va en el primer mensaje y no en la URL, para que no quede
 *    en logs de acceso ni en el historial.
 *  - Cada evento se envía solo al contador dueño del cliente y a los admin.
 *  - El socket se cierra cuando el token expira (el cliente se reconecta
 *    con un token nuevo).
 */

export const WS_PATH = "/ws";
export const WS_CLOSE = { unauthorized: 4401, authTimeout: 4408, tokenExpired: 4409 } as const;
const HEARTBEAT_MS = 30_000;

interface ClientState {
  user: AuthPayload | null;
  alive: boolean;
  expiryTimer?: NodeJS.Timeout;
}

export interface RealtimeServer {
  close(): Promise<void>;
  connectedUsers(): number;
}

export async function attachRealtime(
  server: Server,
  options: { authTimeoutMs?: number } = {}
): Promise<RealtimeServer> {
  const authTimeoutMs = options.authTimeoutMs ?? 5_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const states = new Map<WebSocket, ClientState>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (!origin || !env.corsOrigins.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    const state: ClientState = { user: null, alive: true };
    states.set(ws, state);

    const authTimer = setTimeout(() => ws.close(WS_CLOSE.authTimeout, "Autenticación requerida"), authTimeoutMs);

    ws.on("pong", () => {
      state.alive = true;
    });

    ws.on("message", (raw) => {
      if (state.user) return; // tras autenticarse, el cliente no envía nada más
      let message: { type?: unknown; token?: unknown };
      try {
        message = JSON.parse(raw.toString());
      } catch {
        ws.close(WS_CLOSE.unauthorized, "Mensaje inválido");
        return;
      }
      const payload =
        message.type === "auth" && typeof message.token === "string" ? verifyAccessToken(message.token) : null;
      if (!payload) {
        ws.close(WS_CLOSE.unauthorized, "Token inválido");
        return;
      }
      clearTimeout(authTimer);
      state.user = { userId: payload.userId, role: payload.role };
      if (payload.exp) {
        const msLeft = payload.exp * 1000 - Date.now();
        state.expiryTimer = setTimeout(() => ws.close(WS_CLOSE.tokenExpired, "Token expirado"), Math.max(msLeft, 0));
      }
      ws.send(JSON.stringify({ type: "ready" }));
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      clearTimeout(state.expiryTimer);
      states.delete(ws);
    });
  });

  // Heartbeat: cierra sockets muertos (p. ej. el portátil se suspendió).
  const heartbeat = setInterval(() => {
    for (const [ws, state] of states) {
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const unsubscribe = await documentEventBus.subscribe((event: DocumentEvent) => {
    // accountantUserId es para enrutar; no se reenvía al navegador.
    const { accountantUserId, ...publicEvent } = event;
    const data = JSON.stringify(publicEvent);
    for (const [ws, state] of states) {
      const user = state.user;
      if (!user || ws.readyState !== WebSocket.OPEN) continue;
      if (user.role === "admin" || user.userId === accountantUserId) ws.send(data);
    }
  });

  logger.info(`WebSocket de notificaciones en ${WS_PATH}`);

  return {
    connectedUsers: () => [...states.values()].filter((s) => s.user).length,
    async close() {
      clearInterval(heartbeat);
      await unsubscribe();
      for (const ws of states.keys()) ws.close(1001, "Servidor apagándose");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
