import { env } from "../../config/env";
import type { EmailMessage, EmailProvider, SendResult } from "./email.interface";
import { createMockEmailProvider } from "./mock.provider";
import { createSesEmailProvider } from "./ses.provider";

export type { EmailMessage, EmailProvider, EmailTemplate, SendResult } from "./email.interface";
export { EmailDeliveryError } from "./email.interface";

/**
 * Único punto de entrada al correo: el resto del código nunca importa un
 * adaptador concreto. El proveedor se elige UNA vez según EMAIL_PROVIDER
 * (env.ts lo validó al arrancar). Ver ADR 0010.
 */
let provider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  provider ??=
    env.emailProvider === "ses"
      ? createSesEmailProvider({ region: env.sesRegion!, from: env.emailFrom })
      : createMockEmailProvider();
  return provider;
}

export function sendEmail(message: EmailMessage): Promise<SendResult> {
  return getEmailProvider().send(message);
}
