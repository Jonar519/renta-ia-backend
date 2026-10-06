import { env } from "../../config/env";
import type { EmailMessage } from "../../services/email";
import { ROLE_NAMES } from "./roleNames";
import { escapeHtml as escape } from "../../utils/escapeHtml";

/**
 * Correo de invitación. El enlace lleva el token en el FRAGMENTO (#): el
 * navegador nunca lo envía al servidor ni en el Referer. Es el único lugar
 * donde viaja el token en claro (el admin no lo ve).
 */
export function invitationEmail(input: {
  to: string;
  name: string;
  role: keyof typeof ROLE_NAMES;
  invitedBy: string;
  token: string;
  expiresAt: Date;
}): EmailMessage {
  const link = `${env.appUrl}/#/invitacion/${input.token}`;
  const until = input.expiresAt.toLocaleString("es-CO", { timeZone: "America/Bogota" });
  const role = ROLE_NAMES[input.role];
  return {
    to: input.to,
    template: "invitation",
    subject: "Te invitaron a Renta IA",
    text: [
      `Hola, ${input.name}:`,
      "",
      `${input.invitedBy} te invitó a Renta IA con el rol de ${role}.`,
      "Para activar tu cuenta, abre este enlace y define tu contraseña:",
      "",
      link,
      "",
      `El enlace sirve una sola vez y vence el ${until} (hora de Colombia).`,
      "Si no esperabas esta invitación, ignora este correo: sin activarla, la cuenta no tiene acceso.",
    ].join("\n"),
    html: `<p>Hola, ${escape(input.name)}:</p>
<p>${escape(input.invitedBy)} te invitó a <strong>Renta IA</strong> con el rol de ${escape(role)}.</p>
<p><a href="${escape(link)}">Activar mi cuenta</a></p>
<p>El enlace sirve una sola vez y vence el ${escape(until)} (hora de Colombia).</p>
<p>Si no esperabas esta invitación, ignora este correo: sin activarla, la cuenta no tiene acceso.</p>`,
  };
}
