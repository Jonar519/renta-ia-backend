import { prisma } from "../../config/prisma";
import { AuthPayload } from "../../middlewares/auth.middleware";
import { assertClientAccess, clientScope } from "../../middlewares/ownership.middleware";
import { afterCursor, PageParams, toPage } from "../../utils/pagination";
import { Prisma } from "@prisma/client";
import { logger } from "../../config/logger";
import { ApiError } from "../../utils/apiError";
import { rulesService } from "../ai/rules.service";

/** Lo que la UI muestra de cada concepto, con su revisión (B16). */
const conceptSelect = {
  id: true,
  conceptType: true,
  description: true,
  amount: true,
  aiAmount: true,
  source: true,
  periodYear: true,
  reviewedAt: true,
  reviewer: { select: { name: true } },
} satisfies Prisma.TaxConceptSelect;

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

  /**
   * Clientes visibles para el usuario (mismo criterio que clientScope): el
   * contador ve los suyos; el admin ve todos, con el nombre del contador
   * responsable para poder distinguirlos.
   */
  async list(user: AuthPayload, { limit, cursor }: PageParams) {
    const rows = await prisma.client.findMany({
      where: { ...clientScope(user), ...afterCursor("createdAt", cursor) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: user.role === "admin" ? { accountant: { select: { id: true, name: true } } } : undefined,
    });
    return toPage(rows, limit, (c) => c.createdAt);
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
    // Solo los campos que muestra la UI: con miles de conceptos, cada campo
    // de más son decenas de KB de JSON.
    return prisma.taxConcept.findMany({
      where: { clientId: id },
      orderBy: [{ periodYear: "desc" }, { createdAt: "desc" }],
      select: conceptSelect,
    });
  },

  /**
   * Revisar un concepto (B16): la persona confirma el monto de la IA o lo
   * corrige. Queda quién y cuándo; el valor de la IA no se toca. Ownership: el
   * concepto debe ser de ESTE cliente y el cliente estar al alcance del
   * usuario (si no, 404). El portal (solo lectura) no llega aquí (403 en la ruta).
   */
  async reviewConcept(clientId: string, conceptId: string, amount: number, user: AuthPayload) {
    await assertClientAccess(clientId, user);
    const concept = await prisma.taxConcept.findFirst({ where: { id: conceptId, clientId } });
    if (!concept) throw new ApiError(404, "Concepto no encontrado");
    const value = new Prisma.Decimal(amount.toFixed(2));
    const updated = await prisma.taxConcept.update({
      where: { id: conceptId },
      data: {
        amount: value,
        source: value.equals(concept.aiAmount) ? "ai" : "person",
        reviewedAt: new Date(),
        reviewedBy: user.userId,
      },
      select: conceptSelect,
    });
    // Las alertas dependen de los montos: se vuelven a evaluar con el revisado.
    await rulesService
      .evaluateClientConcepts(clientId, concept.documentId)
      .catch((err: unknown) =>
        logger.warn({ err: err instanceof Error ? err.message : err }, "No se pudieron reevaluar las alertas")
      );
    return updated;
  },
};
