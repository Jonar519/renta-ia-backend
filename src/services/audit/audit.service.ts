import type { Request } from "express";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";

/**
 * Registro de auditoría (tabla audit_log): quién hizo qué, sobre qué y cuándo.
 *
 * Nunca se registran datos sensibles: ni contraseñas, ni tokens, ni el
 * correo de un login fallido, ni montos, ni contenido de documentos, ni el
 * texto de las preguntas al chat. Solo la acción, la entidad y su id.
 *
 * "Fire-and-forget": auditar nunca retrasa ni hace fallar la operación
 * auditada; un error al escribir el registro se loguea como advertencia.
 */

export type AuditAction =
  | "auth.register"
  | "auth.login.success"
  | "auth.login.failure"
  | "auth.login.locked"
  | "auth.logout"
  | "auth.refresh.reuse_detected"
  | "client.create"
  | "client.view"
  | "client.update"
  | "client.delete"
  | "document.list"
  | "document.view"
  | "document.upload"
  | "document.reprocess"
  | "ai.chat"
  | "ai.summary"
  | "admin.user.create"
  | "admin.audit.view";

export interface AuditEntry {
  action: AuditAction;
  userId?: string | null;
  entity?: "user" | "client" | "document" | "session" | "audit";
  entityId?: string | null;
}

const pending = new Set<Promise<unknown>>();

export function audit(req: Request | null, entry: AuditEntry): void {
  const write = prisma.auditLog
    .create({
      data: {
        action: entry.action,
        userId: entry.userId ?? req?.user?.userId ?? null,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        ip: req?.ip?.slice(0, 45) ?? null,
        userAgent: req?.get("user-agent")?.slice(0, 200) ?? null,
      },
    })
    .catch((err: unknown) =>
      logger.warn(
        { action: entry.action, err: err instanceof Error ? err.message : err },
        "No se pudo escribir la auditoría"
      )
    )
    .finally(() => pending.delete(write));
  pending.add(write);
}

/** Espera a que se escriban los registros pendientes (tests y apagado ordenado). */
export async function flushAudit(): Promise<void> {
  await Promise.all([...pending]);
}
