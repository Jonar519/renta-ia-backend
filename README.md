# renta-ia-backend

API REST + worker de IA del **Sistema de Gestión Documental Contable con IA**.
Se conecta a la base de datos del repositorio [`renta-ia-database`](../renta-ia-database)
mediante Prisma (solo como cliente: el esquema lo gestiona ese repo).

- Decisiones de arquitectura: [`docs/adr/`](docs/adr/README.md)
- Modelo de amenazas (STRIDE): [`docs/threat-model.md`](docs/threat-model.md)
- Pruebas de carga con mediciones reales: [`docs/load-test-report.md`](docs/load-test-report.md)
- API (OpenAPI 3): [`docs/openapi.json`](docs/openapi.json) y, fuera de producción, **http://localhost:4000/docs**

## Estructura

```
renta-ia-backend/
├── prisma/schema.prisma          # Generado con `npx prisma db pull` (no se edita a mano salvo nombres de relaciones)
├── src/
│   ├── config/                   # env (validación), logger (pino), prisma, redis, calendario y reglas tributarias
│   ├── middlewares/              # auth (JWT), ownership (clientScope por rol), role, csrf, validate (zod), rateLimit, error
│   ├── modules/                  # routes → (schema zod) → controller → service → Prisma
│   │   ├── auth/                 # registro, login, refresh, logout, bloqueo progresivo, política de contraseñas
│   │   ├── admin/                # alta de usuarios assistant/client, consulta de auditoría
│   │   ├── users/ clients/ documents/ alerts/ ai/ metrics/
│   ├── services/
│   │   ├── llm/                  # proveedor de IA (anthropic | mock), delimitadores anti prompt-injection
│   │   ├── storage/              # interfaz de almacenamiento (hoy disco local)
│   │   ├── audit/                # registro de auditoría (audit_log)
│   │   ├── access/               # audiencia de un cliente (para el tiempo real)
│   │   └── events/               # eventos worker → API (Redis pub/sub)
│   ├── observability/            # /health, /ready y métricas Prometheus
│   ├── lifecycle/                # apagado ordenado (SIGTERM/SIGINT)
│   ├── realtime/                 # WebSocket /ws
│   ├── queues/ workers/          # BullMQ: cola de documentos y tareas programadas
│   ├── docs/                     # generador de OpenAPI desde los schemas zod
│   ├── app.ts · server.ts
├── tests/                        # Vitest + Supertest (integration/ y unit/)
├── loadtests/                    # autocannon (ver loadtests/README.md)
└── docs/                         # ADR, threat model, informe de carga, openapi.json
```

## Puesta en marcha (Windows · cmd.exe)

Requisitos: Node.js 20+, Docker Desktop, y `renta-ia-database` levantado y migrado.

```bat
:: Redis (cola, rate limiting, eventos en tiempo real)
docker compose up -d

npm install
copy .env.example .env
npx prisma generate

:: Ventana 1: la API
npm run dev

:: Ventana 2: el worker de IA
npm run worker
```

Edita `.env`: `JWT_SECRET` largo y aleatorio, y `ANTHROPIC_API_KEY` / `VOYAGE_API_KEY`
si las tienes (sin ellas todo funciona salvo el análisis con IA y el chat).

> **Si ya tenías un `.env` de antes:** cambia `JWT_EXPIRES_IN=1d` por
> `JWT_EXPIRES_IN=15m`. Con el esquema de sesión nuevo el access token es corto
> y se renueva solo con la cookie de refresh.

Comprobación:

```bat
curl http://localhost:4000/health
curl http://localhost:4000/ready
```

`/health` → `{"status":"ok",...}`; `/ready` → `{"status":"ready","checks":{"database":"ok","redis":"ok"}}`.

## Variables de entorno

| Variable                                | Por defecto              | Descripción                                                                                                         |
| --------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                          | — (obligatoria)          | PostgreSQL de `renta-ia-database` (puerto **5433** en local)                                                        |
| `JWT_SECRET`                            | — (obligatoria)          | Clave para firmar los access tokens (HS256)                                                                         |
| `JWT_EXPIRES_IN`                        | `15m`                    | Vida del access token (el navegador lo guarda solo en memoria)                                                      |
| `REFRESH_TOKEN_TTL_DAYS`                | `7`                      | Vida del refresh token (cookie httpOnly rotativa)                                                                   |
| `COOKIE_SECURE`                         | `true` en producción     | Cookie `Secure` (solo HTTPS)                                                                                        |
| `PORT`                                  | `4000`                   | Puerto de la API y del WebSocket                                                                                    |
| `NODE_ENV`                              | `development`            | `production` activa `Secure`, exige `CORS_ORIGIN`, oculta `/docs` y prohíbe `AI_PROVIDER=mock` y `RATE_LIMIT_SCALE` |
| `LOG_LEVEL`                             | `info`                   | Nivel de pino                                                                                                       |
| `CORS_ORIGIN`                           | `http://localhost:5173`  | Orígenes permitidos (coma). **Obligatorio en producción**                                                           |
| `TRUST_PROXY`                           | `0`                      | Proxies delante de la API (1 detrás de un balanceador)                                                              |
| `REDIS_URL`                             | `redis://localhost:6379` | Cola, rate limiting y eventos                                                                                       |
| `WORKER_CONCURRENCY`                    | `2`                      | Documentos en paralelo por worker (ver informe de carga)                                                            |
| `METRICS_TOKEN`                         | vacío                    | Token para `GET /metrics` (API) y `:WORKER_METRICS_PORT/metrics` (worker). Vacío = 404                              |
| `WORKER_METRICS_PORT`                   | `9464`                   | Puerto de métricas del worker                                                                                       |
| `SHUTDOWN_TIMEOUT_MS`                   | `10000`                  | Tiempo máximo del apagado ordenado                                                                                  |
| `SHUTDOWN_DRAIN_DELAY_MS`               | `0`                      | Espera entre `/ready = 503` y cerrar el servidor (en producción ≥ intervalo del health check)                       |
| `AI_PROVIDER`                           | `anthropic`              | `mock` **solo para E2E y pruebas de carga** (rechazado con `NODE_ENV=production`)                                   |
| `AI_MOCK_LATENCY_MS`                    | `0`                      | Latencia simulada por llamada con `AI_PROVIDER=mock`                                                                |
| `RATE_LIMIT_SCALE`                      | `1`                      | **Solo pruebas de carga**: multiplica todos los límites (rechazado en producción)                                   |
| `ANTHROPIC_API_KEY` / `VOYAGE_API_KEY`  | vacías                   | Claves de IA                                                                                                        |
| `STORAGE_DRIVER` / `STORAGE_LOCAL_PATH` | `local` / `./uploads`    | Almacenamiento de archivos                                                                                          |
| `TAX_CALENDAR_PATH` / `TAX_RULES_PATH`  | JSON en `src/config/`    | Calendario (fechas **de ejemplo**) y parámetros tributarios                                                         |

## Sesión y seguridad

- `POST /api/auth/login` y `/register` devuelven `{ accessToken, user }` y dejan la
  cookie `renta_ia_refresh` (httpOnly, `SameSite=Strict`, `Path=/api/auth`).
- `POST /api/auth/refresh` rota la cookie y entrega un access token nuevo;
  `POST /api/auth/logout` revoca la sesión. Ambos exigen `X-Requested-With: renta-ia`.
- Bloqueo progresivo por cuenta tras 5 fallos (1, 2, 4… hasta 60 min) y 10 fallos / 15 min por IP.
- Contraseñas: 10–72 caracteres, sin contraseñas comunes ni el correo o el nombre.
- Roles: `admin`, `accountant`, `assistant` (clientes de su contador, sin crear ni
  borrar) y `client` (solo lectura de su expediente). Se crean con `POST /api/admin/users`.
- Auditoría en `audit_log` (sin datos sensibles), consultable en `GET /api/admin/audit`.
- Detalles y riesgos residuales: [`docs/threat-model.md`](docs/threat-model.md) y [ADR 0007](docs/adr/0007-esquema-de-sesion.md).

Probar con curl (cmd.exe), guardando la cookie en un archivo:

```bat
curl -c cookies.txt -X POST http://localhost:4000/api/auth/login ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"ana@example.com\",\"password\":\"Password123!\"}"

:: Copia el accessToken de la respuesta:
set TOKEN=pega-aqui-el-access-token
curl http://localhost:4000/api/clients -H "Authorization: Bearer %TOKEN%"

:: Renovar (usa y reemplaza la cookie)
curl -b cookies.txt -c cookies.txt -X POST http://localhost:4000/api/auth/refresh -H "X-Requested-With: renta-ia"
```

## Endpoints

La referencia completa, generada desde los schemas zod, está en **`/docs`** (Swagger UI,
fuera de producción) y en `docs/openapi.json` (`npm run openapi` la regenera; un
test falla si quedó desactualizada).

| Grupo        | Rutas                                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth         | `POST /api/auth/register` · `login` · `refresh` · `logout` · `GET /api/users/me`                                                                                                              |
| Clientes     | `GET/POST /api/clients` · `GET/PATCH/DELETE /api/clients/:id` · `GET /api/clients/:id/tax-concepts` · `POST /api/clients/:id/summary`                                                         |
| Documentos   | `POST /api/documents/upload` · `GET /api/documents/client/:clientId` · `GET /api/documents/client/:clientId/by-hash/:sha256` · `GET /api/documents/:id` · `POST /api/documents/:id/reprocess` |
| Alertas      | `GET /api/alerts/client/:clientId` · `PATCH /api/alerts/:id` · `POST /api/alerts/deadlines/run` (admin)                                                                                       |
| IA           | `POST /api/ai/chat`                                                                                                                                                                           |
| Admin        | `POST /api/admin/users` · `GET /api/admin/audit`                                                                                                                                              |
| Métricas web | `POST /api/metrics/web-vitals` · `GET /api/metrics/web-vitals/summary` (admin)                                                                                                                |
| Operación    | `GET /health` · `GET /ready` · `GET /metrics` (token) · `GET /docs` (no producción)                                                                                                           |
| Tiempo real  | `WS /ws` (token en el primer mensaje)                                                                                                                                                         |

Listados paginados por cursor: `?limit=50&cursor=...` → `{ items, nextCursor }`.
Un recurso de otro cliente responde **404** (no 403) para no revelar que existe.

## Tiempo real (WebSocket `/ws`)

- `ws://localhost:4000/ws` con un `Origin` de `CORS_ORIGIN`.
- Primer mensaje: `{ "type": "auth", "token": "<accessToken>" }` → `{ "type": "ready" }`.
- Eventos `document.updated` a quienes pueden ver el cliente: contador, sus
  asistentes, el usuario de portal del cliente y los admin.

## Observabilidad y operación

- `GET /health` (liveness, sin dependencias) y `GET /ready` (PostgreSQL + Redis; 503 durante el apagado).
- Apagado ordenado con `SIGTERM` o **Ctrl+C** en cmd.exe (API y worker): deja de
  recibir tráfico, termina lo que está en curso y cierra conexiones. El worker
  espera a que terminen los documentos en proceso.
- Métricas Prometheus con `METRICS_TOKEN`:

```bat
set METRICS_TOKEN=un-token-largo
npm run dev
curl http://localhost:4000/metrics -H "Authorization: Bearer %METRICS_TOKEN%"
```

Incluyen `renta_ia_http_request_duration_seconds`, `renta_ia_queue_jobs`,
`renta_ia_pipeline_stage_duration_seconds`, `renta_ia_llm_request_duration_seconds`,
`renta_ia_llm_tokens_total` y las métricas del proceso.

## Tests, calidad y pruebas de carga

```bat
npm test
npm run lint
npm run typecheck
npm run build
npm run openapi
```

Los tests necesitan el PostgreSQL de `renta-ia-database`: crean desde cero la base
`renta_ia_test` (nunca tocan `renta_ia`) con las migraciones de
`..\renta-ia-database\migrations`. Redis, Anthropic y Voyage están simulados.

Pruebas de carga: [`loadtests/README.md`](loadtests/README.md)
(`npm run loadtest:setup`, `loadtest:login`, `loadtest:list`, `loadtest:mixed`,
`loadtest:chat`, `loadtest:upload`, `loadtest:ratelimit`).

CI (`.github/workflows/ci.yml`): lint, typecheck, tests, build; y un job
`security` con `npm audit --omit=dev` y gitleaks.

## Cambios de esquema

Este repo **no crea ni modifica tablas**. Ante un cambio:

1. Nueva migración en `renta-ia-database` (nunca se editan las existentes) y `scripts\migrate.bat`.
2. Aquí: `npx prisma db pull` y ajustar el código.
3. Merge: **primero** `renta-ia-database`, después este repo (su CI lee las migraciones de `main`).

En Windows, si `prisma generate` falla con `EPERM` sobre `query_engine-windows.dll.node`,
detén la API y el worker (tienen la DLL abierta) y vuelve a intentarlo.

## Pipeline de IA

Subida → cola (BullMQ) → worker: extracción de texto (PDF con texto o imagen con
OCR) → conceptos tributarios con el LLM → embeddings (Voyage) → reglas → alertas.
La extracción de conceptos y los embeddings **fallan por separado**: el documento
queda `processed` con advertencias y se puede reprocesar. Un PDF escaneado (sin
texto) termina en `error` con un mensaje que pide subirlo como imagen.

El calendario tributario incluido (`src/config/tax-calendar.json`) tiene **fechas
de ejemplo** (`"esEjemplo": true`) y cada alerta lo advierte: reemplázalo por el
calendario oficial de la DIAN.

## Estado

| Tema                                                                       | Estado                           |
| -------------------------------------------------------------------------- | -------------------------------- |
| API, pipeline de IA, tiempo real, alertas, resumen                         | ✅                               |
| Sesión con refresh rotativo, CSRF, bloqueo, roles, auditoría, threat model | ✅                               |
| Health/ready, apagado ordenado, métricas, pruebas de carga                 | ✅                               |
| OpenAPI, ADR                                                               | ✅                               |
| Despliegue en AWS (Dockerfile de producción, S3, infraestructura)          | Pendiente (fuera del Proyecto 1) |
