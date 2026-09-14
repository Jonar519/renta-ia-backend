import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";

interface CreateClientInput {
  accountantUserId: string;
  fullName: string;
  documentNumber: string;
  email?: string;
  phone?: string;
}

type UpdateClientInput = Partial<Omit<CreateClientInput, "accountantUserId">>;

export const clientsService = {
  async create(input: CreateClientInput) {
    return prisma.client.create({ data: input });
  },

  async listByAccountant(accountantUserId: string) {
    return prisma.client.findMany({
      where: { accountantUserId },
      orderBy: { createdAt: "desc" },
    });
  },

  async getById(id: string) {
    const client = await prisma.client.findUnique({ where: { id } });
    if (!client) {
      throw new ApiError(404, "Cliente no encontrado");
    }
    return client;
  },

  async update(id: string, data: UpdateClientInput) {
    await clientsService.getById(id);
    return prisma.client.update({ where: { id }, data });
  },

  async remove(id: string) {
    await clientsService.getById(id);
    await prisma.client.delete({ where: { id } });
  },
};
