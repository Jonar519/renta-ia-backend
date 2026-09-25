// Formato UUID genérico (8-4-4-4-12 hex). No se exige la versión 4 porque
// los datos de prueba del seed usan UUIDs fijos que no son v4
// (ej. aaaaaaaa-0000-0000-0000-000000000001).
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}
