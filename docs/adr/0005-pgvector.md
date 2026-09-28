# 0005 — Búsqueda semántica con pgvector dentro de PostgreSQL

**Estado:** aceptada.

## Contexto

El chat responde preguntas sobre los documentos de **un** cliente (RAG). Hace
falta guardar embeddings (Voyage `voyage-2`, 1024 dimensiones) y buscar los
fragmentos más parecidos a la pregunta, **sin mezclar clientes**.

## Decisión

- Extensión **pgvector** en la misma base: tabla `document_embeddings` con
  columna `vector(1024)`, búsqueda por distancia coseno (`<=>`).
- El filtro por cliente va **en la misma consulta SQL** (`JOIN documents …
WHERE d.client_id = $1`), antes del `ORDER BY` por distancia.
- Índice **HNSW** (`vector_cosine_ops`) para cuando el volumen lo justifique.
- Reprocesar un documento reemplaza sus embeddings en una transacción.

## Alternativas consideradas

- **Base vectorial dedicada (Pinecone, Qdrant, Weaviate):** otro servicio que
  operar y pagar, y el aislamiento por cliente dependería de filtros de metadatos
  en otro sistema, separados de la autorización de la base principal.
- **Embeddings en JSON y similitud en Node:** no escala y trae todos los
  vectores a memoria.

## Consecuencias

- (+) Una sola base, transacciones y backups comunes; el aislamiento por cliente
  es una cláusula `WHERE` probada: `tests/integration/ragIsolation.test.ts` pone
  los fragmentos de otro cliente a distancia 0 y aun así no se recuperan.
- (−) Con el volumen actual (609 fragmentos en la base E2E, pgvector 0.8.6) el
  planificador **no usa** el índice HNSW: filtra por cliente con
  `idx_documents_client` y ordena exacto (verificado con `EXPLAIN` el 2026-09-28).
  Con muchos más fragmentos podría elegir HNSW y filtrar **después**, devolviendo
  menos de 5 fragmentos del cliente (peor recall, nunca fragmentos ajenos). No
  medido; si ocurre, activar `hnsw.iterative_scan` (pgvector ≥ 0.8) o particionar por cliente.
- (−) El costo de la búsqueda con muchos fragmentos **no se midió** (`docs/load-test-report.md`).
- (−) Prisma no modela `vector` (SQL crudo, ADR 0003).

## Evidencia

`renta-ia-database/migrations/007_document_embeddings.sql`,
`src/modules/ai/embeddings.repository.ts`, `src/modules/ai/rag.service.ts`,
`tests/integration/ragIsolation.test.ts`.
