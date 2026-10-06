import { describe, expect, it } from "vitest";
import { randomBytes, randomUUID, createHash } from "crypto";
import request from "supertest";
import { app, TEST_PASSWORD, unique } from "../helpers";
import { prisma } from "../../src/config/prisma";

/**
 * Migración 017: garantías del ESQUEMA (no del backend) sobre las cuentas
 * pendientes. Cada prueba intenta violar una regla con SQL directo, como lo
 * haría un bug futuro del backend o alguien con acceso a la base.
 */

const sql = (text: string, ...params: unknown[]) => prisma.$executeRawUnsafe(text, ...params);
const hex64 = () => createHash("sha256").update(randomBytes(16)).digest("hex");
const HASH = "$2b$04$abcdefghijklmnopqrstuuJ6p3Ew7gV2k3Yw0Q9yUq0d2b4F6H8J."; // bcrypt de prueba

async function insertUser(status: "invited" | "active"): Promise<string> {
  const id = randomUUID();
  await sql(
    `INSERT INTO users (id, name, email, password_hash, role, status)
     VALUES ($1::uuid, 'Prueba 017', $2, $3, 'assistant', $4::account_status)`,
    id,
    `estado-${unique()}` + "@test.local",
    status === "active" ? HASH : null,
    status
  );
  return id;
}

const insertSession = (userId: string, extra = "") =>
  sql(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at${extra ? ", user_status" : ""})
     VALUES ($1::uuid, gen_random_uuid(), $2, now() + interval '7 days'${extra ? `, ${extra}` : ""})`,
    userId,
    hex64()
  );

const insertInvitation = (userId: string, opts: { hours?: number; status?: string } = {}) =>
  sql(
    `INSERT INTO user_invitations (user_id, token_hash, expires_at${opts.status ? ", user_status" : ""})
     VALUES ($1::uuid, $2, now() + make_interval(hours => $3::int)${opts.status ? `, '${opts.status}'::account_status` : ""})`,
    userId,
    hex64(),
    opts.hours ?? 72
  );

describe("017: estado de la cuenta (users)", () => {
  it("una cuenta pendiente NO puede tener contraseña", async () => {
    await expect(
      sql(
        `INSERT INTO users (name, email, password_hash, status) VALUES ('X', $1, $2, 'invited')`,
        `p-${unique()}` + "@t.local",
        HASH
      )
    ).rejects.toThrow(/chk_users_password_by_status/);
  });

  it("una cuenta activa DEBE tener contraseña", async () => {
    await expect(
      sql(
        `INSERT INTO users (name, email, password_hash, status) VALUES ('X', $1, NULL, 'active')`,
        `a-${unique()}` + "@t.local"
      )
    ).rejects.toThrow(/chk_users_password_by_status/);
  });

  it("las cuentas existentes y las del registro actual quedan activas por defecto", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Activa por defecto", email: `def-${unique()}` + "@t.local", password: TEST_PASSWORD });
    expect(res.status).toBe(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: res.body.user.id } });
    expect(user.status).toBe("active");
  });
});

describe("017: una cuenta pendiente nunca tiene sesiones", () => {
  it("INSERT de una sesión para una cuenta pendiente → rechazado por la FK compuesta", async () => {
    const invited = await insertUser("invited");
    await expect(insertSession(invited)).rejects.toThrow(/fk_refresh_tokens_active_user/);
  });

  it("forzar user_status = 'invited' en la sesión → rechazado por el CHECK", async () => {
    const invited = await insertUser("invited");
    await expect(insertSession(invited, "'invited'::account_status")).rejects.toThrow(/chk_refresh_tokens_user_active/);
  });

  it("volver pendiente una cuenta CON sesiones → rechazado (FK ON UPDATE NO ACTION)", async () => {
    const active = await insertUser("active");
    await insertSession(active);
    await expect(
      sql(`UPDATE users SET status = 'invited', password_hash = NULL WHERE id = $1::uuid`, active)
    ).rejects.toThrow(/fk_refresh_tokens_active_user/);
  });

  it("también con sesiones ya revocadas: mientras exista la fila, no se puede volver pendiente", async () => {
    const active = await insertUser("active");
    await insertSession(active);
    await sql(
      `UPDATE refresh_tokens SET revoked_at = now(), revoke_reason = 'logout' WHERE user_id = $1::uuid`,
      active
    );
    await expect(
      sql(`UPDATE users SET status = 'invited', password_hash = NULL WHERE id = $1::uuid`, active)
    ).rejects.toThrow(/fk_refresh_tokens_active_user/);
  });

  it("sin sesiones, volver pendiente sí es posible (y exige quitar la contraseña)", async () => {
    const active = await insertUser("active");
    await expect(sql(`UPDATE users SET status = 'invited' WHERE id = $1::uuid`, active)).rejects.toThrow(
      /chk_users_password_by_status/
    );
    await expect(
      sql(`UPDATE users SET status = 'invited', password_hash = NULL WHERE id = $1::uuid`, active)
    ).resolves.toBe(1);
  });

  it("el backend tampoco puede: sessions.start contra una cuenta pendiente falla en la base", async () => {
    const { sessionsService } = await import("../../src/modules/auth/sessions.service");
    const invited = await insertUser("invited");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: invited } });
    await expect(sessionsService.start(user)).rejects.toThrow(/fk_refresh_tokens_active_user|Foreign key/i);
    expect(await prisma.refreshToken.count({ where: { userId: invited } })).toBe(0);
  });

  it("login de una cuenta pendiente: 401 idéntico al de un correo inexistente", async () => {
    const invited = await insertUser("invited");
    const { email } = await prisma.user.findUniqueOrThrow({ where: { id: invited } });
    const pending = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    const missing = await request(app)
      .post("/api/auth/login")
      .send({ email: `nadie-${unique()}` + "@t.local", password: TEST_PASSWORD });
    expect(pending.status).toBe(401);
    expect(pending.body).toEqual(missing.body);
    expect(pending.headers["set-cookie"]).toBeUndefined();
  });
});

describe("017: invitaciones (solo para cuentas pendientes, 72 h, una vigente)", () => {
  it("no se puede invitar (crear invitación) a una cuenta activa", async () => {
    const active = await insertUser("active");
    await expect(insertInvitation(active)).rejects.toThrow(/fk_user_invitations_invited_user/);
    await expect(insertInvitation(active, { status: "active" })).rejects.toThrow(/chk_user_invitations_user_invited/);
  });

  it("vigencia máxima de 72 horas, impuesta por la base", async () => {
    const invited = await insertUser("invited");
    await expect(insertInvitation(invited, { hours: 73 })).rejects.toThrow(/chk_user_invitations_expiry/);
    await expect(insertInvitation(invited, { hours: 0 })).rejects.toThrow(/chk_user_invitations_expiry/);
    await expect(insertInvitation(invited, { hours: 72 })).resolves.toBe(1);
  });

  it("solo una invitación vigente por cuenta: reenviar exige revocar la anterior", async () => {
    const invited = await insertUser("invited");
    await insertInvitation(invited);
    // 23505 = unique_violation; la única restricción única sobre user_id es el
    // índice parcial uq_user_invitations_one_open (Prisma no muestra su nombre).
    await expect(insertInvitation(invited)).rejects.toThrow(/23505[\s\S]*Key \(user_id\)/);
    await sql(
      `UPDATE user_invitations SET revoked_at = now(), revoke_reason = 'resent' WHERE user_id = $1::uuid`,
      invited
    );
    await expect(insertInvitation(invited)).resolves.toBe(1);
  });

  it("solo se guarda un hash: un token en claro (no hex de 64) se rechaza", async () => {
    const invited = await insertUser("invited");
    await expect(
      sql(
        `INSERT INTO user_invitations (user_id, token_hash, expires_at) VALUES ($1::uuid, $2, now() + interval '1 hour')`,
        invited,
        randomBytes(32).toString("base64url").slice(0, 64)
      )
    ).rejects.toThrow(/token_hash/);
  });

  it("no se puede activar la cuenta mientras le quede una invitación: hay que consumirla en la misma transacción", async () => {
    const invited = await insertUser("invited");
    await insertInvitation(invited);
    await expect(
      sql(`UPDATE users SET status = 'active', password_hash = $2 WHERE id = $1::uuid`, invited, HASH)
    ).rejects.toThrow(/fk_user_invitations_invited_user/);

    await prisma.$transaction([
      prisma.$executeRawUnsafe(`DELETE FROM user_invitations WHERE user_id = $1::uuid`, invited),
      prisma.$executeRawUnsafe(
        `UPDATE users SET status = 'active', password_hash = $2 WHERE id = $1::uuid`,
        invited,
        HASH
      ),
    ]);
    await expect(insertSession(invited)).resolves.toBe(1); // ya activa: ahora sí puede tener sesiones
  });

  it("revocación coherente: revoked_at y revoke_reason van juntos", async () => {
    const invited = await insertUser("invited");
    await insertInvitation(invited);
    await expect(
      sql(`UPDATE user_invitations SET revoked_at = now() WHERE user_id = $1::uuid`, invited)
    ).rejects.toThrow(/chk_user_invitations_revoke_pair/);
  });

  it("borrar la cuenta borra sus invitaciones y sesiones (CASCADE)", async () => {
    const invited = await insertUser("invited");
    await insertInvitation(invited);
    await sql(`DELETE FROM users WHERE id = $1::uuid`, invited);
    expect(await prisma.userInvitation.count({ where: { userId: invited } })).toBe(0);
  });
});

describe("017: email_outbox", () => {
  const insertMail = (provider: string, body: string | null, status = "sent", error: string | null = null) =>
    sql(
      `INSERT INTO email_outbox (provider, to_address, template, subject, body_text, status, error)
       VALUES ($1, 'a@t.local', 'test', 'Asunto', $2, $3, $4)`,
      provider,
      body,
      status,
      error
    );

  it("solo el proveedor simulado puede guardar el cuerpo (puede llevar un token en claro)", async () => {
    await expect(insertMail("mock", "Enlace: https://…/token")).resolves.toBe(1);
    await expect(insertMail("ses", "Enlace: https://…/token")).rejects.toThrow(/chk_email_outbox_body_only_mock/);
    await expect(insertMail("ses", null)).resolves.toBe(1);
  });

  it("proveedor desconocido y estados incoherentes se rechazan", async () => {
    await expect(insertMail("smtp", null)).rejects.toThrow(/email_outbox_provider_check/);
    await expect(insertMail("ses", null, "failed", null)).rejects.toThrow(/chk_email_outbox_error_when_failed/);
    await expect(insertMail("ses", null, "sent", "boom")).rejects.toThrow(/chk_email_outbox_error_when_failed/);
  });
});
