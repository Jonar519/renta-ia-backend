import bcrypt from "bcrypt";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../src/config/prisma";
import {
  createFirstAdmin,
  FIRST_ADMIN_AUDIT_ACTION,
  FirstAdminInputError,
  firstAdminState,
  parseFirstAdminInput,
} from "../../src/modules/admin/firstAdmin";
import { type CliDb, type CliIo, PromptAbortedError, run } from "../../src/scripts/crearAdmin";
import { app, authHeader, TEST_PASSWORD, unique } from "../helpers";

/**
 * Alta del primer admin (src/modules/admin/firstAdmin.ts y el CLI
 * src/scripts/crearAdmin.ts) contra la base de pruebas.
 *
 * La base es compartida y otros archivos ya crearon admins: los casos de
 * "no hay ningún admin" corren en una transacción que primero los degrada y
 * al final se deshace (ROLLBACK), así no se toca a nadie más.
 */

const ROLLBACK = new Error("rollback de la prueba");

async function withoutAdmins<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let out!: T;
  await prisma
    .$transaction(async (tx) => {
      await tx.user.updateMany({ where: { role: "admin" }, data: { role: "accountant" } });
      out = await fn(tx);
      throw ROLLBACK;
    })
    .catch((err: unknown) => {
      if (err !== ROLLBACK) throw err;
    });
  return out;
}

const realDb: CliDb = { $transaction: (fn) => prisma.$transaction(fn), $disconnect: async () => {} };
const emptyDb: CliDb = { $transaction: (fn) => withoutAdmins(fn), $disconnect: async () => {} };

function fakeIo(options: { passwords?: string[]; stdin?: string; tty?: boolean; env?: CliIo["env"] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(options.passwords ?? [])];
  const readHidden = vi.fn(async () => {
    const next = answers.shift();
    if (next === undefined) throw new PromptAbortedError();
    return next;
  });
  const io: CliIo = {
    env: options.env ?? { DATABASE_URL: "postgresql://usada-solo-por-openDb" },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readHidden: options.tty === false ? null : readHidden,
    readStdin: async () => options.stdin ?? "",
  };
  return { io, out, err, readHidden, all: () => [...out, ...err].join("\n") };
}

const PASSWORD = "Libro-Mayor-Cuadrado-2026";
const newEmail = () => `primer-admin-${unique()}@test.local`;

async function createExistingAdmin(email: string) {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
  await prisma.user.create({ data: { name: "Admin previa", email, role: "admin", passwordHash } });
}

describe("Primer admin: núcleo (firstAdmin.ts)", () => {
  it("sin admins, crea uno activo con el hash del login (bcrypt costo 10), auditado y sin MFA", async () => {
    const email = newEmail();
    const input = parseFirstAdminInput({ email: `  ${email.toUpperCase()} `, name: "Ana Contable" });
    expect(input.email).toBe(email);

    const user = await withoutAdmins(async (tx) => {
      const result = await createFirstAdmin(tx, input, PASSWORD);
      expect(result.kind).toBe("created");
      return tx.user.findUniqueOrThrow({ where: { email }, include: { mfa: true } });
    });
    expect(user).toMatchObject({ role: "admin", status: "active", name: "Ana Contable", mfa: null });
    expect(user.passwordHash).toMatch(/^\$2b\$10\$/);
    expect(await bcrypt.compare(PASSWORD, user.passwordHash!)).toBe(true);
    // Rollback: nada quedó en la base.
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("escribe la auditoría con la acción propia, sin datos sensibles", async () => {
    const audit = await withoutAdmins(async (tx) => {
      const result = await createFirstAdmin(tx, parseFirstAdminInput({ email: newEmail(), name: "Ana" }), PASSWORD);
      if (result.kind !== "created") throw new Error(result.kind);
      return tx.auditLog.findFirstOrThrow({ where: { entityId: result.userId } });
    });
    expect(audit).toMatchObject({ action: FIRST_ADMIN_AUDIT_ACTION, entity: "user", ip: null });
    expect(JSON.stringify({ ...audit, id: String(audit.id) })).not.toContain(PASSWORD);
  });

  it("aplica la política de contraseñas del registro (contra su nombre y correo) y no crea nada", async () => {
    const email = newEmail();
    const input = parseFirstAdminInput({ email, name: "Mariana Ríos" });
    for (const bad of ["corta1", "Password2024!", "soy-Mariana-2026", `x-${email.split("@")[0]}-x`]) {
      const attempt = withoutAdmins((tx) => createFirstAdmin(tx, input, bad));
      await expect(attempt).rejects.toBeInstanceOf(FirstAdminInputError);
    }
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("valida nombre y correo como la invitación", () => {
    expect(() => parseFirstAdminInput({ email: "no-es-correo", name: "Ana" })).toThrow(FirstAdminInputError);
    expect(() => parseFirstAdminInput({ email: newEmail(), name: "A" })).toThrow(FirstAdminInputError);
  });

  it("si el correo ya existe no cambia ni el rol ni la contraseña", async () => {
    const email = newEmail();
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
    await prisma.user.create({ data: { name: "Contador", email, role: "accountant", passwordHash } });

    const result = await withoutAdmins((tx) =>
      createFirstAdmin(tx, parseFirstAdminInput({ email, name: "Otro" }), PASSWORD)
    );
    expect(result).toEqual({ kind: "email_exists", role: "accountant", status: "active" });
    expect(await prisma.user.findUniqueOrThrow({ where: { email } })).toMatchObject({
      role: "accountant",
      passwordHash,
      name: "Contador",
    });
  });

  it("si ya hay un admin activo no crea otro", async () => {
    await createExistingAdmin(newEmail());
    const email = newEmail();
    const state = await firstAdminState(prisma, email);
    expect(state.kind).toBe("admin_exists");
    expect(
      await prisma.$transaction((tx) => createFirstAdmin(tx, parseFirstAdminInput({ email, name: "Ana" }), PASSWORD))
    ).toMatchObject({ kind: "admin_exists" });
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });
});

describe("Primer admin: CLI (npm run admin:crear)", () => {
  const args = (email: string, ...rest: string[]) => ["--correo", email, "--nombre", "Ana Contable", ...rest];

  it("pide la contraseña dos veces sin eco, crea el admin y nunca imprime la contraseña ni el hash", async () => {
    const { io, out, readHidden, all } = fakeIo({ passwords: [PASSWORD, PASSWORD] });
    const email = newEmail();
    expect(await run(args(email), io, async () => emptyDb)).toBe(0);
    expect(readHidden).toHaveBeenCalledTimes(2);
    expect(out[0]).toContain(`Administrador creado: ${email}`);
    expect(all()).toMatch(/verificación en dos pasos/);
    expect(all()).not.toContain(PASSWORD);
    expect(all()).not.toMatch(/\$2[aby]\$/);
  });

  it("--stdin: toma la primera línea, sin pedir confirmación", async () => {
    const { io, readHidden, all } = fakeIo({ stdin: `${PASSWORD}\n` });
    expect(await run(args(newEmail(), "--stdin"), io, async () => emptyDb)).toBe(0);
    expect(readHidden).not.toHaveBeenCalled();
    expect(all()).not.toContain(PASSWORD);
  });

  it("si la confirmación no coincide, sale con 1 y no crea nada", async () => {
    const { io, err } = fakeIo({ passwords: [PASSWORD, `${PASSWORD}x`] });
    const create = vi.fn();
    const db: CliDb = {
      $transaction: (fn) => withoutAdmins(async (tx) => (create(), fn(tx))),
      $disconnect: async () => {},
    };
    expect(await run(args(newEmail()), io, async () => db)).toBe(1);
    expect(err.join("\n")).toMatch(/no coinciden/);
    expect(create).toHaveBeenCalledTimes(1); // solo la lectura del estado
  });

  it("contraseña fuera de la política: lista los problemas sin repetir la contraseña", async () => {
    const weak = "Password2024!";
    const { io, err, all } = fakeIo({ passwords: [weak, weak] });
    expect(await run(args(newEmail()), io, async () => emptyDb)).toBe(1);
    expect(err.join("\n")).toMatch(/demasiado común/);
    expect(all()).not.toContain(weak);
  });

  it("Ctrl+C mientras escribe: cancela con 1", async () => {
    const { io, err } = fakeIo({ passwords: [] });
    expect(await run(args(newEmail()), io, async () => emptyDb)).toBe(1);
    expect(err.join("\n")).toMatch(/Cancelado/);
  });

  it("sin terminal interactiva y sin --stdin, no pide nada y sale con 1", async () => {
    const { io, err } = fakeIo({ tty: false });
    expect(await run(args(newEmail()), io, async () => emptyDb)).toBe(1);
    expect(err.join("\n")).toMatch(/terminal interactiva/);
  });

  it("idempotente: si el correo ya existe, informa, no pide contraseña y sale con 0", async () => {
    const email = newEmail();
    await createExistingAdmin(email);
    const { io, out, readHidden } = fakeIo({ passwords: [PASSWORD, PASSWORD] });
    expect(await run(args(email.toUpperCase()), io, async () => realDb)).toBe(0);
    expect(readHidden).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/ya tiene una cuenta \(rol admin, estado active\)/);
  });

  it("si ya hay un admin (con otro correo), lo indica y sale con 0 sin crear", async () => {
    await createExistingAdmin(newEmail());
    const email = newEmail();
    const { io, out, readHidden } = fakeIo();
    expect(await run(args(email), io, async () => realDb)).toBe(0);
    expect(readHidden).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/Ya hay .*administrador/);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("errores de uso (2) y falta de DATABASE_URL (1) sin abrir la base", async () => {
    const openDb = vi.fn(async () => realDb);
    expect(await run([], fakeIo().io, openDb)).toBe(2);
    expect(await run([...args(newEmail()), "--password", "x"], fakeIo().io, openDb)).toBe(2);
    const noUrl = fakeIo({ env: {} });
    expect(await run(args(newEmail()), noUrl.io, openDb)).toBe(1);
    expect(noUrl.err.join("\n")).toMatch(/DATABASE_URL/);
    expect(openDb).not.toHaveBeenCalled();
  });

  it("de punta a punta: el admin creado inicia sesión con esa contraseña y la API le exige activar MFA", async () => {
    // Sin transacción: el login necesita ver la cuenta. Se degradan los admins
    // existentes (confirmado) y se restauran al final.
    const admins = await prisma.user.findMany({ where: { role: "admin" }, select: { id: true } });
    const ids = admins.map((a) => a.id);
    await prisma.user.updateMany({ where: { id: { in: ids } }, data: { role: "accountant" } });
    try {
      const email = newEmail();
      const { io } = fakeIo({ passwords: [PASSWORD, PASSWORD] });
      expect(await run(args(email), io, async () => realDb)).toBe(0);

      const login = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.user).toMatchObject({ role: "admin", mfaEnabled: false });
      const clients = await request(app).get("/api/clients").set(authHeader(login.body.accessToken));
      expect(clients.status).toBe(403);
      expect(clients.body.code).toBe("mfa_enrollment_required");

      // Segunda corrida: nada que hacer, misma contraseña.
      const again = fakeIo({ passwords: ["Otra-Frase-Distinta-2026", "Otra-Frase-Distinta-2026"] });
      expect(await run(args(email), again.io, async () => realDb)).toBe(0);
      expect(again.readHidden).not.toHaveBeenCalled();
      expect((await request(app).post("/api/auth/login").send({ email, password: PASSWORD })).status).toBe(200);
    } finally {
      await prisma.user.updateMany({ where: { id: { in: ids } }, data: { role: "admin" } });
    }
  });
});
