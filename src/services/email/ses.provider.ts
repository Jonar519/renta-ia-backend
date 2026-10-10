import { prisma } from "../../config/prisma";
import { EmailDeliveryError, type EmailMessage, type EmailProvider, type SendResult } from "./email.interface";

/**
 * Amazon SES v2. Inerte hasta que se configure (EMAIL_PROVIDER=ses +
 * SES_REGION + EMAIL_FROM, validados por env.ts al arrancar):
 *  - el SDK de AWS NO se carga mientras el proveedor activo sea "mock"
 *    (import dinámico en el primer envío);
 *  - las credenciales las resuelve el SDK (AWS_*, perfil o rol IAM) al
 *    enviar: sin ellas el envío falla ANTES de cualquier llamada a SES y
 *    queda registrado como "failed".
 *
 * En email_outbox solo se guardan metadatos (destinatario, plantilla, asunto,
 * id de SES, error): nunca el cuerpo, que puede llevar un token en claro
 * (la base lo impide: chk_email_outbox_body_only_mock).
 */

/** Lo mínimo que se usa del cliente de SES (inyectable en pruebas). */
export interface SesSender {
  sendEmail(input: SesSendEmailInput): Promise<{ MessageId?: string }>;
}

export interface SesSendEmailInput {
  FromEmailAddress: string;
  Destination: { ToAddresses: string[] };
  Content: {
    Simple: {
      Subject: { Data: string; Charset: "UTF-8" };
      Body: { Text: { Data: string; Charset: "UTF-8" }; Html: { Data: string; Charset: "UTF-8" } };
    };
  };
}

async function createSdkSender(region: string): Promise<SesSender> {
  const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
  const client = new SESv2Client({ region });
  return { sendEmail: (input) => client.send(new SendEmailCommand(input)) };
}

export function toSesInput(from: string, message: EmailMessage): SesSendEmailInput {
  return {
    FromEmailAddress: from,
    Destination: { ToAddresses: [message.to] },
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: message.text, Charset: "UTF-8" },
          Html: { Data: message.html, Charset: "UTF-8" },
        },
      },
    },
  };
}

export function createSesEmailProvider(options: {
  region: string;
  from: string;
  sender?: SesSender;
  db?: typeof prisma;
}): EmailProvider {
  const db = options.db ?? prisma;
  let sender: Promise<SesSender> | null = options.sender ? Promise.resolve(options.sender) : null;

  const record = (message: EmailMessage, outcome: { messageId?: string; error?: string }) =>
    db.emailOutbox.create({
      data: {
        provider: "ses",
        toAddress: message.to,
        template: message.template,
        subject: message.subject,
        status: outcome.error ? "failed" : "sent",
        providerMessageId: outcome.messageId ?? null,
        error: outcome.error ? outcome.error.slice(0, 300) : null,
      },
    });

  return {
    name: "ses",
    async send(message: EmailMessage): Promise<SendResult> {
      try {
        sender ??= createSdkSender(options.region);
        const { MessageId } = await (await sender).sendEmail(toSesInput(options.from, message));
        const messageId = MessageId ?? "";
        await record(message, { messageId });
        return { provider: "ses", messageId };
      } catch (err) {
        const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        await record(message, { error: reason });
        throw new EmailDeliveryError(`No se pudo enviar el correo con SES (${reason})`, "ses");
      }
    },
  };
}
