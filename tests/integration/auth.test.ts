import { describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app, authHeader, createAccount, invite, testAdmin, TEST_PASSWORD, unique } from "../helpers";
import { authService } from "../../src/modules/auth/auth.service";
import { prisma } from "../../src/config/prisma";

describe("auth: sin registro público", () => {
  it("POST /api/auth/register ya no existe (404), aunque se envíe un rol", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Intruso", email: `intruso-${unique()}@test.local`, password: TEST_PASSWORD, role: "admin" });
    expect(res.status).toBe(404);
    expect(await prisma.user.count({ where: { name: "Intruso" } })).toBe(0);
  });

  it("POST /api/admin/users (alta con contraseña por un admin) ya no existe (404)", async () => {
    const admin = await testAdmin();
    const res = await request(app)
      .post("/api/admin/users")
      .set(authHeader(admin.token))
      .send({ name: "Con clave", email: `clave-${unique()}@test.local`, password: TEST_PASSWORD, role: "assistant" });
    expect(res.status).toBe(404);
  });

  it("invitar ignora cualquier contraseña enviada por el admin: la cuenta nace pendiente y sin contraseña", async () => {
    const admin = await testAdmin();
    const email = `sinclave-${unique()}@test.local`;
    const res = await request(app)
      .post("/api/admin/invitations")
      .set(authHeader(admin.token))
      .send({ name: "Sin clave", email, role: "accountant", password: TEST_PASSWORD, passwordHash: "x" });
    expect(res.status).toBe(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ status: "invited", passwordHash: null });
    // Y no puede iniciar sesión con la contraseña que intentó fijar el admin.
    const login = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    expect(login.status).toBe(401);
  });
});

describe("auth.service: login", () => {
  it("la contraseña elegida al activar la cuenta se guarda con bcrypt, nunca en texto plano", async () => {
    const { user } = await createAccount("Hash");
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.passwordHash).not.toBe(TEST_PASSWORD);
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$10\$/);
    expect(await bcrypt.compare(TEST_PASSWORD, stored.passwordHash!)).toBe(true);
  });

  it("la respuesta de la activación no expone el hash", async () => {
    const account = await createAccount("Sin hash");
    expect(account.user).not.toHaveProperty("passwordHash");
    expect(account.token).toEqual(expect.any(String));
  });

  it("login con contraseña incorrecta da 401", async () => {
    const { email } = await createAccount("Login");
    await expect(
      authService.login({ email, password: "otra-clave" }, { ipPrefix: null, location: null, device: null })
    ).rejects.toMatchObject({ statusCode: 401 });
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
    const { email } = await createAccount("Ok");
    const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it("invitar un correo ya usado da 409 (cuenta activa o invitación pendiente)", async () => {
    const { email } = await createAccount("Primero");
    const admin = await testAdmin();
    const again = (to: string) =>
      request(app)
        .post("/api/admin/invitations")
        .set(authHeader(admin.token))
        .send({ name: "Otro", email: to, role: "accountant" });
    expect((await again(email.toUpperCase())).status).toBe(409);

    const pending = await invite({ role: "accountant" });
    const second = await again(pending.email);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/Reenviar/);
  });
});
