import { z } from "zod";
import { prisma } from "../../config/prisma";
import { auditQuerySchema } from "./admin.schema";

type AuditQuery = z.infer<typeof auditQuerySchema>;

export const adminService = {
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
