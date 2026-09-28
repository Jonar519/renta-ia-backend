import { AlertSeverity } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { taxCalendar, TaxCalendar } from "../../config/taxConfig";
import { alertsService } from "./alerts.service";

/**
 * Alertas de vencimiento de la declaración de renta.
 *
 * Un job diario (BullMQ, ver workers/scheduledTasks.worker.ts) recorre los
 * clientes y, para cada año gravable del calendario (src/config/
 * tax-calendar.json), calcula la fecha límite según los dos últimos dígitos
 * del NIT/cédula. Crea la alerta cuando faltan `diasDeAnticipacion` días o
 * menos, y en las ejecuciones siguientes la actualiza con severidad
 * creciente. Nunca duplica (dedupeKey "deadline:<año>" + índice único) y
 * nunca recrea una alerta que el contador ya marcó como resuelta.
 */

const SEVERITY_RANK: Record<AlertSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const BATCH_SIZE = 500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Dos últimos dígitos del documento, sin el dígito de verificación del NIT
 * ("900.123.456-7" → "56"; "1020304050" → "50"). null si no hay dígitos.
 */
export function lastTwoDigits(documentNumber: string): string | null {
  const withoutCheckDigit = documentNumber.includes("-")
    ? documentNumber.slice(0, documentNumber.lastIndexOf("-"))
    : documentNumber;
  const digits = withoutCheckDigit.replace(/\D/g, "");
  if (!digits) return null;
  return digits.slice(-2).padStart(2, "0");
}

/** Fecha de hoy (AAAA-MM-DD) en la zona horaria del calendario. */
export function todayIn(timeZone: string, now: Date): string {
  // en-CA formatea como AAAA-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Días de calendario entre dos fechas AAAA-MM-DD (positivo si `to` es posterior). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

export function severityFor(daysLeft: number, thresholds: TaxCalendar["umbralesSeveridad"]): AlertSeverity {
  if (daysLeft <= thresholds.critical) return "critical";
  if (daysLeft <= thresholds.high) return "high";
  if (daysLeft <= thresholds.medium) return "medium";
  return "low";
}

export function dueDateFor(calendar: TaxCalendar, taxYear: string, digits: string): string | null {
  const ranges = calendar.declaracionRentaPersonasNaturales[taxYear] ?? [];
  const n = Number(digits);
  return ranges.find((r) => n >= Number(r.desde) && n <= Number(r.hasta))?.vence ?? null;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function buildMessage(taxYear: string, dueDate: string, daysLeft: number, digits: string, isExample: boolean) {
  const when =
    daysLeft > 0
      ? `vence el ${formatDate(dueDate)} (faltan ${daysLeft} día${daysLeft === 1 ? "" : "s"})`
      : daysLeft === 0
        ? `vence HOY (${formatDate(dueDate)})`
        : `venció el ${formatDate(dueDate)} (hace ${-daysLeft} día${daysLeft === -1 ? "" : "s"})`;
  const example = isExample
    ? " ⚠️ Fecha de EJEMPLO: el calendario configurado no es el oficial de la DIAN; verifícala antes de actuar."
    : "";
  return `La declaración de renta del año gravable ${taxYear} ${when}, según los dos últimos dígitos del documento (${digits}).${example}`;
}

export interface DeadlineCheckResult {
  clientsScanned: number;
  created: number;
  updated: number;
  skippedResolved: number;
}

interface DeadlineCheckOptions {
  now?: Date;
  calendar?: TaxCalendar;
  /** Limitar a estos clientes (útil en pruebas). Por defecto: todos. */
  clientIds?: string[];
}

export async function runDeadlineCheck(options: DeadlineCheckOptions = {}): Promise<DeadlineCheckResult> {
  const { now = new Date(), calendar = taxCalendar, clientIds } = options;
  const today = todayIn(calendar.zonaHoraria, now);
  const taxYears = Object.keys(calendar.declaracionRentaPersonasNaturales);
  const result: DeadlineCheckResult = { clientsScanned: 0, created: 0, updated: 0, skippedResolved: 0 };

  if (calendar.esEjemplo) {
    logger.warn("tax-calendar.json tiene esEjemplo=true: las alertas de vencimiento usan fechas de EJEMPLO.");
  }

  let cursor: string | undefined;
  for (;;) {
    const clients = await prisma.client.findMany({
      where: clientIds ? { id: { in: clientIds } } : undefined,
      select: { id: true, documentNumber: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (clients.length === 0) break;
    cursor = clients[clients.length - 1]!.id;
    result.clientsScanned += clients.length;

    // Una consulta por lote para las alertas de vencimiento ya existentes.
    const existing = await prisma.alert.findMany({
      where: { clientId: { in: clients.map((c) => c.id) }, dedupeKey: { startsWith: "deadline:" } },
      orderBy: { createdAt: "desc" },
      select: { clientId: true, dedupeKey: true, status: true, severity: true },
    });
    const latestByKey = new Map<string, (typeof existing)[number]>();
    for (const alert of existing) {
      const key = `${alert.clientId}|${alert.dedupeKey}`;
      if (!latestByKey.has(key)) latestByKey.set(key, alert);
    }

    for (const client of clients) {
      const digits = lastTwoDigits(client.documentNumber);
      if (!digits) continue;

      for (const taxYear of taxYears) {
        const dueDate = dueDateFor(calendar, taxYear, digits);
        if (!dueDate) continue;
        const daysLeft = daysBetween(today, dueDate);
        const dedupeKey = `deadline:${taxYear}`;
        const previous = latestByKey.get(`${client.id}|${dedupeKey}`);

        if (previous?.status === "resolved") {
          result.skippedResolved++;
          continue;
        }
        // Solo se CREAN alertas dentro de la ventana; las ya existentes se
        // siguen actualizando (incluso vencidas) hasta que se resuelvan.
        if (!previous && (daysLeft < 0 || daysLeft > calendar.diasDeAnticipacion)) continue;

        let severity = severityFor(daysLeft, calendar.umbralesSeveridad);
        // La severidad solo sube (nunca se "calma" una alerta existente).
        if (previous && SEVERITY_RANK[previous.severity] > SEVERITY_RANK[severity]) severity = previous.severity;

        await alertsService.upsertActiveAlert({
          clientId: client.id,
          dedupeKey,
          alertType: "deadline",
          severity,
          dueDate: new Date(`${dueDate}T00:00:00Z`),
          message: buildMessage(taxYear, dueDate, daysLeft, digits, calendar.esEjemplo),
        });
        if (previous) result.updated++;
        else result.created++;
      }
    }
  }

  logger.info(result, "Revisión de vencimientos terminada");
  return result;
}
