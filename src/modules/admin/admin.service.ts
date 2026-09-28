import bcrypt from "bcrypt";
import { z } from "zod";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { normalizeEmail } from "../auth/auth.service";
import { publicUser } from "../auth/sessions.service";
import { auditQuerySchema, createUserSchema } from "./admin.schema";

type CreateUserInput = z.infer<typeof createUserSchema>;
type AuditQuery = z.infer<typeof auditQuerySchema>;

export const adminService = {
  async createUser(input: CreateUserInput) {
    const email = normalizeEmail(input.email);
    if (await prisma.user.findUnique({ where: { email } })) {
      throw new ApiError(409, "Ya existe un usuario con ese correo");
    }

    if (input.role === "assistant") {
      const accountant = await prisma.user.findUnique({ where: { id: input.accountantUserId! } });
      if (accountant?.role !== "accountant") throw new ApiError(400, "accountantUserId no es un contador");
    } else {
      const client = await prisma.client.findUnique({ where: { id: input.clientId! } });
      if (!client) throw new ApiError(400, "El cliente no existe");
      if (client.portalUserId) throw new ApiError(409, "Ese cliente ya tiene un usuario de portal");
    }

    const passwordHash = await bcrypt.hash(input.password, 10);
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data: { name: input.name, email, passwordHash, role: input.role } });
      if (input.role === "assistant") {
        await tx.accountantAssistant.create({
          data: { assistantUserId: created.id, accountantUserId: input.accountantUserId! },
        });
      } else {
        await tx.client.update({ where: { id: input.clientId! }, data: { portalUserId: created.id } });
      }
      return created;
    });
    return publicUser(user);
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
