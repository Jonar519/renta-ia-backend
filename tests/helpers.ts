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

export async function registerUser(name = "Contador de prueba") {
  const email = `user-${unique()}@test.local`;
  const res = await request(app).post("/api/auth/register").send({ name, email, password: TEST_PASSWORD });
  if (res.status !== 201) throw new Error(`registerUser falló (${res.status}): ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken as string, user: res.body.user as { id: string; role: string }, email };
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
