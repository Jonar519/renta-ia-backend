import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, unique } from "../helpers";

describe("Rate limiting", () => {
  it("/api/auth/login bloquea la IP con 429 tras 10 intentos fallidos (aunque sean cuentas distintas)", async () => {
    // Un correo distinto por intento: así no interviene el bloqueo por cuenta
    // (lockout.service), solo el limitador por IP.
    for (let i = 0; i < 10; i++) {
      const credentials = { email: `fuerza-bruta-${unique()}@test.local`, password: "incorrecta" };
      expect((await request(app).post("/api/auth/login").send(credentials)).status).toBe(401);
    }
    const blocked = await request(app)
      .post("/api/auth/login")
      .send({ email: `fuerza-bruta-${unique()}@test.local`, password: "incorrecta" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/Demasiados intentos/);
  });
});
