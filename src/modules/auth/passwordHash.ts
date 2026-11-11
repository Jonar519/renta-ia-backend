import bcrypt from "bcrypt";

/**
 * Único lugar donde se decide CÓMO se guarda una contraseña: bcrypt nativo
 * con costo 10 (docs/load-test-report.md). Lo usan la activación por
 * invitación, la recuperación, el cambio de contraseña y el alta del primer
 * admin (npm run admin:crear); el login compara con bcrypt.compare, que lee
 * el algoritmo y el costo del propio hash.
 *
 * Sin dependencias de la configuración (env, prisma): el script de alta lo
 * usa con solo DATABASE_URL definida.
 */
export const PASSWORD_HASH_COST = 10;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, PASSWORD_HASH_COST);
}

export function hashPasswordSync(password: string): string {
  return bcrypt.hashSync(password, PASSWORD_HASH_COST);
}
