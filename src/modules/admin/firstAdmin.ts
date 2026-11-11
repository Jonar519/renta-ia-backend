import type { AccountStatus, Prisma, UserRole } from "@prisma/client";
import type { AuditAction } from "../../services/audit/audit.service";
import { normalizeEmail } from "../auth/normalizeEmail";
import { hashPassword } from "../auth/passwordHash";
import { passwordProblems } from "../auth/passwordPolicy";
import { inviteSchema } from "../invitations/invitations.schema";

/**
 * Alta del PRIMER administrador (npm run admin:crear, src/scripts/crearAdmin.ts).
 *
 * Es la única cuenta que no nace por invitación: alguien tiene que poder
 * invitar a la primera. Las reglas son las de una cuenta invitada que se
 * activa, sin el correo de por medio:
 *  - Misma validación de nombre y correo que la invitación, misma política
 *    de contraseñas (contra su nombre y correo) y mismo hash que el login.
 *  - Queda "active": en Renta no hay columna de correo verificado; una
 *    cuenta activa es una cuyo correo se dio por comprobado (la invitación
 *    lo prueba con el enlace; aquí, quien tiene acceso a la base).
 *  - Sin MFA: es obligatorio para admin (mfa/policy.ts), así que la API solo
 *    la deja configurarlo en su primer inicio de sesión.
 *
 * Idempotente y solo para el primero: si el correo ya existe no toca nada
 * (ni rol ni contraseña); si ya hay un admin activo tampoco crea otro (los
 * demás se invitan desde el panel, con auditoría del admin que invita).
 *
 * Sin dependencias de la configuración de la API: recibe el cliente de
 * Prisma (una transacción) de quien lo llama.
 */

/** Clave del candado de la base: dos corridas a la vez no crean dos admins. */
export const FIRST_ADMIN_LOCK = "renta-ia:admin:crear";

export const FIRST_ADMIN_AUDIT_ACTION: AuditAction = "admin.first_admin.create";

const inputSchema = inviteSchema.innerType().pick({ name: true, email: true });

export type FirstAdminInput = { name: string; email: string };

export type FirstAdminState =
  | { kind: "ready" }
  | { kind: "email_exists"; role: UserRole; status: AccountStatus }
  | { kind: "admin_exists"; count: number };

export type FirstAdminResult = Exclude<FirstAdminState, { kind: "ready" }> | { kind: "created"; userId: string };

export class FirstAdminInputError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
  }
}

/** Nombre y correo validados como en la invitación; el correo, normalizado. */
export function parseFirstAdminInput(raw: { name?: string; email?: string }): FirstAdminInput {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FirstAdminInputError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  return { name: parsed.data.name, email: normalizeEmail(parsed.data.email) };
}

/** Problemas de la contraseña según la política del registro normal (vacío = sirve). */
export function firstAdminPasswordProblems(input: FirstAdminInput, password: string): string[] {
  return passwordProblems(password, { email: input.email, name: input.name });
}

/** ¿Se puede crear? Solo lee. */
export async function firstAdminState(db: Prisma.TransactionClient, email: string): Promise<FirstAdminState> {
  const existing = await db.user.findUnique({ where: { email }, select: { role: true, status: true } });
  if (existing) return { kind: "email_exists", role: existing.role, status: existing.status };
  const count = await db.user.count({ where: { role: "admin", status: "active" } });
  if (count > 0) return { kind: "admin_exists", count };
  return { kind: "ready" };
}

/**
 * Crea el admin dentro de la transacción `tx`, con el candado tomado y
 * volviendo a comprobar el estado (pudo cambiar mientras se pedía la
 * contraseña). Lanza FirstAdminInputError si la contraseña no cumple la política.
 */
export async function createFirstAdmin(
  tx: Prisma.TransactionClient,
  input: FirstAdminInput,
  password: string
): Promise<FirstAdminResult> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FIRST_ADMIN_LOCK}))`;
  const state = await firstAdminState(tx, input.email);
  if (state.kind !== "ready") return state;

  const problems = firstAdminPasswordProblems(input, password);
  if (problems.length) throw new FirstAdminInputError(problems);

  const user = await tx.user.create({
    data: {
      name: input.name,
      email: input.email,
      role: "admin",
      status: "active",
      passwordHash: await hashPassword(password),
    },
    select: { id: true },
  });
  await tx.auditLog.create({
    data: {
      action: FIRST_ADMIN_AUDIT_ACTION,
      userId: user.id,
      entity: "user",
      entityId: user.id,
      userAgent: "cli: npm run admin:crear",
    },
  });
  return { kind: "created", userId: user.id };
}
