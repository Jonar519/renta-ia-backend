import { z } from "zod";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { auditQuerySchema, portalClientsQuerySchema } from "./admin.schema";

type AuditQuery = z.infer<typeof auditQuerySchema>;

export const PORTAL_SEARCH_LIMIT = 20;

export const adminService = {
  /**
   * Contadores activos: a quién puede quedar ligado un asistente invitado, y
   * entre quiénes se pueden reasignar clientes (con cuántos tiene cada uno).
   */
  async listAccountants() {
    const accountants = await prisma.user.findMany({
      where: { role: "accountant", status: "active" },
      select: { id: true, name: true, email: true, _count: { select: { clients: true } } },
      orderBy: { name: "asc" },
    });
    return accountants.map(({ _count, ...a }) => ({ ...a, clientCount: _count.clients }));
  },

  /**
   * Pasa TODOS los clientes de un contador a otro (con sus documentos,
   * alertas, conceptos y conversaciones, que cuelgan del cliente). Los
   * asistentes del contador anterior dejan de verlos. Así un contador puede
   * eliminar su cuenta (docs/data-retention.md). Si el destino ya tiene un
   * cliente con el mismo número de documento, no se mueve nada (409): la base
   * no admite dos expedientes del mismo documento para un contador.
   */
  async reassignClients(fromUserId: string, toUserId: string) {
    const accountants = await prisma.user.findMany({
      where: { id: { in: [fromUserId, toUserId] }, role: "accountant", status: "active" },
      select: { id: true },
    });
    if (accountants.length !== 2) throw new ApiError(400, "Los dos deben ser contadores con la cuenta activa.");
    return prisma
      .$transaction(async (tx) => {
        const moving = await tx.client.findMany({
          where: { accountantUserId: fromUserId },
          select: { documentNumber: true },
        });
        if (moving.length === 0) throw new ApiError(409, "Ese contador no tiene clientes para reasignar.");
        const clashes = await tx.client.findMany({
          where: { accountantUserId: toUserId, documentNumber: { in: moving.map((c) => c.documentNumber) } },
          select: { documentNumber: true },
          orderBy: { documentNumber: "asc" },
        });
        if (clashes.length > 0) {
          throw new ApiError(
            409,
            `El contador de destino ya tiene clientes con estos documentos: ${clashes.map((c) => c.documentNumber).join(", ")}. No se movió ninguno.`
          );
        }
        const { count } = await tx.client.updateMany({
          where: { accountantUserId: fromUserId },
          data: { accountantUserId: toUserId },
        });
        return { moved: count };
      })
      .catch((err: unknown) => {
        // Carrera: entre la revisión y el cambio, alguien creó un cliente con un
        // documento repetido (P2002) o una de las cuentas dejó de estar activa (P2003).
        const code = (err as { code?: string }).code;
        if (code === "P2002" || code === "P2003") {
          throw new ApiError(
            409,
            "Los clientes o las cuentas cambiaron mientras se reasignaba. No se movió ninguno; vuelve a intentarlo."
          );
        }
        throw err;
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
