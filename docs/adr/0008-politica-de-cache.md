# 0008 — Política de caché

**Estado:** aceptada. Detalle completo: `renta-ia-frontend/docs/cache-policy.md`.

## Contexto

La app maneja datos tributarios y personales. Se quería arranque rápido,
funcionamiento básico sin conexión y actualizaciones que lleguen sin que el
usuario quede atrapado en una versión vieja, sin que datos sensibles terminen
en cachés compartidas o en disco más de lo necesario.

## Decisión

- **API:** `Cache-Control: no-store` en **todas** las respuestas; el Service
  Worker **no intercepta** `/api/`.
- **Assets con hash** (`/assets/*`): inmutables, cache-first en el Service Worker.
- **Shell (`index.html`):** stale-while-revalidate con aviso "hay una versión
  nueva" (el usuario decide cuándo recargar; no hay `skipWaiting` automático).
- **Cachés versionadas** por build y borrado de las viejas; página offline propia.
- **Offline de solo lectura:** copia en IndexedDB, **por usuario**, con TTL de
  24 h, solo de listados sin montos (clientes, detalle básico, documentos);
  se borra al cerrar sesión o al cambiar de usuario. Sin conexión, las
  escrituras se bloquean (no se encolan).
- **Sesión:** el access token nunca se guarda (ADR 0007).

## Alternativas consideradas

- **Cachear respuestas de la API en el Service Worker:** más offline, pero datos
  sensibles en Cache Storage sin separación por usuario ni caducidad.
- **Cola de escrituras offline (Background Sync):** riesgo de conflictos y de
  enviar cambios viejos; se prefirió ser explícito: sin red no se escribe.

## Consecuencias

- (+) Verificado con Playwright en modo offline: shell desde el Service Worker,
  datos desde IndexedDB, escrituras bloqueadas, `Cache Storage` sin nada de `/api`.
- (−) Sin conexión no se ven montos, resúmenes, alertas ni chat.
- (−) Riesgo residual: con acceso físico al equipo y la sesión abierta, los
  listados guardados son legibles (24 h máx.).

## Evidencia

Backend `src/app.ts` (`no-store`), `tests/integration/cachePolicy.test.ts`;
frontend `src/sw/service-worker.js`, `src/offline/offlineStore.js`,
`tests/serviceWorker.test.js`, `tests/offline.test.js`.
