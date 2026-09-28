import { AlertSeverity, AlertStatus, AlertType, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { isUuid } from "../../utils/uuid";
import { AuthPayload } from "../../middlewares/auth.middleware";
import { clientScope } from "../../middlewares/ownership.middleware";
import { afterCursor, PageParams, toPage } from "../../utils/pagination";

export interface ActiveAlertInput {
  clientId: string;
  /** Qué situación describe la alerta (ver migración 011_alert_dedupe.sql). */
  dedupeKey: string;
  alertType: AlertType;
  severity: AlertSeverity;
  message: string;
  documentId?: string | null;
  dueDate?: Date | null;
}

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * Crea la alerta, o actualiza la que ya está activa (no resuelta) para la
 * misma (cliente, dedupeKey). Seguro ante carreras: si dos jobs intentan
 * crearla a la vez, el índice único parcial uq_alerts_active_dedupe rechaza
 * al segundo (P2002) y este actualiza la que creó el primero.
 */
async function upsertActiveAlert(input: ActiveAlertInput) {
  const { clientId, dedupeKey, ...fields } = input;
  const findActive = () =>
    prisma.alert.findFirst({ where: { clientId, dedupeKey, status: { not: AlertStatus.resolved } } });

  const existing = await findActive();
  if (existing) {
    return prisma.alert.update({ where: { id: existing.id }, data: fields });
  }
  try {
    return await prisma.alert.create({ data: { clientId, dedupeKey, status: AlertStatus.open, ...fields } });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await findActive();
    if (!winner) throw err;
    return prisma.alert.update({ where: { id: winner.id }, data: fields });
  }
}

// Transiciones permitidas: una alerta resuelta ya no se modifica.
const ALLOWED_TRANSITIONS: Record<AlertStatus, AlertStatus[]> = {
  open: ["acknowledged", "resolved"],
  acknowledged: ["resolved"],
  resolved: [],
};

export const alertsService = {
  upsertActiveAlert,

  async listByClient(clientId: string, { limit, cursor }: PageParams) {
    const rows = await prisma.alert.findMany({
      where: { clientId, ...afterCursor("createdAt", cursor) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    return toPage(rows, limit, (a) => a.createdAt);
  },

  /** Cambia el estado de una alerta del usuario (404 si no existe o no es suya). */
  async updateStatus(alertId: string, status: "acknowledged" | "resolved", user: AuthPayload) {
    const alert = isUuid(alertId)
      ? await prisma.alert.findFirst({ where: { id: alertId, client: clientScope(user) } })
      : null;
    if (!alert) {
      throw new ApiError(404, "Alerta no encontrada");
    }
    if (alert.status === status) {
      return alert;
    }
    if (!ALLOWED_TRANSITIONS[alert.status].includes(status)) {
      throw new ApiError(409, `No se puede pasar una alerta de "${alert.status}" a "${status}"`);
    }
    return prisma.alert.update({
      where: { id: alert.id },
      data: { status, resolvedAt: status === "resolved" ? new Date() : null },
    });
  },
};
