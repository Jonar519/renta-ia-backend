import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/config/prisma";
import { unique } from "../helpers";
import type { EmailMessage } from "../../src/services/email";

/**
 * EmailProvider intercambiable (regla de proveedores externos): el simulado
 * es el de por defecto y guarda el correo completo en email_outbox; el de
 * SES queda INERTE sin configuración ni credenciales.
 */

// Cuenta cuántas veces se carga el SDK de AWS (debe ser 0 con el simulado).
const sdk = vi.hoisted(() => ({ loads: 0 }));
vi.mock("@aws-sdk/client-sesv2", async (importOriginal) => {
  sdk.loads++;
  return importOriginal();
});

const message = (to = `dest-${unique()}` + "@t.local"): EmailMessage => ({
  to,
  template: "test",
  subject: "Asunto de prueba",
  text: "Hola. Enlace: https://app.local/#/invitacion/TOKEN-EN-CLARO",
  html: "<p>Hola. <a href='https://app.local/#/invitacion/TOKEN-EN-CLARO'>Enlace</a></p>",
});

const lastMail = (to: string) => prisma.emailOutbox.findFirstOrThrow({ where: { toAddress: to } });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("proveedor por defecto: simulado (mock)", () => {
  it("sin EMAIL_PROVIDER se usa el simulado y guarda el correo COMPLETO en email_outbox", async () => {
    const { getEmailProvider, sendEmail } = await import("../../src/services/email");
    expect(getEmailProvider().name).toBe("mock");
    const msg = message();
    const result = await sendEmail(msg);
    const row = await lastMail(msg.to);
    expect(result).toEqual({ provider: "mock", messageId: row.id });
    expect(row).toMatchObject({
      provider: "mock",
      template: "test",
      subject: msg.subject,
      bodyText: msg.text,
      bodyHtml: msg.html,
      status: "sent",
    });
    expect(sdk.loads).toBe(0); // el SDK de AWS ni se cargó
  });
});

describe("configuración (env.ts) al arrancar", () => {
  const loadEnv = () => import("../../src/config/env");

  it("EMAIL_PROVIDER=ses sin SES_REGION o sin EMAIL_FROM: no arranca", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "ses");
    vi.stubEnv("SES_REGION", "");
    vi.stubEnv("EMAIL_FROM", "Renta IA <x@y.z>");
    await expect(loadEnv()).rejects.toThrow(/requiere la variable de entorno SES_REGION/);
    vi.resetModules();
    vi.stubEnv("SES_REGION", "us-east-1");
    vi.stubEnv("EMAIL_FROM", "");
    await expect(loadEnv()).rejects.toThrow(/requiere la variable de entorno EMAIL_FROM/);
  });

  it("el simulado está prohibido en producción, y en producción el valor por defecto es SES", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ORIGIN", "https://app.example");
    vi.stubEnv("EMAIL_PROVIDER", "mock");
    await expect(loadEnv()).rejects.toThrow(/EMAIL_PROVIDER=mock es solo para desarrollo/);
    vi.resetModules();
    vi.stubEnv("EMAIL_PROVIDER", "");
    vi.stubEnv("SES_REGION", "");
    // Sin EMAIL_PROVIDER en producción se exige SES (y su configuración).
    await expect(loadEnv()).rejects.toThrow(/EMAIL_PROVIDER=ses requiere/);
  });

  it("un proveedor desconocido no arranca", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "smtp");
    await expect(loadEnv()).rejects.toThrow(/EMAIL_PROVIDER="smtp" no es válido/);
  });

  it("con SES configurado, el SDK no se carga hasta el primer envío", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "ses");
    vi.stubEnv("SES_REGION", "us-east-1");
    vi.stubEnv("EMAIL_FROM", "Renta IA <x@y.z>");
    const before = sdk.loads;
    const { getEmailProvider } = await import("../../src/services/email");
    expect(getEmailProvider().name).toBe("ses");
    expect(sdk.loads).toBe(before);
  });
});

describe("adaptador SES (con cliente inyectado, sin red)", () => {
  it("traduce el mensaje al formato de SES v2 y guarda SOLO metadatos", async () => {
    const { createSesEmailProvider } = await import("../../src/services/email/ses.provider");
    const sender = { sendEmail: vi.fn().mockResolvedValue({ MessageId: "ses-123" }) };
    const ses = createSesEmailProvider({ region: "us-east-1", from: "Renta IA <no@renta.ia>", sender });
    const msg = message();
    await expect(ses.send(msg)).resolves.toEqual({ provider: "ses", messageId: "ses-123" });
    expect(sender.sendEmail).toHaveBeenCalledWith({
      FromEmailAddress: "Renta IA <no@renta.ia>",
      Destination: { ToAddresses: [msg.to] },
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: "UTF-8" },
          Body: { Text: { Data: msg.text, Charset: "UTF-8" }, Html: { Data: msg.html, Charset: "UTF-8" } },
        },
      },
    });
    const row = await lastMail(msg.to);
    expect(row).toMatchObject({ provider: "ses", status: "sent", providerMessageId: "ses-123", error: null });
    expect(row.bodyText).toBeNull(); // el token en claro nunca queda en la base
    expect(row.bodyHtml).toBeNull();
  });

  it("si SES falla: EmailDeliveryError y fila 'failed' con el motivo, sin cuerpo", async () => {
    const { createSesEmailProvider } = await import("../../src/services/email/ses.provider");
    const { EmailDeliveryError } = await import("../../src/services/email");
    const sender = {
      sendEmail: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("Email address is not verified"), { name: "MessageRejected" })),
    };
    const ses = createSesEmailProvider({ region: "us-east-1", from: "x@y.z", sender });
    const msg = message();
    await expect(ses.send(msg)).rejects.toBeInstanceOf(EmailDeliveryError);
    const row = await lastMail(msg.to);
    expect(row).toMatchObject({
      status: "failed",
      error: "MessageRejected: Email address is not verified",
      bodyText: null,
    });
  });
});

describe("adaptador SES real SIN credenciales: inerte", () => {
  it("el envío falla al resolver credenciales (antes de llamar a SES) y queda registrado", async () => {
    // Sin ninguna fuente de credenciales: ni variables, ni archivos, ni metadatos de EC2.
    for (const name of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    ]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
    vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", "/no/existe/credentials");
    vi.stubEnv("AWS_CONFIG_FILE", "/no/existe/config");

    const { createSesEmailProvider } = await import("../../src/services/email/ses.provider");
    const ses = createSesEmailProvider({ region: "us-east-1", from: "Renta IA <no@renta.ia>" });
    const msg = message();
    const started = Date.now();
    await expect(ses.send(msg)).rejects.toThrow(/No se pudo enviar el correo con SES \(CredentialsProviderError/);
    expect(Date.now() - started).toBeLessThan(10_000);
    const row = await lastMail(msg.to);
    expect(row).toMatchObject({
      provider: "ses",
      status: "failed",
      providerMessageId: null,
      bodyText: null,
      bodyHtml: null,
    });
    expect(row.error).toMatch(/^CredentialsProviderError/);
  }, 20_000);
});
