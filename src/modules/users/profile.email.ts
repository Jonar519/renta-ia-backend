import { env } from "../../config/env";
import type { EmailMessage } from "../../services/email";
import { escapeHtml } from "../../utils/escapeHtml";

/**
 * Correos del perfil (B11). El enlace de confirmación lleva el token en el
 * FRAGMENTO (#): el navegador nunca lo envía al servidor ni en el Referer.
 */
const until = (date: Date) => date.toLocaleString("es-CO", { timeZone: "America/Bogota" });
const paragraphs = (lines: string[]) => lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("\n");

/** Al correo NUEVO: el enlace para confirmarlo. */
export function emailChangeVerification(to: string, name: string, token: string, expiresAt: Date): EmailMessage {
  const link = `${env.appUrl}/#/confirmar-correo/${token}`;
  const intro = [
    `Hola, ${name}:`,
    "Pediste usar este correo para tu cuenta de Renta IA. Para confirmarlo, abre este enlace:",
  ];
  const outro = [
    `Sirve una sola vez y vence el ${until(expiresAt)} (hora de Colombia).`,
    "Si no lo pediste tú, ignora este correo: no se cambia nada.",
  ];
  return {
    to,
    template: "email_change_verification",
    subject: "Confirma tu nuevo correo en Renta IA",
    text: [...intro, "", link, "", ...outro].join("\n"),
    html: `${paragraphs(intro)}\n<p><a href="${escapeHtml(link)}">Confirmar este correo</a></p>\n${paragraphs(outro)}`,
  };
}

/**
 * Al correo NUEVO, cuando ya pertenece a otra cuenta: sin enlace. La API
 * responde igual en ambos casos (no revela qué correos tienen cuenta).
 */
export function emailChangeTaken(to: string): EmailMessage {
  const lines = [
    "Hola:",
    "Alguien pidió usar este correo en una cuenta de Renta IA, pero ya pertenece a otra cuenta, así que no se puede.",
    "Si fuiste tú, usa otro correo o pide ayuda al administrador de tu firma. Si no, ignora este mensaje.",
  ];
  return {
    to,
    template: "email_change_verification",
    subject: "Este correo ya tiene una cuenta en Renta IA",
    text: lines.join("\n"),
    html: paragraphs(lines),
  };
}

/** Al correo ANTERIOR: se pidió o se completó el cambio. */
export function emailChangeNotice(
  to: string,
  name: string,
  newEmail: string,
  stage: "requested" | "completed"
): EmailMessage {
  const lines =
    stage === "requested"
      ? [
          `Hola, ${name}:`,
          `Se pidió cambiar el correo de tu cuenta de Renta IA a ${newEmail}. El cambio solo ocurre cuando se confirme desde ese correo.`,
          "Si no fuiste tú, cambia tu contraseña de inmediato y avisa al administrador de tu firma.",
        ]
      : [
          `Hola, ${name}:`,
          `El correo de tu cuenta de Renta IA cambió a ${newEmail}. Desde ahora inicias sesión con ese correo.`,
          "Si no fuiste tú, avisa de inmediato al administrador de tu firma.",
        ];
  return {
    to,
    template: "email_change_notice",
    subject: stage === "requested" ? "Se pidió cambiar el correo de tu cuenta" : "Cambió el correo de tu cuenta",
    text: lines.join("\n"),
    html: paragraphs(lines),
  };
}

/** Al correo de la cuenta: la contraseña cambió (y se cerraron las demás sesiones). */
export function passwordChangedNotice(to: string, name: string): EmailMessage {
  const lines = [
    `Hola, ${name}:`,
    "La contraseña de tu cuenta de Renta IA cambió y se cerraron tus demás sesiones.",
    'Si no fuiste tú, usa "¿Olvidaste tu contraseña?" en la pantalla de inicio y avisa al administrador de tu firma.',
  ];
  return {
    to,
    template: "password_change_notice",
    subject: "Cambió la contraseña de tu cuenta",
    text: lines.join("\n"),
    html: paragraphs(lines),
  };
}
