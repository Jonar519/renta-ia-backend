import bcrypt from "bcrypt";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/config/prisma";

export const app = createApp();

// Cumple la política de contraseñas (src/modules/auth/passwordPolicy.ts).
export const TEST_PASSWORD = "Tributo-Seguro-2026";

let counter = 0;
/** Sufijo único para emails/cédulas: los tests comparten la base de datos. */
export function unique(): string {
  counter += 1;
  return `${Date.now()}-${counter}`;
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

type Role = "admin" | "accountant" | "assistant" | "client";
export interface Account {
  token: string;
  user: { id: string; name: string; email: string; role: Role };
  email: string;
  /** Cabecera Set-Cookie con el refresh token (para pruebas de sesión). */
  cookies: string[];
}

/**
 * Admin "de semilla" de las pruebas: se crea directamente en la base de
 * pruebas (como el seed de desarrollo, decisión D1). Es el único usuario que
 * no nace por invitación: alguien tiene que poder invitar al primero.
 */
let adminPromise: Promise<Account> | null = null;
export function testAdmin(): Promise<Account> {
  adminPromise ??= (async () => {
    const email = `admin-${unique()}@test.local`;
    await prisma.user.create({
      data: { name: "Admin de pruebas", email, role: "admin", passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) },
    });
    const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    if (res.status !== 200) throw new Error(`login del admin de pruebas falló (${res.status})`);
    return { token: res.body.accessToken, user: res.body.user, email, cookies: [] };
  })();
  return adminPromise;
}

/** Último enlace de invitación "enviado" a ese correo, leído de la bandeja simulada (email_outbox). */
export async function invitationTokenFor(email: string): Promise<string> {
  const mail = await prisma.emailOutbox.findFirst({
    where: { toAddress: email, template: "invitation" },
    orderBy: { createdAt: "desc" },
  });
  const token = mail?.bodyText?.match(/#\/invitacion\/([\w.-]+)/)?.[1];
  if (!token) throw new Error(`No hay correo de invitación para ${email} en email_outbox`);
  return token;
}

/** El admin invita (POST /api/admin/invitations); devuelve la cuenta pendiente creada. */
export async function invite(input: {
  role: Role;
  name?: string;
  email?: string;
  accountantUserId?: string;
  clientId?: string;
}) {
  const admin = await testAdmin();
  const email = input.email ?? `${input.role}-${unique()}@test.local`;
  const res = await request(app)
    .post("/api/admin/invitations")
    .set(authHeader(admin.token))
    .send({ name: input.name ?? `Prueba ${input.role}`, ...input, email });
  if (res.status !== 201) throw new Error(`invitación falló (${res.status}): ${JSON.stringify(res.body)}`);
  return { email, userId: res.body.userId as string, view: res.body };
}

/** La persona invitada abre el enlace del correo y define su contraseña. */
export async function acceptInvitation(email: string, password = TEST_PASSWORD): Promise<Account> {
  const token = await invitationTokenFor(email);
  const res = await request(app).post("/api/auth/invitations/accept").send({ token, password });
  if (res.status !== 200) throw new Error(`aceptar invitación falló (${res.status}): ${JSON.stringify(res.body)}`);
  return {
    token: res.body.accessToken,
    user: res.body.user,
    email,
    cookies: ([] as string[]).concat(res.headers["set-cookie"] ?? []),
  };
}

/** Cuenta activa de cualquier rol, creada por el flujo real: invitación → correo → activación. */
export async function createAccountWithRole(
  role: Role,
  extra: { name?: string; accountantUserId?: string; clientId?: string } = {}
): Promise<Account> {
  const { email } = await invite({ role, ...extra });
  return acceptInvitation(email);
}

/** Contador activo (lo que antes hacía el registro público, que ya no existe). */
export function createAccount(name = "Contador de prueba"): Promise<Account> {
  return createAccountWithRole("accountant", { name });
}

export async function createClient(token: string) {
  const res = await request(app)
    .post("/api/clients")
    .set(authHeader(token))
    .send({ fullName: "Cliente de prueba", documentNumber: `CC-${unique()}` });
  if (res.status !== 201) throw new Error(`createClient falló (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body as { id: string; accountantUserId: string };
}

/** Crea un documento directamente en la base (sin pasar por la cola). */
export async function createDocument(clientId: string, uploadedBy: string) {
  return prisma.document.create({
    data: {
      clientId,
      uploadedBy,
      docType: "income_certificate",
      originalName: "certificado.pdf",
      storageKey: `clients/${clientId}/documents/certificado.pdf`,
    },
  });
}

/** Buffer mínimo con firma PDF válida (%PDF). */
export const FAKE_PDF = Buffer.from("%PDF-1.4\n% documento de prueba\n");
