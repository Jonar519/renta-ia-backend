import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, createAccount, TEST_PASSWORD } from "../helpers";
import { prisma } from "../../src/config/prisma";

/**
 * Densidad de las tablas (B15, migración 025): preferencia guardada en la
 * cuenta, que llega con la sesión y se cambia con PATCH /api/users/me.
 */

const patch = (token: string, body: object) => request(app).patch("/api/users/me").set(authHeader(token)).send(body);

describe("densidad de las tablas", () => {
  it("por defecto es cómoda: en /me y en el usuario de la sesión", async () => {
    const account = await createAccount("Densidad Inicial");
    expect(account.user).toMatchObject({ tableDensity: "comfortable" });
    const me = await request(app).get("/api/users/me").set(authHeader(account.token));
    expect(me.body.tableDensity).toBe("comfortable");
  });

  it("se cambia a compacta, se guarda en la cuenta y la sigue en otro inicio de sesión", async () => {
    const account = await createAccount("Densidad Compacta");
    const res = await patch(account.token, { tableDensity: "compact" });
    expect(res.status).toBe(200);
    expect(res.body.tableDensity).toBe("compact");
    expect(res.body.name).toBe("Densidad Compacta"); // no toca lo demás
    const login = await request(app).post("/api/auth/login").send({ email: account.email, password: TEST_PASSWORD });
    expect(login.body.user.tableDensity).toBe("compact");
    expect((await patch(account.token, { tableDensity: "comfortable" })).body.tableDensity).toBe("comfortable");
  });

  it("solo admite cómoda o compacta (400); la base también lo exige", async () => {
    const account = await createAccount("Densidad Inválida");
    const res = await patch(account.token, { tableDensity: "densa" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("tableDensity");
    await expect(
      prisma.$executeRawUnsafe(`UPDATE users SET table_density = 'densa' WHERE id = $1::uuid`, account.user.id)
    ).rejects.toThrow(/chk_users_table_density/);
  });

  it("va en la exportación de mis datos", async () => {
    const account = await createAccount("Densidad Export");
    await patch(account.token, { tableDensity: "compact" });
    const data = await request(app)
      .post("/api/users/me/export")
      .set(authHeader(account.token))
      .send({ password: TEST_PASSWORD });
    expect(data.body.account.preferences).toEqual({ tableDensity: "compact" });
  });
});
