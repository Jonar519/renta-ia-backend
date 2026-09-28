import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, createClient, registerUser } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { decodeCursor, encodeCursor } from "../../src/utils/pagination";

describe("Paginación por cursor", () => {
  let token: string;
  let userId: string;
  let clientId: string;
  const DOCS = 23;

  beforeAll(async () => {
    const user = await registerUser();
    token = user.token;
    userId = user.user.id;
    clientId = (await createClient(token)).id;
    // 23 documentos; varios con la MISMA fecha para probar el desempate por id.
    const base = new Date("2026-01-01T00:00:00Z").getTime();
    await prisma.document.createMany({
      data: Array.from({ length: DOCS }, (_, i) => ({
        clientId,
        uploadedBy: userId,
        docType: "other" as const,
        originalName: `doc-${i}.pdf`,
        storageKey: `clients/${clientId}/documents/doc-${i}.pdf`,
        uploadedAt: new Date(base + Math.floor(i / 3) * 60_000), // grupos de 3 con la misma fecha
      })),
    });
  });

  const page = (query: string) => request(app).get(`/api/documents/client/${clientId}?${query}`).set(authHeader(token));

  it("recorre todas las páginas sin duplicados ni huecos, en orden descendente", async () => {
    const seen: string[] = [];
    const dates: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await page(`limit=5${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(5);
      for (const d of res.body.items) {
        seen.push(d.id);
        dates.push(new Date(d.uploadedAt).getTime());
      }
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(5); // 5+5+5+5+3
    expect(seen).toHaveLength(DOCS);
    expect(new Set(seen).size).toBe(DOCS);
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  it("no expone storageKey en el listado", async () => {
    const res = await page("limit=1");
    expect(res.body.items[0]).not.toHaveProperty("storageKey");
  });

  it("límite por defecto 50, máximo 100", async () => {
    expect((await page("")).body.items).toHaveLength(DOCS);
    expect((await page("limit=101")).status).toBe(400);
    expect((await page("limit=0")).status).toBe(400);
  });

  it("cursor inválido → 400", async () => {
    expect((await page("cursor=esto-no-es-un-cursor")).status).toBe(400);
  });

  it("el cursor codifica fecha e id de forma reversible", () => {
    const date = new Date("2026-05-01T10:00:00.123Z");
    expect(decodeCursor(encodeCursor(date, "abc"))).toEqual({ date, id: "abc" });
  });

  it("clientes y alertas también devuelven { items, nextCursor }", async () => {
    const clients = await request(app).get("/api/clients?limit=1").set(authHeader(token));
    expect(clients.body).toEqual({ items: [expect.objectContaining({ id: clientId })], nextCursor: null });
    const alerts = await request(app).get(`/api/alerts/client/${clientId}`).set(authHeader(token));
    expect(alerts.body).toEqual({ items: [], nextCursor: null });
  });
});
