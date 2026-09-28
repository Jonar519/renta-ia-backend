# 0004 — Cola de trabajos con BullMQ sobre Redis

**Estado:** aceptada.

## Contexto

Analizar un documento (extraer texto/OCR, conceptos con el LLM, embeddings)
tarda de segundos a minutos y depende de APIs externas que pueden fallar o
limitar. La subida no puede esperar todo eso, y un fallo de la IA no debe
perder el documento.

## Decisión

- La API guarda el archivo, crea el registro (`uploaded`) y **encola** un
  trabajo en BullMQ; un **proceso worker** separado lo procesa.
- Reintentos con backoff exponencial (`attempts: 2`), trabajos terminados con
  retención acotada (`removeOnComplete: 100`, `removeOnFail: 500`).
- **Diseño del pipeline:** la extracción de texto es la única etapa fatal; la
  extracción de conceptos y los embeddings **fallan por separado** y dejan el
  documento en `processed` con advertencias (se puede reprocesar).
- Concurrencia configurable (`WORKER_CONCURRENCY`) y apagado ordenado que espera
  los trabajos en curso.
- Redis con `maxmemory-policy noeviction` (explícito en `docker-compose.yml`).
- El worker avisa a la API por Redis pub/sub y la API al navegador por WebSocket.
- Tareas programadas (alertas de vencimiento diarias) con la misma infraestructura.

## Alternativas consideradas

- **Procesar en la misma solicitud HTTP:** timeouts, y un fallo del LLM perdería la subida.
- **`setImmediate`/cola en memoria:** se pierde todo si el proceso se reinicia.
- **SQS (AWS):** buena opción en producción; se descartó por ahora porque el
  despliegue en AWS queda para después y BullMQ corre igual en local y en CI.

## Consecuencias

- (+) La subida responde rápido (p50 ≈ 113–117 ms en las ráfagas medidas) y el
  trabajo pesado escala aparte: el drenaje de 100 documentos bajó de 68,6 s
  (concurrencia 1) a 9,3 s (concurrencia 8), con IA simulada
  (`docs/load-test-report.md`).
- (+) Un fallo parcial de la IA no bloquea el documento ni borra datos buenos.
- (−) Redis pasa a ser una dependencia crítica (por eso `/ready` lo verifica).
- (−) Si Redis se llena, rechaza escrituras (preferible a perder trabajos).

## Evidencia

`src/queues/documentQueue.ts`, `src/workers/processDocument.ts`,
`src/workers/documentProcessing.worker.ts`, `tests/integration/processDocument.test.ts`,
`docs/load-test-report.md`.
