import { describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { app, TEST_PASSWORD, unique } from "../helpers";
import { authService } from "../../src/modules/auth/auth.service";
import { prisma } from "../../src/config/prisma";
import { ApiError } from "../../src/utils/apiError";

describe("auth.service", () => {
  it("el registro ignora el campo role y siempre crea un contador", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Intruso", email: `intruso-${unique()}@test.local`, password: TEST_PASSWORD, role: "admin" });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("accountant");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: res.body.user.id } });
    expect(user.role).toBe("accountant");
  });

  it("guarda la contraseña hasheada con bcrypt, nunca en texto plano", async () => {
    const email = `hash-${unique()}@test.local`;
    const { user } = await authService.register({ name: "Hash", email, password: TEST_PASSWORD });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.passwordHash).not.toBe(TEST_PASSWORD);
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$10\$/);
    expect(await bcrypt.compare(TEST_PASSWORD, stored.passwordHash)).toBe(true);
  });

  it("la respuesta del registro no expone el hash", async () => {
    const result = await authService.register({
      name: "Sin hash",
      email: `nohash-${unique()}@test.local`,
      password: TEST_PASSWORD,
    });
    expect(result.user).not.toHaveProperty("passwordHash");
    expect(result.accessToken).toEqual(expect.any(String));
  });

  it("login con contraseña incorrecta da 401", async () => {
    const email = `login-${unique()}@test.local`;
    await authService.register({ name: "Login", email, password: TEST_PASSWORD });

    await expect(authService.login({ email, password: "otra-clave" })).rejects.toMatchObject({ statusCode: 401 });
    const res = await request(app).post("/api/auth/login").send({ email, password: "otra-clave" });
    expect(res.status).toBe(401);
  });

  it("login con un correo inexistente da 401 (mismo mensaje, no revela si existe)", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: `nadie-${unique()}@test.local`, password: "x" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Credenciales inválidas");
  });

  it("login correcto devuelve access token", async () => {
    const email = `ok-${unique()}@test.local`;
    await authService.register({ name: "Ok", email, password: TEST_PASSWORD });
    const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it("email duplicado da 409", async () => {
    const email = `dup-${unique()}@test.local`;
    await authService.register({ name: "Primero", email, password: TEST_PASSWORD });

    const error = await authService.register({ name: "Segundo", email, password: TEST_PASSWORD }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(409);
  });
});
