import { z } from "zod";
import { ApiError } from "./apiError";

/**
 * Paginación por cursor (keyset), no por OFFSET.
 *
 * Con OFFSET, la página 30 obliga a la base a recorrer y descartar 1.450
 * filas, y si entra un registro nuevo mientras el usuario pagina, las filas
 * se "corren" (duplicados u omisiones). Con cursor, cada página continúa
 * exactamente después del último elemento visto, usando el índice
 * (…, fecha DESC) ya existente, así que el costo no crece con la página.
 *
 * El orden es (fecha DESC, id DESC); el id desempata filas con la misma
 * fecha. El cursor es opaco para el cliente: base64url("<fecha ISO>|<id>").
 *
 * Contrato: GET ...?limit=50&cursor=<nextCursor>  →  { items: [...], nextCursor: string | null }
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(200).optional(),
});

export interface PageParams {
  limit: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function encodeCursor(date: Date, id: string): string {
  return Buffer.from(`${date.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(cursor: string): { date: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const date = new Date(iso ?? "");
  if (!id || Number.isNaN(date.getTime())) {
    throw new ApiError(400, "Cursor de paginación inválido");
  }
  return { date, id };
}

/**
 * Filtro Prisma "después del cursor" para el orden (field DESC, id DESC):
 *   field < fecha  O  (field = fecha Y id < idCursor)
 */
export function afterCursor<F extends string>(field: F, cursor?: string) {
  if (!cursor) return {};
  const { date, id } = decodeCursor(cursor);
  return { OR: [{ [field]: { lt: date } }, { [field]: date, id: { lt: id } }] } as Record<string, unknown>;
}

/**
 * Pide limit+1 filas: si llega la fila extra, hay más páginas y el cursor
 * apunta al último elemento devuelto.
 */
export function toPage<T extends { id: string }>(rows: T[], limit: number, dateOf: (row: T) => Date): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(dateOf(last), last.id) : null };
}
