import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, invitationTokenFor, invite } from "../helpers";

// La contraseña ya no la fija nadie más que la persona: se aplica la política
// al ACTIVAR la cuenta invitada (contra su propio nombre y correo).
// Archivo aparte: cada 400 cuenta como intento fallido en el limitador por IP
// de los enlaces de invitación (20 / 15 min); cada archivo tiene su propia app.
describe("Política de contraseñas al activar una cuenta invitada", () => {
  async function activate(password: string, input: { email?: string; name?: string } = {}) {
    const { email } = await invite({ role: "accountant", name: input.name ?? "Mariana Ríos", email: input.email });
    const token = await invitationTokenFor(email);
    return request(app).post("/api/auth/invitations/accept").send({ token, password });
  }

  it.each([
    ["corta", "abc12345"],
    ["común", "Password2024!"],
    ["solo dígitos", "12345678901"],
    ["de un solo carácter repetido", "aaaaaaaaaaaa"],
  ])("rechaza una contraseña %s (y la invitación sigue vigente)", async (_label, password) => {
    const res = await activate(password);
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe("body.password");
  });

  it("rechaza la que contiene el correo o el nombre de la persona invitada", async () => {
    expect((await activate("xx-mrios2026-xx", { email: "mrios2026@test.local" })).status).toBe(400);
    expect((await activate("soy-Mariana-2026")).status).toBe(400);
  });

  it("acepta una frase larga sin reglas de composición", async () => {
    expect((await activate("caballo correcto batería grapa")).status).toBe(200);
  });
});
