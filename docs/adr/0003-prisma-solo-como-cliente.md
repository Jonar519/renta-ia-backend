# 0003 — Prisma solo como cliente (no gestiona el esquema)

**Estado:** aceptada.

## Contexto

El esquema vive en `renta-ia-database` (ADR 0002). En el backend se quería
acceso tipado a los datos sin escribir SQL para cada consulta.

## Decisión

- **Prisma Client** para las consultas; `prisma/schema.prisma` se obtiene con
  **`npx prisma db pull`** después de cada migración, y se ajustan solo nombres
  de relaciones para que el código sea legible.
- **No se usa Prisma Migrate** (`prisma migrate` nunca se ejecuta).
- Lo que Prisma no modela se hace con SQL crudo **parametrizado**
  (`$queryRaw` con plantillas etiquetadas): la búsqueda vectorial de pgvector
  (`src/modules/ai/embeddings.repository.ts`).

## Alternativas consideradas

- **SQL a mano con `pg`:** control total, pero sin tipos y con mucho código repetido.
- **Knex / Kysely:** buenos constructores de consultas; Prisma se eligió por
  la generación de tipos desde el esquema real y su ergonomía en transacciones.

## Consecuencias

- (+) Tipos generados desde la base real: si una migración cambia una columna,
  `tsc` falla donde se usa.
- (+) Las consultas son parametrizadas (sin inyección SQL), incluidas las crudas.
- (−) `vector(1024)` queda como `Unsupported` y se maneja con SQL crudo.
- (−) En Windows, `prisma generate` falla si la DLL del motor está en uso (servidor
  de desarrollo corriendo): hay que detenerlo antes de regenerar.

## Evidencia

`renta-ia-backend/prisma/schema.prisma`, `src/config/prisma.ts`,
`src/modules/ai/embeddings.repository.ts`.
