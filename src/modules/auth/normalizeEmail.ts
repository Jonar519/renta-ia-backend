/**
 * Los emails se guardan y se buscan siempre en minúsculas (y sin espacios):
 * "Ana@Example.com" y "ana@example.com" son la misma cuenta. La base de
 * datos lo refuerza con un índice único sobre lower(email).
 *
 * Módulo aparte, sin dependencias: lo usa también el script de alta del
 * primer admin, que no carga la configuración de la API.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
