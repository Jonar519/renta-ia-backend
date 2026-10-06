import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, createAccount } from "../helpers";
import { createSignedToken } from "../../src/utils/signedToken";

// Archivo aparte: agota los limitadores de MFA (cada archivo de tests tiene
// su propia app y sus contadores en memoria).
describe("límites de la verificación en dos pasos", () => {
  it("segundo paso del login: tras 10 fallos por IP en 15 minutos responde 429", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/api/auth/login/mfa")
        .send({ challengeToken: createSignedToken("mfa_challenge").token, code: "123456" });
      expect(res.status).toBe(401);
    }
    const blocked = await request(app)
      .post("/api/auth/login/mfa")
      .send({ challengeToken: createSignedToken("mfa_challenge").token, code: "123456" });
    expect(blocked.status).toBe(429);
  });

  it("configurar el propio MFA: tras 10 fallos de la MISMA cuenta responde 429 (otra cuenta no se afecta)", async () => {
    const account = await createAccount("Limitada");
    const other = await createAccount("No limitada");
    const setup = (token: string) =>
      request(app).post("/api/users/me/mfa/setup").set(authHeader(token)).send({ password: "no es la contraseña" });
    for (let i = 0; i < 10; i++) {
      const res = await setup(account.token);
      expect([400, 429]).toContain(res.status); // el bloqueo progresivo de la cuenta también puede saltar (429)
    }
    const blocked = await setup(account.token);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain("verificación en dos pasos");
    expect((await setup(other.token)).status).toBe(400);
  });
});
