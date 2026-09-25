import { prisma } from "../../config/prisma";
import { AuthPayload } from "../../middlewares/auth.middleware";
import { assertClientAccess } from "../../middlewares/ownership.middleware";

interface CreateClientInput {
  accountantUserId: string;
  fullName: string;
  documentNumber: string;
  email?: string;
  phone?: string;
}

export interface UpdateClientInput {
  fullName?: string;
  documentNumber?: string;
  email?: string | null;
  phone?: string | null;
}

// Whitelist explícita: nunca se pasa el body tal cual a Prisma (evita, por
// ejemplo, que alguien reasigne accountantUserId desde un PATCH).
const UPDATABLE_FIELDS = ["fullName", "documentNumber", "email", "phone"] as const;

function pickUpdatableFields(data: Record<string, unknown>): UpdateClientInput {
  const result: Record<string, unknown> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (data[field] !== undefined) result[field] = data[field];
  }
  return result as UpdateClientInput;
}

export const clientsService = {
  async create(input: CreateClientInput) {
    return prisma.client.create({
      data: {
        accountantUserId: input.accountantUserId,
        fullName: input.fullName,
        documentNumber: input.documentNumber,
        email: input.email,
        phone: input.phone,
      },
    });
  },

  async listByAccountant(accountantUserId: string) {
    return prisma.client.findMany({
      where: { accountantUserId },
      orderBy: { createdAt: "desc" },
    });
  },

  async getById(id: string, user: AuthPayload) {
    return assertClientAccess(id, user);
  },

  async update(id: string, data: Record<string, unknown>, user: AuthPayload) {
    await assertClientAccess(id, user);
    return prisma.client.update({ where: { id }, data: pickUpdatableFields(data) });
  },

  async remove(id: string, user: AuthPayload) {
    await assertClientAccess(id, user);
    await prisma.client.delete({ where: { id } });
  },

  async listTaxConcepts(id: string, user: AuthPayload) {
    await assertClientAccess(id, user);
    return prisma.taxConcept.findMany({
      where: { clientId: id },
      orderBy: [{ periodYear: "desc" }, { createdAt: "desc" }],
    });
  },
};
