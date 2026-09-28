import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, unique } from "../helpers";

// Archivo aparte: cada 400 cuenta como intento fallido en el limitador por
// IP de /api/auth (10 / 15 min), y cada archivo de tests tiene su propia app.
describe("Política de contraseñas en el registro", () => {
  const register = (password: string, email = `pol-${unique()}@test.local`, name = "Mariana Ríos") =>
    request(app).post("/api/auth/register").send({ name, email, password });

  it.each([
    ["corta", "abc12345"],
    ["común", "Password2024!"],
    ["solo dígitos", "12345678901"],
    ["de un solo carácter repetido", "aaaaaaaaaaaa"],
  ])("rechaza una contraseña %s", async (_label, password) => {
    expect((await register(password)).status).toBe(400);
  });

  it("rechaza la que contiene el correo o el nombre", async () => {
    expect((await register("xx-mrios2026-xx", "mrios2026@test.local")).status).toBe(400);
    expect((await register("soy-Mariana-2026")).status).toBe(400);
  });

  it("acepta una frase larga sin reglas de composición", async () => {
    expect((await register("caballo correcto batería grapa")).status).toBe(201);
  });
});
