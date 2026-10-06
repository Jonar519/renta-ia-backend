import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, createAccount } from "../helpers";
import { createSignedToken } from "../../src/utils/signedToken";

// Archivo aparte: agota los limitadores del perfil (cada archivo de tests
// tiene su propia app y sus contadores en memoria).
describe("límites del perfil", () => {
  it("cambiar contraseña o correo: tras 10 fallos de la MISMA cuenta responde 429 (otra cuenta no se afecta)", async () => {
    const account = await createAccount("Limitada Perfil");
    const other = await createAccount("Otra Perfil");
    const wrong = (token: string) =>
      request(app)
        .post("/api/users/me/password")
        .set(authHeader(token))
        .send({ currentPassword: "no es", newPassword: "otra frase larga y distinta" });
    for (let i = 0; i < 10; i++) expect([400, 429]).toContain((await wrong(account.token)).status);
    const blocked = await wrong(account.token);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain("Espera 15 minutos");
    expect((await wrong(other.token)).status).toBe(400);
  });

  it("confirmar el correo nuevo: tras 20 enlaces inválidos por IP responde 429", async () => {
    const confirm = () =>
      request(app)
        .post("/api/auth/email-change/confirm")
        .send({ token: createSignedToken("email_change").token });
    for (let i = 0; i < 20; i++) expect((await confirm()).status).toBe(410);
    expect((await confirm()).status).toBe(429);
  });
});
