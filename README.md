# renta-ia-backend

API REST del **Sistema de Gestión Documental Contable con IA**. Se conecta a la base de datos definida en el repositorio [`renta-ia-database`](../renta-ia-database) mediante Prisma.

## Estructura del proyecto

```
renta-ia-backend/
├── prisma/
│   └── schema.prisma            # Refleja el esquema del repo renta-ia-database
├── src/
│   ├── config/
│   │   ├── env.ts               # Carga y valida variables de entorno
│   │   ├── logger.ts            # Logger estructurado (pino) con redacción de secretos
│   │   ├── prisma.ts            # Cliente de Prisma (singleton)
│   │   └── redis.ts             # Conexión a Redis (cola + rate limiting)
│   ├── middlewares/
│   │   ├── auth.middleware.ts       # Verifica el JWT
│   │   ├── ownership.middleware.ts  # ÚNICO lugar que decide si un usuario accede a un cliente
│   │   ├── validate.middleware.ts   # Validación genérica con zod (body/params/query)
│   │   ├── rateLimit.middleware.ts  # Límites global, auth, chat y upload (Redis)
│   │   ├── role.middleware.ts       # Autorización por rol
│   │   └── error.middleware.ts      # Manejo centralizado de errores (Prisma/multer → 4xx)
│   ├── modules/                 # Cada módulo: routes → (schema) → controller → service
│   │   ├── auth/                # Registro / login
│   │   ├── users/               # Perfil del usuario autenticado
│   │   ├── clients/             # CRUD de clientes + conceptos tributarios del cliente
│   │   ├── documents/           # Subida de documentos y consulta
│   │   ├── alerts/              # Consulta de alertas
│   │   └── ai/                  # Chat RAG, extracción con LLM, embeddings, motor de reglas
│   ├── services/
│   │   ├── llm/anthropic.client.ts  # Cliente de Anthropic compartido
│   │   └── storage/             # Interfaz de almacenamiento (hoy disco local; S3 en Fase 6)
│   ├── queues/documentQueue.ts  # Cola BullMQ de procesamiento de documentos
│   ├── workers/
│   │   ├── processDocument.ts           # Pipeline de IA de un documento
│   │   └── documentProcessing.worker.ts # Arranque del worker (npm run worker)
│   ├── utils/                   # ApiError, asyncHandler, schemas comunes, uuid, tipos de archivo
│   ├── app.ts                   # Ensambla la app de Express
│   └── server.ts                # Punto de entrada de la API
├── tests/                       # Vitest: integration/ y unit/
├── .env.example
├── eslint.config.js · .prettierrc
├── vitest.config.ts
├── package.json
└── tsconfig.json · tsconfig.test.json
```

Cada módulo sigue el mismo patrón: **routes → controller → service → Prisma**. El controller nunca habla directo con Prisma; siempre pasa por el service, que es donde vive la lógica de negocio. La validación de entrada (zod) y la verificación de dueño del cliente ocurren en la ruta, antes del controller.

## Requisitos

- Node.js 20 o superior
- Docker (Postgres + pgvector del repo `renta-ia-database`, y Redis de este repo)
- El repositorio `renta-ia-database` ya migrado y corriendo (ver su propio README)

## Puesta en marcha (Windows · cmd.exe)

Parado dentro de la carpeta `renta-ia-backend`:

```bat
:: 1. Instalar dependencias
npm install

:: 2. Crear el archivo de variables de entorno
copy .env.example .env

:: 3. Generar el cliente de Prisma a partir del schema
npx prisma generate

:: 4. Confirmar que el schema coincide con la base de datos real
::    (opcional pero recomendado la primera vez)
npx prisma db pull

:: 5. Levantar el servidor en modo desarrollo
npm run dev
```

Si todo va bien, verás:

```
Conectado a la base de datos.
Servidor escuchando en http://localhost:4000
```

Prueba que responde:

```bat
curl http://localhost:4000/health
```

Debe devolver `{"status":"ok"}`.

## Variables de entorno (`.env`)

| Variable                               | Descripción                                                                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                         | Cadena de conexión a Postgres. Igual a la que usaste en `renta-ia-database`                                                                                                  |
| `JWT_SECRET`                           | Clave secreta para firmar los tokens. Cámbiala por un valor largo y aleatorio                                                                                                |
| `JWT_EXPIRES_IN`                       | Duración del token (ej. `1d`, `12h`)                                                                                                                                         |
| `PORT`                                 | Puerto donde corre el servidor (por defecto 4000)                                                                                                                            |
| `NODE_ENV`                             | `development`, `production` o `test` (cambia el formato de logs y de morgan)                                                                                                 |
| `LOG_LEVEL`                            | Nivel de logs (pino). Por defecto `info`                                                                                                                                     |
| `CORS_ORIGIN`                          | Orígenes permitidos por CORS, separados por coma. En desarrollo, por defecto `http://localhost:5173`; **obligatorio en producción**                                          |
| `TRUST_PROXY`                          | Proxies delante de la API (0 en local, 1 detrás de un balanceador)                                                                                                           |
| `REDIS_URL`                            | Redis para la cola de documentos y los contadores de rate limiting                                                                                                           |
| `AI_PROVIDER`                          | `anthropic` (por defecto) o `mock`. **`mock` es solo para E2E y pruebas de carga**: no llama a ninguna API y el servidor se niega a arrancar con él si `NODE_ENV=production` |
| `AI_MOCK_LATENCY_MS`                   | Solo con `AI_PROVIDER=mock`: latencia artificial por llamada (ms)                                                                                                            |
| `TAX_CALENDAR_PATH` / `TAX_RULES_PATH` | Opcionales: rutas a otros JSON de calendario tributario / parámetros (por defecto `src/config/tax-calendar.json` y `tax-rules.json`)                                         |
| `EXOGENOUS_TOLERANCE_RATIO`            | Opcional: tolerancia de la regla exógena vs. certificado (por defecto 0.05 = 5%)                                                                                             |
| `ANTHROPIC_API_KEY` / `VOYAGE_API_KEY` | Claves de IA (solo necesarias para procesar documentos y usar el chat)                                                                                                       |

## Endpoints

| Método | Ruta                              | Descripción                                                                                                           | Requiere token                    |
| ------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| POST   | `/api/auth/register`              | Crea un usuario con rol **contador** (el campo `role` se ignora; admin/asistente solo se asignan en la base de datos) | No                                |
| POST   | `/api/auth/login`                 | Inicia sesión y devuelve un JWT (el correo no distingue mayúsculas)                                                   | No                                |
| GET    | `/api/users/me`                   | Perfil del usuario autenticado                                                                                        | Sí                                |
| POST   | `/api/clients`                    | Crea un cliente contribuyente                                                                                         | Sí                                |
| GET    | `/api/clients`                    | Lista los clientes del contador autenticado                                                                           | Sí                                |
| GET    | `/api/clients/:id`                | Detalle de un cliente                                                                                                 | Sí                                |
| POST   | `/api/clients/:id/summary`        | Resumen ejecutivo: totales y saldo estimado calculados en código + texto redactado por IA (20/h por usuario)          | Sí                                |
| GET    | `/api/clients/:id/tax-concepts`   | Todos los conceptos tributarios del cliente (una sola consulta)                                                       | Sí                                |
| PATCH  | `/api/clients/:id`                | Actualiza un cliente                                                                                                  | Sí                                |
| DELETE | `/api/clients/:id`                | Elimina un cliente                                                                                                    | Sí                                |
| POST   | `/api/documents`                  | Registra metadatos de un documento (sin IA)                                                                           | Sí                                |
| POST   | `/api/documents/upload`           | Sube el archivo real y dispara el pipeline de IA                                                                      | Sí                                |
| GET    | `/api/documents/client/:clientId` | Lista documentos de un cliente                                                                                        | Sí                                |
| POST   | `/api/documents/:id/reprocess`    | Reintentar el análisis con IA (solo si terminó con error o advertencias; 409 si está en cola)                         | Sí                                |
| GET    | `/api/documents/:id`              | Detalle de un documento (con sus conceptos tributarios)                                                               | Sí                                |
| GET    | `/api/alerts/client/:clientId`    | Lista alertas de un cliente                                                                                           | Sí                                |
| PATCH  | `/api/alerts/:id`                 | Cambiar estado: `{ "status": "acknowledged"                                                                           | "resolved" }` (resuelta es final) | Sí  |
| POST   | `/api/alerts/deadlines/run`       | Ejecutar ya la revisión de vencimientos (el job corre a diario a las 06:00)                                           | Sí (admin)                        |
| WS     | `/ws`                             | Notificaciones en tiempo real del estado de los documentos (ver abajo)                                                | Sí (primer mensaje)               |
| POST   | `/api/ai/chat`                    | Pregunta en lenguaje natural sobre un cliente (RAG)                                                                   | Sí                                |

Todas las rutas que reciben un cliente (`:id`, `:clientId` o `clientId` en el body) verifican que pertenezca al usuario autenticado (o que sea admin). Si no, responden **404** (no 403) para no revelar que el recurso existe.

### Validación, errores y límites

- Todos los bodies y parámetros se validan con **zod** (`src/modules/*/*.schema.ts`). Los campos no declarados se descartan.
- Formato de error: `{ "error": "mensaje", "details": [{ "field": "body.question", "message": "..." }] }` (`details` solo en errores de validación).
- Códigos: `400` datos inválidos · `401` sin token/token inválido · `404` no existe o no es tuyo · `409` duplicado (ej. misma cédula para el mismo contador) · `413` archivo o body demasiado grande · `415` tipo de archivo no permitido · `429` límite de solicitudes.
- `POST /api/ai/chat`: `question` entre 3 y 1000 caracteres.
- `POST /api/documents/upload`: solo PDF, PNG o JPG (se valida MIME, extensión y contenido real), máx. 15 MB.
- Rate limiting (contadores en Redis): 300 req/15 min por IP en toda la API · 10 intentos **fallidos** /15 min en `/api/auth/*` · 30 preguntas/hora por usuario en el chat · 30 subidas/hora por usuario.

Para las rutas que requieren token, envía el header:

```
Authorization: Bearer <token que devolvió /api/auth/login>
```

## Prueba rápida de extremo a extremo (cmd.exe)

```bat
:: Registrar un contador
curl -X POST http://localhost:4000/api/auth/register ^
  -H "Content-Type: application/json" ^
  -d "{\"name\":\"Ana Contadora\",\"email\":\"ana2@example.com\",\"password\":\"claveSegura123\"}"
```

Copia el `token` de la respuesta y úsalo así:

```bat
curl http://localhost:4000/api/clients ^
  -H "Authorization: Bearer PEGA_AQUI_EL_TOKEN"
```

## Tiempo real (WebSocket `/ws`)

El worker publica cada cambio de estado de un documento en Redis (pub/sub); la API lo reenvía por WebSocket **solo** al contador dueño del cliente (y a los admin).

- Conexión: `ws://localhost:4000/ws`, con un `Origin` permitido por `CORS_ORIGIN`.
- Primer mensaje (antes de 5 s): `{ "type": "auth", "token": "<token>" }` → responde `{ "type": "ready" }`.
- Eventos: `{ "type": "document.updated", "documentId", "clientId", "status", "errorMessage", "at" }`.
- Cierres: `4401` token inválido, `4408` no se autenticó a tiempo, `4409` token expirado.
- Si el socket no está disponible, el frontend hace polling con backoff mientras haya documentos pendientes.

## Alertas de vencimiento y calendario tributario

`src/config/tax-calendar.json` define, por año gravable, la fecha límite de la declaración según los dos últimos dígitos del NIT/cédula. **Las fechas incluidas son de EJEMPLO** (`"esEjemplo": true`) y cada alerta lo advierte: reemplázalas con el calendario oficial de la DIAN. El worker (`npm run worker`) programa un job diario (06:00, America/Bogota) que crea o escala las alertas sin duplicarlas y sin recrear las resueltas.

## Tests y calidad de código

```bat
:: Tests (Vitest + Supertest). Necesitan el Postgres de renta-ia-database corriendo:
:: crean desde cero una base aparte "renta_ia_test" (nunca tocan renta_ia) y le
:: aplican las migraciones de ..
enta-ia-databasemigrations.
npm test

:: Lint (ESLint + Prettier), typecheck y build
npm run lint
npm run typecheck
npm run build

:: Formatear el código
npm run format
```

Variables opcionales para los tests: `TEST_DATABASE_URL` (por defecto `postgresql://postgres:postgres@localhost:5433/renta_ia_test`; su nombre **debe** terminar en `_test`) y `MIGRATIONS_DIR` (ruta a las migraciones SQL). Anthropic, Voyage y Redis están mockeados: los tests no consumen crédito ni necesitan Redis.

## Relación con el repositorio de base de datos

Este backend **no crea ni modifica tablas** (no usa `prisma migrate`). El dueño del esquema es `renta-ia-database`. El flujo correcto ante un cambio de esquema es:

1. Se agrega una nueva migración SQL en `renta-ia-database`.
2. Se aplica esa migración (`scripts\migrate.bat`).
3. Aquí, en el backend, se corre `npx prisma db pull` para refrescar `prisma/schema.prisma` con la nueva estructura.
4. Se ajusta el código de los servicios/controladores si el cambio lo requiere.

## Pipeline de IA: puesta en marcha (Windows · cmd.exe)

Requisitos adicionales a los de la Fase 2:

- Contenedor de Redis corriendo (para la cola de tareas)
- API key de Anthropic (`console.anthropic.com` → API Keys)
- API key de Voyage AI (`console.voyageai.com` → usada para generar embeddings)

```bat
:: 1. Instalar las nuevas dependencias (bullmq, tesseract.js, pdf-parse, etc.)
npm install

:: 2. Levantar Redis
docker compose up -d

:: 3. Editar tu .env y pegar tus API keys
notepad .env
```

En el `.env`, completa:

```
ANTHROPIC_API_KEY=sk-ant-...
VOYAGE_API_KEY=pa-...
```

**Este proyecto ahora corre en DOS procesos separados**, cada uno en su propia ventana de cmd:

```bat
:: Ventana 1 — la API (igual que antes)
npm run dev

:: Ventana 2 — el worker que procesa documentos con IA
npm run worker
```

Si el worker arrancó bien, verás:

```
Worker de procesamiento de documentos escuchando la cola 'document-processing'...
```

### Probar el pipeline completo

Con ambos procesos corriendo, y con un token de un contador ya logueado (ver sección de autenticación arriba) y un `clientId` ya creado:

```bat
curl -X POST http://localhost:4000/api/documents/upload ^
  -H "Authorization: Bearer PEGA_AQUI_EL_TOKEN" ^
  -F "file=@C:\ruta\a\tu\certificado.pdf" ^
  -F "clientId=PEGA_AQUI_EL_CLIENT_ID" ^
  -F "docType=income_certificate"
```

En la ventana del **worker** deberías ver los logs del procesamiento en tiempo real (extracción de texto, conceptos encontrados, embeddings generados). Cuando termine, consulta:

```bat
curl http://localhost:4000/api/documents/DOCUMENT_ID ^
  -H "Authorization: Bearer PEGA_AQUI_EL_TOKEN"
```

El campo `status` debe pasar de `uploaded` → `processing` → `processed` (o `error`, con `errorMessage` explicando qué pasó).

### Probar el chat con IA (RAG)

```bat
curl -X POST http://localhost:4000/api/ai/chat ^
  -H "Authorization: Bearer PEGA_AQUI_EL_TOKEN" ^
  -H "Content-Type: application/json" ^
  -d "{\"clientId\":\"PEGA_AQUI_EL_CLIENT_ID\",\"question\":\"Cuanto fue el ingreso bruto reportado?\"}"
```

### Limitación conocida

El OCR (`text-extraction.service.ts`) solo soporta:

- PDFs con **texto real embebido** (no escaneados) — la mayoría de certificados generados digitalmente
- Imágenes JPG/PNG (con OCR real vía Tesseract.js)

**PDFs escaneados** (una foto/imagen metida dentro de un PDF, sin texto) no están soportados todavía — el sistema devuelve un error claro pidiendo subir el documento como imagen. En producción esto se resolvería agregando AWS Textract (ya contemplado en la arquitectura), que si sabe leer PDFs escaneados directamente.

## Estado del proyecto

| Fase                                                                                                                                         | Estado    |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1. Base de datos (repo `renta-ia-database`)                                                                                                  | ✅        |
| 2. API REST (auth, clientes, documentos, alertas)                                                                                            | ✅        |
| 3. Pipeline de IA (OCR, extracción con LLM, embeddings, reglas, chat RAG)                                                                    | ✅        |
| 4. Frontend SPA (repo `renta-ia-frontend`)                                                                                                   | ✅        |
| 5. Endurecimiento: autorización por dueño, validación zod, rate limiting, tests, lint, CI                                                    | ✅        |
| 6. Despliegue en AWS: Dockerfile de producción, `s3-storage.service.ts` (misma interfaz que el storage local), ECS/Fargate, RDS, ElastiCache | Pendiente |
