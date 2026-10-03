# Demo de la Fase 5: identidad profesional y evolución visual

Pasos para probar cada bloque con tus propias manos. Rama
`feat/identidad-profesional` en los tres repositorios.

## B0: Preparación y auditoría

No agrega funciones visibles. Lo que se puede comprobar:

1. **Huella de la base de desarrollo** (solo lectura), desde Git Bash en
   `renta-ia-database`:

   ```bash
   ./scripts/fingerprint.sh > /tmp/huella.txt
   ```

   Muestra las migraciones aplicadas, las filas por tabla y el SHA-256 del
   esquema. Huella tomada al iniciar la fase: 16 migraciones (001–016),
   esquema `9cdedda8…f4b468`.

2. **Tests del backend independientes del `.env` local.** Con
   `AI_PROVIDER=mock` en `renta-ia-backend/.env` (configuración del stack E2E),
   antes fallaban 4 tests (`aiChat`, `ragIsolation`, `summary` ×2). Ahora:

   ```bash
   npm test
   ```

   Resultado esperado: `191 passed`.

3. **Auditoría del sistema de diseño:** `renta-ia-frontend/docs/design-tokens-audit.md`.
