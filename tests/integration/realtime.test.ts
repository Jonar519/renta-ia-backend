import http from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { WebSocket } from "ws";
import { app, authHeader, createClient, createDocument, registerUser, TEST_PASSWORD, unique } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { attachRealtime, RealtimeServer, WS_CLOSE, WS_PATH } from "../../src/realtime/wsServer";
import { publishDocumentEvent } from "../../src/services/events/documentEvents";
import { documentQueue } from "../../src/queues/documentQueue";

const ALLOWED_ORIGIN = "http://localhost:5173";

let server: http.Server;
let realtime: RealtimeServer;
let url: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  realtime = await attachRealtime(server, { authTimeoutMs: 300 });
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${WS_PATH}`;
});

afterAll(async () => {
  await realtime.close();
  await new Promise((resolve) => server.close(resolve));
});

/** Abre un socket; si se pasa token, se autentica y espera "ready". */
function connect(token?: string, origin = ALLOWED_ORIGIN) {
  const ws = new WebSocket(url, { headers: { Origin: origin } });
  const received: Record<string, unknown>[] = [];
  ws.on("message", (data) => received.push(JSON.parse(data.toString())));
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  const ready = new Promise<void>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("open", () => {
      if (!token) return resolve();
      ws.send(JSON.stringify({ type: "auth", token }));
      const check = setInterval(() => {
        if (received.some((m) => m.type === "ready")) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
  });
  return { ws, received, closed, ready };
}

const tick = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WebSocket /ws", () => {
  it("rechaza orígenes no permitidos (403)", async () => {
    const { ws } = connect(undefined, "https://evil.example");
    const status = await new Promise<number | undefined>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.on("error", () => resolve(undefined));
    });
    expect(status).toBe(403);
  });

  it("cierra si no se autentica a tiempo", async () => {
    const { closed } = connect();
    expect(await closed).toBe(WS_CLOSE.authTimeout);
  });

  it("cierra con un token inválido", async () => {
    const { ws, closed } = connect();
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: "no-es-un-jwt" })));
    expect(await closed).toBe(WS_CLOSE.unauthorized);
  });

  it("cada contador recibe solo los eventos de sus clientes; el admin recibe todos", async () => {
    const a = await registerUser("Contador A");
    const b = await registerUser("Contador B");
    const clientA = await createClient(a.token);

    const adminEmail = `admin-ws-${unique()}@test.local`;
    await prisma.user.create({
      data: { name: "Admin", email: adminEmail, role: "admin", passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) },
    });
    const adminToken = (await request(app).post("/api/auth/login").send({ email: adminEmail, password: TEST_PASSWORD }))
      .body.accessToken;

    const sa = connect(a.token);
    const sb = connect(b.token);
    const sadmin = connect(adminToken);
    await Promise.all([sa.ready, sb.ready, sadmin.ready]);

    await publishDocumentEvent({
      documentId: "d-1",
      clientId: clientA.id,
      audienceUserIds: [a.user.id],
      status: "processed",
      errorMessage: null,
    });
    await tick();

    const updates = (list: Record<string, unknown>[]) => list.filter((m) => m.type === "document.updated");
    expect(updates(sa.received)).toHaveLength(1);
    expect(updates(sa.received)[0]).toMatchObject({ documentId: "d-1", clientId: clientA.id, status: "processed" });
    expect(updates(sa.received)[0]).not.toHaveProperty("audienceUserIds");
    expect(updates(sb.received)).toHaveLength(0);
    expect(updates(sadmin.received)).toHaveLength(1);

    for (const s of [sa, sb, sadmin]) s.ws.close();
  });
});

describe("POST /api/documents/:id/reprocess", () => {
  it("reencola un documento terminado y notifica por WebSocket; 409 si ya está en cola; 404 a otro contador", async () => {
    const owner = await registerUser();
    const clientId = (await createClient(owner.token)).id;
    const doc = await createDocument(clientId, owner.user.id);
    await prisma.document.update({ where: { id: doc.id }, data: { status: "error", errorMessage: "sin crédito" } });

    const other = await registerUser();
    expect((await request(app).post(`/api/documents/${doc.id}/reprocess`).set(authHeader(other.token))).status).toBe(
      404
    );

    const socket = connect(owner.token);
    await socket.ready;

    const res = await request(app).post(`/api/documents/${doc.id}/reprocess`).set(authHeader(owner.token));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "uploaded", errorMessage: null });
    expect(documentQueue.add).toHaveBeenCalledWith("process-document", { documentId: doc.id });

    await tick();
    expect(socket.received).toContainEqual(expect.objectContaining({ documentId: doc.id, status: "uploaded" }));

    // Ya está en cola: un segundo clic no lo encola otra vez.
    expect((await request(app).post(`/api/documents/${doc.id}/reprocess`).set(authHeader(owner.token))).status).toBe(
      409
    );
    socket.ws.close();
  });
});
