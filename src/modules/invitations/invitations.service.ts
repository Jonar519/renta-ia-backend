import bcrypt from "bcrypt";
import { z } from "zod";
import type { Prisma, UserRole } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { mfaRequiredFor } from "../mfa/policy";
import { logger } from "../../config/logger";
import { ApiError } from "../../utils/apiError";
import { createSignedToken, verifySignedToken } from "../../utils/signedToken";
import { sendEmail } from "../../services/email";
import { normalizeEmail } from "../auth/auth.service";
import { passwordProblems } from "../auth/passwordPolicy";
import { sessionsService } from "../auth/sessions.service";
import type { SessionClient } from "../auth/sessionClient";
import { invitationEmail } from "./invitations.email";
import { inviteSchema } from "./invitations.schema";

/**
 * Alta de cuentas por invitación (ADR 0009 para las garantías del esquema).
 *
 *  1. El admin invita (nombre, correo, rol). Se crea la cuenta PENDIENTE
 *     (sin contraseña), su relación (asistente ↔ contador, portal ↔
 *     expediente) y una invitación con el HASH de un token firmado (72 h).
 *  2. El token en claro solo viaja en el correo. Ninguna respuesta al admin
 *     ni la auditoría lo incluyen.
 *  3. La persona abre el enlace, define su contraseña y la cuenta se activa
 *     en una transacción que consume la invitación (un solo uso).
 */

export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

// Mismo mensaje para token inexistente, alterado, vencido, reemplazado o ya
// usado: no se revela cuál de esos casos es.
export const INVALID_INVITATION =
  "El enlace de invitación no es válido o ya venció. Pide a tu administrador uno nuevo.";

type InviteInput = z.infer<typeof inviteSchema>;
interface Actor {
  userId: string;
}

const viewInclude = {
  invitations: { where: { revokedAt: null }, orderBy: { createdAt: "desc" }, take: 1 },
  assistsAccountants: { include: { accountant: { select: { id: true, name: true } } } },
  portalClients: { select: { id: true, fullName: true } },
} satisfies Prisma.UserInclude;

type InvitedUser = Prisma.UserGetPayload<{ include: typeof viewInclude }>;

/** Lo que ve el admin de una invitación: estado y vencimiento, NUNCA el token. */
function toView(user: InvitedUser, now = new Date()) {
  const open = user.invitations[0] ?? null;
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: open && open.expiresAt > now ? ("pending" as const) : ("expired" as const),
    invitedAt: open?.createdAt ?? user.createdAt,
    expiresAt: open?.expiresAt ?? null,
    accountant: user.assistsAccountants[0]?.accountant ?? null,
    client: user.portalClients[0] ?? null,
  };
}

export type InvitationView = ReturnType<typeof toView>;

async function loadView(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: viewInclude });
  return toView(user);
}

async function inviterName(actor: Actor) {
  const admin = await prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
  return admin?.name ?? "El equipo de Renta IA";
}

/** Crea la invitación (con un token nuevo) dentro de la transacción dada y devuelve el token. */
async function issueInvitation(tx: Prisma.TransactionClient, userId: string, actor: Actor) {
  const { token, hash } = createSignedToken("invitation");
  // created_at y expires_at desde el MISMO reloj: la base exige
  // expires_at <= created_at + 72 h (chk_user_invitations_expiry).
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + INVITATION_TTL_MS);
  await tx.userInvitation.create({
    data: { userId, tokenHash: hash, invitedById: actor.userId, createdAt, expiresAt },
  });
  return { token, expiresAt };
}

async function deliver(view: InvitationView, token: string, expiresAt: Date, actor: Actor) {
  try {
    await sendEmail(
      invitationEmail({
        to: view.email,
        name: view.name,
        role: view.role,
        invitedBy: await inviterName(actor),
        token,
        expiresAt,
      })
    );
  } catch (err) {
    logger.warn(
      { userId: view.userId, err: err instanceof Error ? err.message : err },
      "No se pudo enviar la invitación"
    );
    throw new ApiError(
      502,
      "La invitación quedó creada, pero no se pudo enviar el correo. Inténtalo de nuevo con Reenviar."
    );
  }
}

export const invitationsService = {
  async invite(input: InviteInput, actor: Actor): Promise<InvitationView> {
    const email = normalizeEmail(input.email);
    const existing = await prisma.user.findUnique({ where: { email }, select: { status: true } });
    if (existing?.status === "active") throw new ApiError(409, "Ya existe una cuenta activa con ese correo.");
    if (existing) throw new ApiError(409, "Ya hay una invitación pendiente para ese correo. Usa Reenviar.");

    if (input.role === "assistant") {
      const accountant = await prisma.user.findUnique({ where: { id: input.accountantUserId! } });
      // Una cuenta eliminada (B14) conserva el rol en su lápida: no sirve como contador.
      if (accountant?.role !== "accountant" || accountant.status === "deleted") {
        throw new ApiError(400, "accountantUserId no es un contador");
      }
    }
    if (input.role === "client") {
      const client = await prisma.client.findUnique({ where: { id: input.clientId! } });
      if (!client) throw new ApiError(400, "El cliente no existe");
      if (client.portalUserId) throw new ApiError(409, "Ese cliente ya tiene un usuario de portal");
    }

    const { userId, token, expiresAt } = await prisma.$transaction(async (tx) => {
      // Cuenta PENDIENTE: sin contraseña (la base lo exige con un CHECK).
      const user = await tx.user.create({
        data: { name: input.name, email, role: input.role as UserRole, status: "invited", passwordHash: null },
      });
      if (input.role === "assistant") {
        await tx.accountantAssistant.create({
          data: { assistantUserId: user.id, accountantUserId: input.accountantUserId! },
        });
      }
      if (input.role === "client") {
        await tx.client.update({ where: { id: input.clientId! }, data: { portalUserId: user.id } });
      }
      return { userId: user.id, ...(await issueInvitation(tx, user.id, actor)) };
    });

    const view = await loadView(userId);
    await deliver(view, token, expiresAt, actor);
    return view;
  },

  /** Cuentas pendientes con su invitación (estado y vencimiento), de la más reciente a la más antigua. */
  async list(): Promise<InvitationView[]> {
    const users = await prisma.user.findMany({
      where: { status: "invited" },
      include: viewInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
    });
    const now = new Date();
    return users.map((user) => toView(user, now));
  },

  /** Reenviar: invalida el enlace anterior (revoke 'resent') y manda uno nuevo de 72 h. */
  async resend(userId: string, actor: Actor): Promise<InvitationView> {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({ where: { id: userId, status: "invited" }, select: { id: true } });
      if (!user) return null;
      await tx.userInvitation.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: "resent" },
      });
      return issueInvitation(tx, userId, actor);
    });
    if (!result) throw new ApiError(404, "No hay una invitación pendiente para esa cuenta");
    const view = await loadView(userId);
    await deliver(view, result.token, result.expiresAt, actor);
    return view;
  },

  /**
   * Cancelar: elimina la cuenta PENDIENTE (nunca una activa: la condición
   * status = 'invited' va en el mismo DELETE). Así el correo queda libre para
   * invitar de nuevo (p. ej. si estaba mal escrito) y se borran su invitación
   * y su relación con el contador o el expediente.
   */
  async cancel(userId: string): Promise<void> {
    const { count } = await prisma.user.deleteMany({ where: { id: userId, status: "invited" } });
    if (count === 0) throw new ApiError(404, "No hay una invitación pendiente para esa cuenta");
  },

  /** Pantalla "Completa tu cuenta": a quién corresponde un enlace válido. */
  async lookup(token: string) {
    const invitation = await findOpenInvitation(token);
    const { user } = invitation;
    return {
      name: user.name,
      email: user.email,
      role: user.role,
      expiresAt: invitation.expiresAt,
      // Roles que deben activar MFA al completar su cuenta (mfa/policy.ts).
      mfaRequired: mfaRequiredFor(user.role),
    };
  },

  /** Activa la cuenta: contraseña propia + invitación consumida, en una transacción. Inicia sesión. */
  async accept(token: string, password: string, client: SessionClient) {
    const invitation = await findOpenInvitation(token);
    const { user } = invitation;
    const problems = passwordProblems(password, { email: user.email, name: user.name });
    if (problems.length) {
      throw new ApiError(
        400,
        "Datos inválidos",
        problems.map((message) => ({ field: "body.password", message }))
      );
    }
    const passwordHash = await bcrypt.hash(password, 10);

    const activated = await prisma.$transaction(async (tx) => {
      // Un solo uso: solo gana quien borra la invitación todavía abierta.
      const { count } = await tx.userInvitation.deleteMany({
        where: { id: invitation.id, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      if (count === 0) return null;
      // La base no deja activar una cuenta con invitaciones: se borran las demás (revocadas).
      await tx.userInvitation.deleteMany({ where: { userId: user.id } });
      const { count: updated } = await tx.user.updateMany({
        where: { id: user.id, status: "invited" },
        data: { status: "active", passwordHash },
      });
      return updated === 1 ? tx.user.findUniqueOrThrow({ where: { id: user.id } }) : null;
    });
    if (!activated) throw new InvalidInvitationError();
    return sessionsService.start(activated, client);
  },
};

/** Invitación abierta y vigente para el token, o 410 genérico. */
async function findOpenInvitation(token: string) {
  const hash = verifySignedToken(token, "invitation");
  const invitation = hash
    ? await prisma.userInvitation.findFirst({
        where: { tokenHash: hash, revokedAt: null, expiresAt: { gt: new Date() } },
        include: { user: true },
      })
    : null;
  if (!invitation || invitation.user.status !== "invited") throw new InvalidInvitationError();
  return invitation;
}

export class InvalidInvitationError extends ApiError {
  constructor() {
    super(410, INVALID_INVITATION);
  }
}
