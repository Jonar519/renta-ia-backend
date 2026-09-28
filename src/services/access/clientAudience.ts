import { prisma } from "../../config/prisma";

/**
 * Usuarios (no admin) que pueden ver un cliente: su contador, los asistentes
 * de ese contador y el usuario del portal del propio cliente. Debe coincidir
 * con clientScope (middlewares/ownership.middleware.ts). Se usa para decidir
 * a quién se envían las notificaciones en tiempo real.
 */
export async function clientAudience(clientId: string): Promise<string[]> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      accountantUserId: true,
      portalUserId: true,
      accountant: { select: { assistants: { select: { assistantUserId: true } } } },
    },
  });
  if (!client) return [];
  const ids = [client.accountantUserId, ...client.accountant.assistants.map((a) => a.assistantUserId)];
  if (client.portalUserId) ids.push(client.portalUserId);
  return [...new Set(ids)];
}
