/**
 * Proveedor de correo intercambiable (regla de proveedores externos, Fase 5):
 * el resto del código solo conoce esta interfaz y obtiene la implementación
 * de services/email/index.ts. Hoy hay dos:
 *  - mock: no envía nada; guarda el correo completo en email_outbox
 *    (desarrollo, pruebas y demos; prohibido en producción).
 *  - ses: Amazon SES v2; se activa al cargar las credenciales en el cierre
 *    del curso (EMAIL_PROVIDER=ses + SES_REGION + EMAIL_FROM).
 */

/** Qué correo es (columna email_outbox.template; sirve para buscarlo en pruebas y demos). */
export type EmailTemplate =
  | "invitation"
  | "password_reset"
  | "email_change_verification"
  | "email_change_notice"
  | "password_change_notice"
  | "test";

export interface EmailMessage {
  to: string;
  template: EmailTemplate;
  subject: string;
  text: string;
  html: string;
}

export interface SendResult {
  provider: "mock" | "ses";
  messageId: string;
}

export interface EmailProvider {
  readonly name: "mock" | "ses";
  send(message: EmailMessage): Promise<SendResult>;
}

/** El proveedor no pudo entregar el correo (queda registrado como "failed"). */
export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly provider: "mock" | "ses"
  ) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}
