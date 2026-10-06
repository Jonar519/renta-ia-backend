import { z } from "zod";
import { prisma } from "../../config/prisma";
import { auditQuerySchema, portalClientsQuerySchema } from "./admin.schema";

type AuditQuery = z.infer<typeof auditQuerySchema>;

export const PORTAL_SEARCH_LIMIT = 20;

export const adminService = {
  /** Contadores activos: a quién puede quedar ligado un asistente invitado. */
  listAccountants() {
    return prisma.user.findMany({
      where: { role: "accountant", status: "active" },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    });
  },

  /**
   * Expedientes SIN usuario de portal (a los que se puede invitar un
   * contribuyente), buscando por nombre o número de documento. Como mucho
   * PORTAL_SEARCH_LIMIT: puede haber miles de expedientes.
   */
  listPortalCandidates(query: z.infer<typeof portalClientsQuerySchema>) {
    const q = query.q;
    return prisma.client.findMany({
      where: {
        portalUserId: null,
        ...(q ? { OR: [{ fullName: { contains: q, mode: "insensitive" } }, { documentNumber: { contains: q } }] } : {}),
      },
      select: { id: true, fullName: true, documentNumber: true, accountant: { select: { name: true } } },
      orderBy: [{ fullName: "asc" }, { id: "asc" }],
      take: PORTAL_SEARCH_LIMIT,
    });
  },

  /** Registro de auditoría, del más reciente al más antiguo, paginado por id. */
  async listAudit(query: AuditQuery) {
    const rows = await prisma.auditLog.findMany({
      where: {
        userId: query.userId,
        action: query.action,
        entity: query.entity,
        entityId: query.entityId,
        ...(query.cursor ? { id: { lt: BigInt(query.cursor) } } : {}),
      },
      orderBy: { id: "desc" },
      take: query.limit + 1,
      include: { user: { select: { id: true, name: true, role: true } } },
    });
    const items = rows.slice(0, query.limit).map((row) => ({ ...row, id: row.id.toString() }));
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > query.limit && last ? last.id : null };
  },
};
