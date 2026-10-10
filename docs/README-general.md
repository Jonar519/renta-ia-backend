# Renta IA: Sistema de Gestión Documental Contable con IA

> **Copia del README general.** El original está en la carpeta raíz que contiene los tres
> repositorios, y esa carpeta no es un repositorio git. Esta copia viaja con el código: si cambias
> uno, cambia el otro. Los enlaces están ajustados a esta ubicación (`renta-ia-backend/docs/`).

Los contadores suben documentos de sus clientes (certificados de ingresos, extractos,
facturas…). Un pipeline con OCR + LLM (Anthropic) extrae las cifras tributarias, un
motor de reglas genera alertas y un chat con RAG (embeddings de Voyage AI en pgvector)
responde preguntas sobre cada cliente. Lo que extrae la IA queda marcado hasta que una persona lo
revisa con el documento original al lado.

**Para recorrer toda la plataforma paso a paso, con el rol de cada paso:**
[`renta-ia-backend/docs/demo-fase5.md`](../docs/demo-fase5.md) (guía única de prueba).

El proyecto son **tres repositorios hermanos**, uno junto al otro en la misma carpeta
(esta carpeta raíz **no** es un repositorio git):

```
renta-ia/                     ← esta carpeta (este README)
├── renta-ia-database/        # Esquema SQL, migraciones, seed, Postgres + pgvector (Docker)
├── renta-ia-backend/         # API REST + worker de IA (Node.js, TypeScript, Express, Prisma, BullMQ)
└── renta-ia-frontend/        # SPA en JavaScript sin framework (Vite)
```

> Los tests del backend leen las migraciones de `../renta-ia-database/migrations`:
> la estructura de carpetas importa.

## Puertos

| Servicio                                                             | Puerto                              | Definido en                            |
| -------------------------------------------------------------------- | ----------------------------------- | -------------------------------------- |
| PostgreSQL 16 + pgvector                                             | **5433** (→ 5432 en el contenedor)  | `renta-ia-database/docker-compose.yml` |
| Redis 7 (`noeviction`)                                               | **6379**                            | `renta-ia-backend/docker-compose.yml`  |
| API REST + WebSocket `/ws` + `/docs` + `/health` `/ready` `/metrics` | **4000**                            | `renta-ia-backend/.env` (`PORT`)       |
| Métricas del worker                                                  | **9464** (solo con `METRICS_TOKEN`) | `WORKER_METRICS_PORT`                  |
| Frontend (Vite dev)                                                  | **5173**                            | `renta-ia-frontend/vite.config.js`     |
| Frontend (build + `vite preview`, con Service Worker y CSP)          | **4173**                            | `npm run preview`                      |

## Requisitos

- **Docker Desktop** (Postgres y Redis corren en contenedores)
- **Node.js 20** o superior
- API keys de **Anthropic** y **Voyage AI** (opcionales para arrancar: sin ellas
  funciona todo excepto el análisis con IA, el resumen y el chat)

## Primera vez (Windows, `cmd.exe`)

```bat
:: Base de datos
cd renta-ia-database
docker compose up -d
scripts\migrate.bat
scripts\seed.bat
cd ..

:: Backend
cd renta-ia-backend
docker compose up -d
npm install
copy .env.example .env
npx prisma generate
cd ..

:: Frontend
cd renta-ia-frontend
npm install
copy .env.example .env
cd ..
```

Edita `renta-ia-backend\.env`: `JWT_SECRET` largo y aleatorio, y las API keys si las tienes.

> **Si ya tenías un `.env` de antes:** cambia `JWT_EXPIRES_IN=1d` por `JWT_EXPIRES_IN=15m`
> (esquema de sesión nuevo: access token corto + refresh rotativo en cookie).

## Día a día: orden de arranque

Cada proceso de Node en su propia ventana de cmd. **Respeta el orden.**

| #   | Qué                    | Dónde               | Comando                | Listo cuando ves                                                     |
| --- | ---------------------- | ------------------- | ---------------------- | -------------------------------------------------------------------- |
| 1   | Postgres               | `renta-ia-database` | `docker compose up -d` | `renta_ia_postgres … (healthy)` en `docker ps`                       |
| 2   | Redis                  | `renta-ia-backend`  | `docker compose up -d` | `renta_ia_redis … (healthy)`                                         |
| 3   | Migraciones pendientes | `renta-ia-database` | `scripts\migrate.bat`  | `Listo: N migración(es) nueva(s) aplicada(s).`                       |
| 4   | API                    | `renta-ia-backend`  | `npm run dev`          | `Servidor escuchando en http://localhost:4000`                       |
| 5   | Worker de IA           | `renta-ia-backend`  | `npm run worker`       | `Worker … escuchando la cola 'document-processing' (concurrencia 2)` |
| 6   | Frontend               | `renta-ia-frontend` | `npm run dev`          | `Local: http://localhost:5173/`                                      |

Para detener la API o el worker usa **Ctrl+C**: hacen un apagado ordenado (el worker
termina los documentos que está procesando).

Usuarios del seed (contraseña `Password123!`):

| Correo              | Rol                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ana@example.com`   | contador (2 clientes de ejemplo)                                                                                                            |
| `luis@example.com`  | asistente de Ana (ve y edita sus clientes; no crea ni borra)                                                                                |
| `admin@example.com` | admin (usuarios e invitaciones, reasignar clientes, auditoría, rendimiento). En su primer ingreso debe activar la verificación en dos pasos |

Las demás cuentas (otro contador, un contribuyente) se crean **por invitación**: no hay registro
público. La guía de prueba explica cómo.

Comprobación rápida:

```bat
curl http://localhost:4000/health
curl http://localhost:4000/ready
```

## Variables de entorno

Backend (detalle en `renta-ia-backend/README.md`):

- **`MFA_ENCRYPTION_KEY`**: 32 bytes en base64; obligatoria en producción, donde va al gestor de
  secretos con respaldo. En local, sin ella solo la verificación en dos pasos responde 503.
- `JWT_EXPIRES_IN` (15m), `REFRESH_TOKEN_TTL_DAYS`, `COOKIE_SECURE`, `APP_URL` (base de los
  enlaces de los correos).
- Proveedores externos, simulados por defecto: `EMAIL_PROVIDER` (`mock`/`ses`, con `EMAIL_FROM` y
  `SES_REGION`) y `GEOIP_PROVIDER` (`mock`/`dbip`, con `GEOIP_DBIP_CSV`).
- Operación: `METRICS_TOKEN`, `WORKER_METRICS_PORT`, `WORKER_CONCURRENCY`, `SHUTDOWN_TIMEOUT_MS`,
  `SHUTDOWN_DRAIN_DELAY_MS`.
- Solo pruebas, prohibidas con `NODE_ENV=production`: `AI_PROVIDER=mock`, `AI_MOCK_LATENCY_MS`,
  `RATE_LIMIT_SCALE` y `EMAIL_PROVIDER=mock`.

Frontend: `VITE_API_URL` (también fija la CSP del build).

## Tests, pruebas de carga y E2E

| Repo                | Comandos                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `renta-ia-backend`  | `npm test` · `npm run lint` · `npm run typecheck` · `npm run build` · `npm run openapi`     |
| `renta-ia-frontend` | `npm test` · `npm run lint` · `npm run build` · `npm run test:e2e` · `npm run perf:measure` |
| `renta-ia-database` | `scripts\migrate.bat` (dos veces: la segunda no aplica nada)                                |
| Carga               | `renta-ia-backend/loadtests/README.md` (`npm run loadtest:*`)                               |
| E2E                 | `renta-ia-frontend/e2e/README.md` (stack con IA simulada + `npm run test:e2e`)              |

### CI

Cada repo tiene `.github/workflows/ci.yml`:

- **database:** migraciones sobre una base limpia (dos veces), seed idempotente, gitleaks;
- **backend:** lint, typecheck, tests, build, `npm audit --omit=dev`, gitleaks;
- **frontend:** lo mismo más Lighthouse y E2E, ambos no bloqueantes.

El CI del backend y el E2E del frontend descargan los repos hermanos de la rama `main` (variables
de repositorio `DATABASE_REPO_REF` y `BACKEND_REPO_REF` para usar otra). Con los repos **públicos**
no hace falta ningún secreto. Si alguno pasa a privado, crea `DATABASE_REPO_TOKEN` (backend) y
`SIBLING_REPOS_TOKEN` (frontend): un fine-grained PAT con solo lectura de contenidos sobre esos repos.
Ningún job necesita secretos de producción: las claves que usan los tests son fijas y solo de
pruebas (revisadas en `.gitleaksignore`).

**Orden de merge a `main`:** 1) `renta-ia-database` → 2) `renta-ia-backend` → 3) `renta-ia-frontend`,
sin squash ni rebase: el `.gitleaksignore` identifica los falsos positivos por commit.

## Cómo demostrar cada tema de la materia

| Tema                                                            | Dónde está                                                                                                                                                                | Evidencia                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arquitectura cliente-servidor, REST y códigos HTTP              | `renta-ia-backend/src/modules/*` (routes → controller → service)                                                                                                          | `/docs` (Swagger), `docs/openapi.json`, tests de integración                                                                                                                                                                                                            |
| Documentación de APIs (OpenAPI)                                 | `renta-ia-backend/src/docs/openapi.ts` (desde los schemas zod)                                                                                                            | `tests/unit/openapi.test.ts` (falla si el JSON queda desactualizado)                                                                                                                                                                                                    |
| Validación de entrada                                           | `src/middlewares/validate.middleware.ts`, `src/modules/*/*.schema.ts`                                                                                                     | tests de 400 en `auth`, `aiChat`, `passwordPolicy`                                                                                                                                                                                                                      |
| DOM, eventos y SPA sin framework                                | `renta-ia-frontend/src/router.js`, `src/views/`                                                                                                                           | [ADR 0001](../docs/adr/0001-js-sin-framework-y-router-hash.md), `tests/tabs.test.js`                                                                                                                                                                                    |
| Asincronía, `fetch`, timeouts, reintentos, cancelación          | `renta-ia-frontend/src/api/http.js`                                                                                                                                       | `tests/http.test.js`, `tests/offline.test.js`                                                                                                                                                                                                                           |
| Autenticación, sesión y cookies                                 | `renta-ia-backend/src/modules/auth/`, frontend `src/auth/session.js`, `src/state/store.js`                                                                                | `tests/integration/session.test.ts`, frontend `tests/session.test.js`, [ADR 0007](../docs/adr/0007-esquema-de-sesion.md)                                                                                                                                                |
| Alta por invitación y enlaces firmados de un solo uso           | `src/modules/invitations/`, `src/utils/signedToken.ts`, migración `017`                                                                                                   | `invitations.test.ts`, `accountStatus.test.ts` (la base impide sesiones de cuentas pendientes), E2E `invitations.spec.js`, [ADR 0009](../docs/adr/0009-cuentas-pendientes-garantizadas-por-el-esquema.md), [0012](../docs/adr/0012-vigencia-de-los-enlaces-firmados.md) |
| Recuperación de contraseña sin enumeración                      | `src/modules/auth/` (recuperación), migración `018`                                                                                                                       | `passwordReset.test.ts` (respuesta y tiempo idénticos), E2E `passwordReset.spec.js`                                                                                                                                                                                     |
| Verificación en dos pasos (TOTP)                                | `src/modules/mfa/` (RFC 6238, secreto AES-256-GCM), frontend `src/views/security.view.js`                                                                                 | `tests/unit/totp.test.ts` (vectores oficiales), `mfa.test.ts`, E2E `mfa.spec.js`, [ADR 0011](../docs/adr/0011-mfa-totp.md)                                                                                                                                              |
| Sesiones activas y revocación inmediata                         | `src/modules/auth/sessions.service.ts`, migración `022`, frontend `src/views/activeSessions.js`                                                                           | `userSessions.test.ts`, E2E `sessions.spec.js`, [ADR 0013](../docs/adr/0013-sesiones-activas.md)                                                                                                                                                                        |
| Privacidad: exportar y eliminar la cuenta, retención            | `src/modules/users/account.service.ts`, `src/services/retention/`, migraciones `023`-`024`                                                                                | `accountData.test.ts`, `retention.test.ts`, E2E `accountData.spec.js`, `renta-ia-backend/docs/data-retention.md`                                                                                                                                                        |
| Proveedores externos intercambiables (correo, ubicación)        | `src/services/email/`, `src/services/geoip/`                                                                                                                              | `email.test.ts`, `tests/unit/geoip.test.ts`, [ADR 0010](../docs/adr/0010-proveedores-externos-intercambiables.md)                                                                                                                                                       |
| Subida segura de imágenes (firma, metadatos)                    | `src/utils/fileType.ts`, `src/utils/imageMetadata.ts`, frontend `src/components/avatarCropper.js`                                                                         | `avatar.test.ts`, `tests/unit/imageMetadata.test.ts`, E2E `avatar.spec.js`                                                                                                                                                                                              |
| Autorización por roles                                          | `src/middlewares/ownership.middleware.ts`, `role.middleware.ts`, frontend `src/auth/permissions.js` y `src/auth/routeAccess.js` (guard de rutas)                          | `tests/integration/roles.test.ts`, `ownership.test.ts`, `documentFile.test.ts` (propiedad cruzada del archivo), frontend `tests/guard.test.js`, E2E `guard.spec.js`                                                                                                     |
| Seguridad web (XSS, CSRF, CORS, CSP, cabeceras)                 | `csrf.middleware.ts`, `app.ts` (helmet, CORS), frontend `vite.config.js` (`buildCsp`), `utils/escapeHtml.js`                                                              | `renta-ia-backend/docs/threat-model.md`, E2E sin violaciones de CSP, `session.test.ts`                                                                                                                                                                                  |
| Seguridad de IA (prompt injection, aislamiento RAG, costo)      | `src/services/llm/untrusted.ts`, `embeddings.repository.ts`, `rateLimit.middleware.ts`                                                                                    | `tests/integration/ragIsolation.test.ts`, `tests/unit/aiProvider.test.ts`, threat model §3                                                                                                                                                                              |
| Auditoría                                                       | `src/services/audit/audit.service.ts`, migración `015_audit_log.sql`                                                                                                      | `roles.test.ts` (consulta paginada), `session.test.ts` (sin datos sensibles)                                                                                                                                                                                            |
| Almacenamiento en el navegador (IndexedDB, localStorage)        | `renta-ia-frontend/src/offline/offlineStore.js`, `src/state/store.js`                                                                                                     | `tests/offline.test.js`, `docs/cache-policy.md`                                                                                                                                                                                                                         |
| Caché HTTP y Service Worker (offline)                           | `renta-ia-frontend/src/sw/service-worker.js`, backend `app.ts` (`no-store`)                                                                                               | `tests/serviceWorker.test.js`, `tests/integration/cachePolicy.test.ts`, [ADR 0008](../docs/adr/0008-politica-de-cache.md)                                                                                                                                               |
| Tiempo real (WebSocket)                                         | `renta-ia-backend/src/realtime/wsServer.ts`, frontend `src/realtime/`                                                                                                     | `tests/integration/realtime.test.ts`, E2E (el estado cambia sin recargar)                                                                                                                                                                                               |
| Web Workers y rendimiento del hilo principal                    | `renta-ia-frontend/src/workers/`, `src/utils/scheduling.js`                                                                                                               | `renta-ia-frontend/docs/performance-report.md` (INP 1168 → 32 ms en el detalle)                                                                                                                                                                                         |
| Rendimiento web (Web Vitals, presupuestos)                      | `src/metrics/webVitals.js`, `scripts/check-bundle.mjs`, `lighthouserc.json`                                                                                               | `docs/performance-report.md`; el build falla si se excede un presupuesto (por rol, primera carga, CSS, y pdf.js solo al abrir un PDF)                                                                                                                                   |
| Accesibilidad                                                   | `src/components/tabs.js`, `router.js` (foco), `styles/`                                                                                                                   | E2E con axe en tema claro y oscuro en cada pantalla (0 violaciones serious/critical), teclado y foco en el visor y la vista dividida (`splitView.spec.js`), `tests/tabs.test.js`                                                                                        |
| Diseño: tokens, tema del sistema, estados de la interfaz, móvil | `renta-ia-frontend/src/styles/`, `src/components/states.js`, `src/components/densityToggle.js`                                                                            | `scripts/contrast.mjs` y `tests/contrast.test.js`, `tests/states.test.js`, E2E `theme.spec.js`, `states.spec.js`, `density.spec.js` (375 px sin desborde), `docs/dark-mode.md`, `docs/ui-states.md`                                                                     |
| IA con revisión humana                                          | `src/modules/clients/clients.service.ts` (`reviewConcept`), migración `026`, frontend `src/views/clientDetail/` (`conceptReview.js`, `documentViewer.js`, vista dividida) | `conceptReview.test.ts`, `conceptReviewWorker.test.ts` (D6), `documentFile.test.ts`, frontend `tests/splitView.test.js`, E2E `conceptReview.spec.js`, `documentViewer.spec.js`, `splitView.spec.js`                                                                     |
| Base de datos, migraciones y ORM                                | `renta-ia-database/migrations/`, `renta-ia-backend/prisma/schema.prisma`                                                                                                  | CI de la base (migraciones sobre base limpia), [ADR 0002](../docs/adr/0002-base-de-datos-en-repo-aparte.md), [0003](../docs/adr/0003-prisma-solo-como-cliente.md)                                                                                                       |
| Búsqueda semántica (pgvector)                                   | `src/modules/ai/embeddings.repository.ts`, `rag.service.ts`                                                                                                               | `ragIsolation.test.ts`, [ADR 0005](../docs/adr/0005-pgvector.md)                                                                                                                                                                                                        |
| Procesamiento asíncrono (colas)                                 | `src/queues/`, `src/workers/processDocument.ts`                                                                                                                           | `processDocument.test.ts`, `docs/load-test-report.md` (drenaje por concurrencia), [ADR 0004](../docs/adr/0004-bullmq.md)                                                                                                                                                |
| Observabilidad y operación                                      | `src/observability/`, `src/lifecycle/shutdown.ts`                                                                                                                         | `tests/integration/observability.test.ts`, `tests/unit/shutdown.test.ts`                                                                                                                                                                                                |
| Pruebas de carga                                                | `renta-ia-backend/loadtests/`                                                                                                                                             | `docs/load-test-report.md` (bcrypt: login 19,6 → 88,6 req/s)                                                                                                                                                                                                            |
| Pruebas (unitarias, integración, E2E)                           | `renta-ia-backend/tests/`, `renta-ia-frontend/tests/`, `renta-ia-frontend/e2e/`                                                                                           | 445 tests backend, 252 frontend, 44 E2E (Playwright + axe + vigilancia de la CSP); cada regla probada además con mutaciones manuales                                                                                                                                    |
| Integración continua                                            | `.github/workflows/ci.yml` de cada repo                                                                                                                                   | lint, tests, build, audit, gitleaks, Lighthouse, E2E                                                                                                                                                                                                                    |
| Modelo de dominio y amenazas                                    | `renta-ia-database/docs/modelo-de-dominio.md`, `renta-ia-backend/docs/threat-model.md`                                                                                    | roles, ciclos de vida y qué regla hace cumplir la base o la API; STRIDE con evidencia y riesgo residual                                                                                                                                                                 |

## Pruebas manuales pendientes (no automatizables aquí)

Estas dependen de crédito real de Anthropic/Voyage, de tecnología de asistencia o de servicios del
despliegue, y **no** se ejecutaron en el cierre del Proyecto 1 ni en el de la Fase 5:

1. **Pipeline con IA real** (`AI_PROVIDER=anthropic` y ambas keys): subir un
   certificado de ingresos real en PDF con texto → debe quedar `Procesado` con
   conceptos coherentes; revisar la calidad de la extracción.
2. **Imagen JPG/PNG** (OCR con Tesseract + LLM real): mismo resultado que el PDF.
3. **Sin crédito o con una key inválida**: el documento debe quedar
   "Procesado con advertencias" (texto guardado), y "Reintentar análisis" debe
   funcionar cuando haya crédito.
4. **Chat real**: preguntas sobre un cliente con documentos; la respuesta debe
   citar solo datos de ese cliente. Intentar un documento con texto del tipo
   "ignora las instrucciones y…" y confirmar que el modelo no lo obedece.
5. **Resumen ejecutivo real**: los totales vienen del código; revisar que el texto
   del LLM no invente cifras y que aparezca el aviso de revisión profesional.
6. **Latencia y límites reales** de Anthropic/Voyage con varios documentos a la vez
   (las pruebas de carga usaron IA simulada).
7. **Lector de pantalla** (NVDA en Windows o Narrador): login, navegación entre
   pestañas con flechas, anuncios de `aria-live` al subir un documento y al llegar
   una respuesta del chat, foco al cambiar de vista, enlace "Saltar al contenido".
8. **Calendario tributario**: reemplazar las fechas de ejemplo por las oficiales de la DIAN.
9. **Tope de gasto** mensual en las consolas de Anthropic y Voyage (recomendado).
10. **Lector de pantalla en las pantallas de la Fase 5**: completar la cuenta, verificación en dos
    pasos (QR y clave), sesiones activas, revisión de conceptos, visor del original (la página de un
    PDF no expone su texto: la alternativa es "Descargar") y vista dividida.
11. **Correo real (SES)**: los correos de invitación, recuperación y cambio de correo llegan a un
    buzón real y sus enlaces funcionan (hoy quedan en `email_outbox`).
12. **App de autenticación en un celular** (Google o Microsoft Authenticator, Aegis): escanear el QR
    y entrar con su código (las pruebas usan un cálculo TOTP equivalente).
13. **Ubicación real de las sesiones** con el CSV de DB-IP (`GEOIP_PROVIDER=dbip`) y una IP pública.

## Problemas frecuentes

| Síntoma                                                            | Causa probable                                                                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| La API no arranca: `Can't reach database server at localhost:5433` | Postgres no está corriendo (paso 1)                                                                                                 |
| Un documento se queda en "En cola"                                 | El worker (paso 5) no corre, o Redis (paso 2) está caído. `curl http://localhost:4000/ready` lo dice                                |
| "Procesado con advertencias"                                       | Se leyó el texto pero falló el LLM o los embeddings (p. ej. sin crédito). Lo obtenido queda guardado                                |
| "Error al procesar"                                                | No se pudo extraer texto (p. ej. PDF escaneado): súbelo como imagen JPG/PNG                                                         |
| "No se pudo conectar con el servidor"                              | La API no corre o `VITE_API_URL` no apunta a ella                                                                                   |
| Error de CORS en la consola                                        | `CORS_ORIGIN` del backend no incluye la URL del frontend                                                                            |
| La sesión se cierra al recargar                                    | El frontend y la API deben ser del mismo sitio (en local, ambos en `localhost`), y `COOKIE_SECURE` debe ser `false` si no hay HTTPS |
| `429 Demasiados intentos…`                                         | 10 logins fallidos / 15 min por IP, o la cuenta está bloqueada tras 5 fallos (1, 2, 4… min)                                         |
| `prisma generate` falla con `EPERM`                                | La API o el worker tienen la DLL de Prisma abierta: detenlos primero                                                                |

## Documentación de cada repo

- [`renta-ia-database/README.md`](../../renta-ia-database/README.md): esquema, migraciones, seed y el **modelo de dominio**.
- [`renta-ia-backend/README.md`](../README.md): API, sesión, operación, carga; `docs/` con la **guía de prueba**, ADR, threat model, retención de datos, informe de carga y OpenAPI.
- [`renta-ia-frontend/README.md`](../../renta-ia-frontend/README.md): arquitectura sin framework, sesión, offline, accesibilidad; `docs/` con rendimiento, caché y seguridad.
