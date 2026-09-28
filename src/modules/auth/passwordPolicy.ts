/**
 * Política mínima de contraseñas (en la línea de NIST SP 800-63B):
 *  - Largo: de 10 a 72 caracteres (bcrypt solo usa los primeros 72 bytes).
 *  - Sin reglas de composición arbitrarias ("una mayúscula, un símbolo…"),
 *    que empujan a patrones predecibles; en su lugar:
 *  - Se rechazan contraseñas muy comunes o triviales, y las que contienen
 *    la parte local del correo o el nombre de la persona.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 72;

// Lista corta de contraseñas y bases muy frecuentes en filtraciones públicas
// (se comparan en minúsculas y sin números/símbolos al final).
const COMMON = new Set([
  "password",
  "contraseña",
  "contrasena",
  "123456789",
  "1234567890",
  "qwerty",
  "qwertyuiop",
  "abc123",
  "iloveyou",
  "admin",
  "administrador",
  "welcome",
  "bienvenido",
  "colombia",
  "renta",
  "rentaia",
  "letmein",
  "dragon",
  "football",
  "monkey",
  "sunshine",
  "princess",
  "teamo",
  "tequiero",
  "clave",
  "secreto",
  "passw0rd",
]);

/** Parte "base" de una contraseña: minúsculas, sin dígitos ni símbolos al final. */
const base = (password: string) => password.toLowerCase().replace(/[\d\W_]+$/u, "");

export function passwordProblems(password: string, context: { email?: string; name?: string } = {}): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`Debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`);
  if (password.length > PASSWORD_MAX_LENGTH) problems.push(`Debe tener como máximo ${PASSWORD_MAX_LENGTH} caracteres`);
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(base(password)) || /^(.)\1+$/.test(password) || /^\d+$/.test(password)) {
    problems.push("Es demasiado común o fácil de adivinar");
  }
  const localPart = context.email?.split("@")[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && lower.includes(localPart)) {
    problems.push("No debe contener tu correo");
  }
  const firstName = context.name?.trim().split(/\s+/)[0]?.toLowerCase();
  if (firstName && firstName.length >= 4 && lower.includes(firstName)) {
    problems.push("No debe contener tu nombre");
  }
  return problems;
}
