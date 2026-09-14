# renta-ia-backend

API REST del **Sistema de Gestión Documental Contable con IA**. Se conecta a la base de datos definida en el repositorio [`renta-ia-database`](../renta-ia-database) mediante Prisma.

## Estructura del proyecto

```
renta-ia-backend/
├── prisma/
│   └── schema.prisma       # Refleja el esquema del repo renta-ia-database
├── src/
│   ├── config/
│   │   ├── env.ts           # Carga y valida variables de entorno
│   │   └── prisma.ts        # Cliente de Prisma (singleton)
│   ├── middlewares/
│   │   ├── auth.middleware.ts    # Verifica el JWT
│   │   ├── role.middleware.ts    # Autorización por rol
│   │   └── error.middleware.ts   # Manejo centralizado de errores
│   ├── modules/
│   │   ├── auth/         # Registro / login
│   │   ├── users/        # Perfil del usuario autenticado
│   │   ├── clients/      # CRUD de clientes contribuyentes
│   │   ├── documents/    # Metadatos de documentos (IA se integra en Fase 3)
│   │   └── alerts/       # Consulta de alertas
│   ├── utils/
│   │   ├── apiError.ts
│   │   └── asyncHandler.ts
│   ├── app.ts             # Ensambla la app de Express
│   └── server.ts          # Punto de entrada
├── .env.example
├── package.json
└── tsconfig.json
```

Cada módulo sigue el mismo patrón: **routes → controller → service → Prisma**. El controller nunca habla directo con Prisma; siempre pasa por el service, que es donde vive la lógica de negocio.

## Requisitos

- Node.js 18 o superior
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

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Cadena de conexión a Postgres. Igual a la que usaste en `renta-ia-database` |
| `JWT_SECRET` | Clave secreta para firmar los tokens. Cámbiala por un valor largo y aleatorio |
| `JWT_EXPIRES_IN` | Duración del token (ej. `1d`, `12h`) |
| `PORT` | Puerto donde corre el servidor (por defecto 4000) |

## Endpoints disponibles (Fase 2)

| Método | Ruta | Descripción | Requiere token |
|---|---|---|---|
| POST | `/api/auth/register` | Crea un usuario (contador, asistente, admin) | No |
| POST | `/api/auth/login` | Inicia sesión y devuelve un JWT | No |
| GET | `/api/users/me` | Perfil del usuario autenticado | Sí |
| POST | `/api/clients` | Crea un cliente contribuyente | Sí |
| GET | `/api/clients` | Lista los clientes del contador autenticado | Sí |
| GET | `/api/clients/:id` | Detalle de un cliente | Sí |
| PATCH | `/api/clients/:id` | Actualiza un cliente | Sí |
| DELETE | `/api/clients/:id` | Elimina un cliente | Sí |
| POST | `/api/documents` | Registra metadatos de un documento subido | Sí |
| GET | `/api/documents/client/:clientId` | Lista documentos de un cliente | Sí |
| GET | `/api/documents/:id` | Detalle de un documento (con sus conceptos tributarios) | Sí |
| GET | `/api/alerts/client/:clientId` | Lista alertas de un cliente | Sí |

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

## Relación con el repositorio de base de datos

Este backend **no crea ni modifica tablas** (no usa `prisma migrate`). El dueño del esquema es `renta-ia-database`. El flujo correcto ante un cambio de esquema es:

1. Se agrega una nueva migración SQL en `renta-ia-database`.
2. Se aplica esa migración (`scripts\migrate.bat`).
3. Aquí, en el backend, se corre `npx prisma db pull` para refrescar `prisma/schema.prisma` con la nueva estructura.
4. Se ajusta el código de los servicios/controladores si el cambio lo requiere.

## Qué falta (próximas fases)

- **Fase 3:** cola de tareas (BullMQ + Redis), OCR, extracción de conceptos tributarios con LLM, generación de embeddings (pgvector) y motor de reglas/alertas automáticas.
- **Fase 6:** Dockerfile de producción y despliegue en AWS (ECS/Fargate).
