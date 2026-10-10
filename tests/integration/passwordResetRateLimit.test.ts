import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../helpers";
import { flushPasswordResets } from "../../src/modules/auth/passwordReset.service";

// Archivo aparte: agota el limitador por IP de las solicitudes de
// recuperación (cada archivo de tests tiene su propia app y contador).
describe("límite de solicitudes de recuperación de contraseña", () => {
  it("tras 20 solicitudes por IP en 15 minutos responde 429, aunque todas den 202", async () => {
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post("/api/auth/password-reset/request")
        .send({ email: `x${i}@test.local` });
      expect(res.status).toBe(202);
    }
    const blocked = await request(app).post("/api/auth/password-reset/request").send({ email: "x21@test.local" });
    expect(blocked.status).toBe(429);
    await flushPasswordResets();
  });
});
