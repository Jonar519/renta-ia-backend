import { describe, expect, it } from "vitest";
import bcrypt from "bcrypt";

/**
 * Se cambió bcryptjs (JavaScript puro, bloquea el event loop) por bcrypt
 * nativo (corre en el thread pool de libuv). Ver docs/load-test-report.md.
 * Las contraseñas ya guardadas deben seguir funcionando.
 */
describe("bcrypt nativo: compatibilidad con los hashes existentes", () => {
  it("verifica un hash $2a$ generado con bcryptjs (seed de renta-ia-database)", async () => {
    const seedHash = "$2a$10$xDx7brDnEU371AL7aF0tse7rBu4X.Or66jKV1hqpKFocp133QkF8u";
    await expect(bcrypt.compare("Password123!", seedHash)).resolves.toBe(true);
    await expect(bcrypt.compare("otra", seedHash)).resolves.toBe(false);
  });

  it("los hashes nuevos usan costo 10", async () => {
    expect(await bcrypt.hash("frase de prueba larga", 10)).toMatch(/^\$2b\$10\$/);
  });
});
