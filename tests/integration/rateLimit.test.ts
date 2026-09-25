import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, unique } from "../helpers";

describe("Rate limiting", () => {
  it("/api/auth/login bloquea con 429 tras 10 intentos fallidos", async () => {
    const credentials = { email: `fuerza-bruta-${unique()}@test.local`, password: "incorrecta" };
    for (let i = 0; i < 10; i++) {
      expect((await request(app).post("/api/auth/login").send(credentials)).status).toBe(401);
    }
    const blocked = await request(app).post("/api/auth/login").send(credentials);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/Demasiados intentos/);
  });
});
