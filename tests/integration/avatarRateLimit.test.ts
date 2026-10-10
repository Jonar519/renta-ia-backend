import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, createAccount } from "../helpers";

// Archivo aparte: agota el limitador de la foto de perfil (contadores en
// memoria por archivo de tests).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

describe("límite de cambios de foto", () => {
  it("tras 20 subidas de la MISMA cuenta en una hora responde 429 (otra cuenta no se afecta)", async () => {
    const account = await createAccount("Muchas Fotos");
    const other = await createAccount("Pocas Fotos");
    const upload = (token: string) =>
      request(app)
        .post("/api/users/me/avatar")
        .set(authHeader(token))
        .attach("avatar", PNG, { filename: "f.png", contentType: "image/png" });
    for (let i = 0; i < 20; i++) expect((await upload(account.token)).status).toBe(201);
    expect((await upload(account.token)).status).toBe(429);
    expect((await upload(other.token)).status).toBe(201);
  });
});
