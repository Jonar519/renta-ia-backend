# 0002 — Base de datos en un repositorio aparte, con migraciones SQL

**Estado:** aceptada.

## Contexto

El esquema lo usan dos procesos (API y worker) y lo tocarán otras herramientas
(scripts de datos, reportes). Se quería que el esquema fuera explícito,
revisable como SQL y aplicable igual en local (cmd.exe), en CI y en RDS.

## Decisión

- Repositorio **`renta-ia-database`**: única fuente de verdad del esquema.
- **Migraciones SQL numeradas** (`migrations/0NN_descripcion.sql`) que **nunca
  se editan** después de aplicarse en un entorno compartido; todo cambio es una
  migración nueva.
- Scripts `migrate.bat` / `migrate.sh` con historial en `schema_migrations`;
  cada migración y su registro corren en **una transacción**.
- El CI del backend hace checkout de este repo (rama `main` por defecto) y crea
  la base de pruebas con sus migraciones.

## Alternativas consideradas

- **Prisma Migrate en el backend:** cómodo, pero el SQL queda generado y
  acoplado al ORM; extensiones y objetos que Prisma no modela (pgvector,
  índices parciales, CHECK, triggers) terminan en SQL a mano igualmente.
- **Esquema dentro del repo del backend:** más simple, pero mezcla el ciclo de
  vida del esquema con el de un solo consumidor.

## Consecuencias

- (+) El esquema se revisa como SQL; se usan libremente pgvector, índices
  parciales (`uq_alerts_active_dedupe`, `uq_documents_client_sha256`), CHECK y triggers.
- (+) El CI de la base verifica que las migraciones se apliquen desde cero, sean
  idempotentes al re-ejecutarse y el seed también.
- (−) **Orden de merge obligatorio:** primero `renta-ia-database`, luego el
  backend (su CI lee las migraciones de `main`).
- (−) Dos pasos en cada cambio de esquema: migración aquí + `npx prisma db pull`
  en el backend (ADR 0003).

## Evidencia

`renta-ia-database/migrations/`, `scripts/migrate.bat`, `.github/workflows/ci.yml`
de ambos repos, `renta-ia-backend/tests/globalSetup.ts`.
