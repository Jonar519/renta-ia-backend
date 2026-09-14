import { prisma } from "../../config/prisma";

export const alertsService = {
  async listByClient(clientId: string) {
    return prisma.alert.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
    });
  },
};
