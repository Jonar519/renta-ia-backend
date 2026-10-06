import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, invitationTokenFor, invite } from "../helpers";

// Archivo aparte: agota el limitador por IP de los enlaces de invitación
// (cada archivo de tests tiene su propia app y su propio contador).
describe("límite de intentos con enlaces de invitación", () => {
  it("tras 20 intentos fallidos por IP responde 429; los exitosos no cuentan", async () => {
    // Uno exitoso primero: no consume el cupo (skipSuccessfulRequests).
    const { email } = await invite({ role: "accountant" });
    const valid = await invitationTokenFor(email);
    expect((await request(app).post("/api/auth/invitations/lookup").send({ token: valid })).status).toBe(200);

    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post("/api/auth/invitations/lookup")
        .send({ token: `basura-${i}` });
      expect(res.status).toBe(410);
    }
    const blocked = await request(app).post("/api/auth/invitations/accept").send({ token: valid, password: "x" });
    expect(blocked.status).toBe(429);
  });
});
