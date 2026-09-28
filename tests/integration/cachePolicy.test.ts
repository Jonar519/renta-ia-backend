import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, createClient, registerUser } from "../helpers";

describe("Política de caché de la API", () => {
  it("las respuestas con datos tributarios llevan Cache-Control: no-store", async () => {
    const { token } = await registerUser();
    const client = await createClient(token);
    for (const path of [`/api/clients/${client.id}`, `/api/clients/${client.id}/tax-concepts`, "/api/clients"]) {
      const res = await request(app).get(path).set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("también los errores y /health", async () => {
    expect((await request(app).get("/api/clients")).headers["cache-control"]).toBe("no-store");
    expect((await request(app).get("/health")).headers["cache-control"]).toBe("no-store");
  });
});
