import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import type { EmailMessage, EmailProvider, SendResult } from "./email.interface";

/**
 * ⚠️ PROVEEDOR DE CORREO SIMULADO — SOLO DESARROLLO Y PRUEBAS.
 *
 * No envía nada. Guarda cada correo COMPLETO (asunto y cuerpo) en la tabla
 * email_outbox, para que las pruebas automatizadas y las demos lean, por
 * ejemplo, el enlace de una invitación sin un servidor de correo real.
 *
 * Como el cuerpo puede llevar un token en claro, env.ts impide usarlo con
 * NODE_ENV=production y esta fábrica lo vuelve a comprobar. La base, además,
 * solo acepta cuerpos en filas con provider = 'mock' (migración 017).
 */
export function createMockEmailProvider(db = prisma): EmailProvider {
  if (env.nodeEnv === "production") {
    throw new Error("El proveedor de correo simulado no puede usarse en producción.");
  }
  return {
    name: "mock",
    async send(message: EmailMessage): Promise<SendResult> {
      const row = await db.emailOutbox.create({
        data: {
          provider: "mock",
          toAddress: message.to,
          template: message.template,
          subject: message.subject,
          bodyText: message.text,
          bodyHtml: message.html,
          status: "sent",
        },
        select: { id: true },
      });
      return { provider: "mock", messageId: row.id };
    },
  };
}
