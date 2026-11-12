# Renta IA: gestión documental contable con inteligencia artificial

**Producción:** aplicación en <https://renta.jonarproyectos.com> · API en
`api-renta.jonarproyectos.com` (estado: [`/ready`](https://api-renta.jonarproyectos.com/ready)).

Este README es la guía para evaluar el proyecto completo sin ayuda. El proyecto vive en tres
repositorios; este (`renta-ia-backend`) es el principal y tiene la guía de pruebas. Los otros dos
explican su parte y enlazan aquí:

| Repositorio         | Qué contiene                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `renta-ia-backend`  | **Este.** API REST, WebSocket, worker de documentos con OCR e IA, alertas, correo y archivos.        |
| `renta-ia-frontend` | La aplicación web: clientes, documentos, conceptos, alertas, resumen, chat, cuenta y administración. |
| `renta-ia-database` | El esquema de PostgreSQL (migraciones SQL), los datos de prueba y el diagrama de la base.            |

## Contenido

1. [Qué es el proyecto](#1-qué-es-el-proyecto)
2. [Cómo funciona](#2-cómo-funciona)
3. [Tecnologías](#3-tecnologías)
4. [Qué necesita el profesor](#4-qué-necesita-el-profesor)
5. [Acceso y roles](#5-acceso-y-roles)

## 1. Qué es el proyecto

**Renta IA** ayuda a una firma contable a preparar la declaración de renta de sus clientes. El
contador sube los soportes del cliente (certificados de ingresos, extractos, facturas…); un proceso
en segundo plano lee el texto (con OCR si es una imagen), una IA extrae las cifras tributarias, un
motor de reglas genera alertas (vencimientos e inconsistencias) y un chat responde preguntas sobre
el cliente usando solo sus documentos (RAG). Lo que extrae la IA queda marcado **"sin revisar"**
hasta que una persona lo confirma con el documento original al lado. Está pensado para contadores,
sus asistentes y los propios contribuyentes, que consultan su expediente en un portal de solo
lectura.

Capacidades principales:

- **Clientes** de cada contador, con aislamiento estricto entre contadores.
- **Subida de documentos** (PDF, JPG o PNG, hasta 15 MB) con análisis automático: texto u OCR,
  conceptos tributarios con IA y embeddings para el chat.
- **Revisión humana** de cada concepto extraído, con el **visor del original** y una vista dividida.
- **Alertas** de vencimientos e inconsistencias, y un **resumen** con estimación simplificada del
  impuesto.
- **Asistente de IA** que responde preguntas sobre un cliente con sus propios documentos.
- **Tiempo real**: el estado de cada documento se actualiza solo.
- **Cuentas** solo por invitación, con verificación en dos pasos (obligatoria para el
  administrador), recuperación de contraseña, sesiones activas, perfil con foto, exportación y
  eliminación de la cuenta.
- **Administración**: invitaciones, reasignación de clientes y métricas de rendimiento web.

## 2. Cómo funciona

### El recorrido de principio a fin

1. **El administrador invita** a contadores, asistentes (ligados a un contador) y contribuyentes
   (ligados a su expediente). Cada persona recibe un enlace por correo y elige su contraseña.
2. **El contador crea un cliente** y **sube un documento**. La API guarda el archivo, calcula su
   huella (SHA-256, para detectar duplicados) y encola el análisis; responde al instante.
3. **El worker** (un proceso aparte que atiende la cola en Redis) extrae el texto del PDF, o lo
   reconoce con OCR si es una imagen, pide a Claude los conceptos tributarios (ingresos,
   retenciones, deducciones, aportes), calcula los embeddings con Voyage y corre las reglas que
   generan alertas.
4. **El navegador se entera solo:** el worker publica el cambio, la API lo envía por WebSocket y la
   tabla de documentos pasa de "Procesando" a "Procesado" sin recargar.
5. **El contador revisa** cada concepto con el original al lado y lo confirma o corrige; queda quién
   y cuándo, y se conserva lo que leyó la IA.
6. **Pregunta y resume:** el asistente de IA responde con fragmentos de los documentos de ese
   cliente, y el resumen calcula una estimación simplificada del impuesto.
7. **El contribuyente** entra a su portal y ve su expediente, solo con lo ya revisado.

### Arquitectura

```mermaid
flowchart LR
  subgraph Navegador
    UI["App web<br/>(Vite, JavaScript sin framework)"]
  end
  subgraph Vercel
    F["Frontend estático"]
  end
  subgraph Railway
    A["API Node.js + Express<br/>REST · WebSocket /ws"]
    K["Worker (BullMQ)<br/>texto u OCR · IA · reglas · vencimientos"]
    D[("PostgreSQL 16 + pgvector")]
    R[("Redis 7<br/>cola · límites · eventos")]
  end
  IA["Anthropic Claude<br/>(conceptos, chat, resumen)"]
  V["Voyage AI<br/>(embeddings)"]
  S3["Cloudflare R2<br/>(documentos y fotos)"]
  SES["Amazon SES<br/>(correo)"]

  F -- "descarga la app" --> UI
  UI -- "HTTPS y WebSocket" --> A
  A <--> D
  A <--> R
  K <--> R
  K <--> D
  A --> S3
  K --> S3
  A --> IA
  K --> IA
  A --> V
  K --> V
  A --> SES
```

El DNS está en Cloudflare. La aplicación (`renta.`) y la API (`api-renta.`) son orígenes distintos del
mismo sitio: la cookie de sesión viaja entre los dos y la API responde con CORS solo al origen de la
aplicación.

### Flujo principal: subir un documento y revisarlo

```mermaid
sequenceDiagram
  actor C as Contador
  participant API
  participant Q as Redis (cola y eventos)
  participant W as Worker
  participant IA as Claude y Voyage

  C->>API: Subir y analizar con IA (PDF o imagen)
  API->>API: Guarda el archivo y su huella SHA-256
  API->>Q: Encola el análisis
  API-->>C: "Documento subido. El análisis con IA corre en segundo plano."
  Q->>W: Toma el trabajo
  W->>W: Texto del PDF u OCR de la imagen
  W->>IA: Extraer conceptos tributarios
  W->>IA: Embeddings de los fragmentos
  W->>W: Reglas: alertas de vencimientos e inconsistencias
  W->>Q: Publica "documento actualizado"
  Q-->>API: Evento
  API-->>C: WebSocket: el estado pasa a "Procesado"
  C->>API: Revisar un concepto (confirmar o corregir el monto)
  API-->>C: "Concepto revisado." (queda quién y cuándo)
```

Más detalle: el pipeline y las respuestas del modelo en la
[referencia técnica](docs/referencia-tecnica.md#pipeline-de-ia), las decisiones en
[docs/adr/](docs/adr/README.md), el modelo de dominio en
[renta-ia-database](https://github.com/Jonar519/renta-ia-database/blob/main/docs/modelo-de-dominio.md) y
el contrato de la API en [docs/openapi.json](docs/openapi.json).

## 3. Tecnologías

Versiones: los rangos declarados en el `package.json` de cada repositorio, el `Dockerfile` y el
`docker-compose.yml`.

| Tecnología                                            | Versión                              | Para qué se usa                                                                        | Por qué se eligió                                                                                                        |
| ----------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Node.js**                                           | 20 (imagen `node:20-bookworm-slim`)  | API y worker                                                                           | Un solo lenguaje con el frontend; buen manejo de E/S y colas.                                                            |
| **TypeScript**                                        | ^5.5.4                               | Lenguaje del backend                                                                   | Tipos en los contratos entre módulos.                                                                                    |
| **Express**                                           | ^4.19.2                              | API REST (rutas → esquema → controlador → servicio)                                    | Estándar conocido, middlewares simples.                                                                                  |
| **zod**                                               | ^3.23.8                              | Validación de entradas y configuración; genera `docs/openapi.json`                     | Errores claros por campo; un test falla si la documentación queda desactualizada.                                        |
| **ws**                                                | ^8.22.0                              | WebSocket `/ws` para el estado de los documentos                                       | Autenticación en el primer mensaje y control del `Origin`.                                                               |
| **PostgreSQL + pgvector**                             | imagen `pgvector/pgvector:pg16`      | Datos, reglas de la base y vectores para el chat                                       | Una sola base para datos y embeddings; la base impide estados inválidos (por ejemplo, sesiones de una cuenta pendiente). |
| **Prisma**                                            | ^5.19.0                              | Cliente tipado de la base                                                              | Solo como cliente: el esquema lo manda SQL puro.                                                                         |
| **Redis** (ioredis) + **BullMQ**                      | `redis:7-alpine` · ^5.4.1 · ^5.12.0  | Cola de documentos, tareas programadas, límites de uso y eventos                       | El análisis no bloquea la subida; varias instancias comparten estado.                                                    |
| **Anthropic Claude** (`@anthropic-ai/sdk`)            | ^0.27.3                              | Extracción de conceptos, chat y resumen                                                | Detrás de un proveedor intercambiable (`AI_PROVIDER=mock` solo para E2E y carga).                                        |
| **Voyage AI**                                         | embeddings de 1024 dimensiones       | Búsqueda de fragmentos para el chat (RAG)                                              | Recomendado para Claude; se llama por HTTP.                                                                              |
| **pdf-parse** · **tesseract.js**                      | ^1.1.1 · ^5.1.1                      | Texto de los PDF y OCR de las imágenes (español)                                       | Sin servicios externos para leer documentos.                                                                             |
| **AWS SDK S3** (con **Cloudflare R2**)                | `@aws-sdk/client-s3` ^3.1146.0       | Documentos originales y fotos de perfil                                                | Interfaz de almacenamiento intercambiable; en local, disco.                                                              |
| **AWS SDK SES v2** (con **Amazon SES**)               | `@aws-sdk/client-sesv2` ^3.1146.0    | Invitaciones, recuperación, cambio de correo y avisos                                  | En desarrollo, `EMAIL_PROVIDER=mock` guarda los correos en una tabla.                                                    |
| **jsonwebtoken** · **bcrypt**                         | ^9.0.2 · ^6.0.0                      | Token de acceso de 15 min y contraseñas                                                | Token en memoria y renovación con cookie httpOnly rotativa.                                                              |
| **helmet** · **pino** · **prom-client**               | ^7.1.0 · ^10.3.1 · ^15.1.3           | Cabeceras de seguridad, logs sin datos sensibles y métricas                            | Operación: `/health`, `/ready` y `/metrics`.                                                                             |
| **Vite** · **pdf.js** · **web-vitals** (frontend)     | ^7.3.7 · 6.4.299 · ^6.2.2            | Build, visor del original y métricas de rendimiento reales                             | Visor sin plugins y medición de la experiencia en producción.                                                            |
| **Vitest** · **Supertest** · **Playwright** · **axe** | ^4.1.12 · ^7.3.0 · ^1.63.0 · ^4.13.0 | Pruebas unitarias, de integración, E2E y accesibilidad                                 | Integración contra una base de pruebas creada desde cero con las migraciones reales.                                     |
| **ESLint** · **Prettier**                             | ^10.11.0 · ^3.9.9                    | Reglas y formato                                                                       | La CI los exige.                                                                                                         |
| **GitHub Actions** · **gitleaks**                     | gitleaks `v8.21.2`                   | CI: lint, tipos, tests, build, `npm audit` y búsqueda de secretos                      | Nada llega a `main` sin pasar todo.                                                                                      |
| **Docker**                                            | `node:20-bookworm-slim`              | Una imagen para la API y el worker; PostgreSQL y Redis en desarrollo                   | El mismo artefacto en local y en Railway, sin usuario root.                                                              |
| **Railway** · **Vercel** · **Cloudflare**             | —                                    | API, worker, PostgreSQL y Redis en Railway; frontend en Vercel; DNS y R2 en Cloudflare | HTTPS automático y dominios propios.                                                                                     |

## 4. Qué necesita el profesor

### a) Opción recomendada: solo el navegador

- Un navegador actualizado: **Chrome, Edge o Firefox** de escritorio, con acceso a internet.
- La URL: <https://renta.jonarproyectos.com>. No hay que instalar nada, ni micrófono ni altavoces.
- **Para la cuenta de administrador:** una aplicación de códigos en el teléfono (Google
  Authenticator, Microsoft Authenticator o similar): la verificación en dos pasos es obligatoria.
- **Documentos de prueba:** un PDF **con texto** (por ejemplo, un certificado de ingresos) y una imagen
  JPG o PNG, de menos de 15 MB. Usa solo datos ficticios. El frontend trae un generador de archivos
  sintéticos (`node scripts\demo-files.mjs <carpeta>` en `renta-ia-frontend`); el estudiante puede
  enviártelos.
- **Para probar el tiempo real y los roles:** dos ventanas, una normal y otra de incógnito (cada una
  con su sesión).

Comprobación rápida: abre <https://api-renta.jonarproyectos.com/ready>. Debe mostrar
`{"status":"ready","checks":{"database":"ok","redis":"ok"}}`.

### b) Opción local (opcional)

Levanta todo en tu equipo con la IA y el correo **simulados** (no hace falta ninguna clave). Los
comandos son para `cmd.exe` en Windows y se probaron así.

**Requisitos:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) en ejecución,
[Node.js](https://nodejs.org/) 20 o superior, [Git](https://git-scm.com/) y los puertos libres 5433
(PostgreSQL), 6379 (Redis), 4000 (API) y 5173 (frontend). En Linux o macOS, los scripts `.sh` de la
base necesitan el cliente `psql`.

**1. Clona los tres repositorios en la misma carpeta** (los tests del backend leen
`..\renta-ia-database\migrations`):

```bat
mkdir renta-ia
cd renta-ia
git clone https://github.com/Jonar519/renta-ia-database.git
git clone https://github.com/Jonar519/renta-ia-backend.git
git clone https://github.com/Jonar519/renta-ia-frontend.git
```

**2. Base de datos** (tablas y datos de prueba):

```bat
cd renta-ia-database
docker compose up -d
scripts\migrate.bat
scripts\seed.bat
cd ..
```

Esperado: la migración llega hasta `026_concept_review.sql` (si la repites: `Listo: 0
migracion(es) nueva(s) aplicada(s).`) y el seed se puede cargar varias veces sin duplicar.

**3. Backend:**

```bat
cd renta-ia-backend
docker compose up -d
npm install
copy .env.example .env
npx prisma generate
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

En `.env`, pon el primer valor en `JWT_SECRET` y el segundo en `MFA_ENCRYPTION_KEY`, y deja la IA
simulada. Ejemplo de los valores de desarrollo:

```ini
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/renta_ia
CORS_ORIGIN=http://localhost:5173,http://localhost:4173
APP_URL=http://localhost:5173
AI_PROVIDER=mock
AI_MOCK_LATENCY_MS=1500
EMAIL_PROVIDER=mock
STORAGE_DRIVER=local
```

Arranca la API y el worker, cada uno en su ventana:

```bat
npm run dev
```

```bat
cd renta-ia\renta-ia-backend
npm run worker
```

Esperado: `Servidor escuchando en http://localhost:4000` y, en la otra ventana, el worker escuchando
la cola `document-processing`.

**4. Frontend** (otra ventana):

```bat
cd renta-ia\renta-ia-frontend
npm install
npm run dev
```

Esperado: `Local: http://localhost:5173/`.

**5. Comprueba que funciona:** <http://localhost:4000/ready> debe responder con `database` y `redis`
en `ok`; en <http://localhost:5173> entra con una cuenta del seed (están en el
[README de renta-ia-database](https://github.com/Jonar519/renta-ia-database#readme); solo existen en
local). La guía paso a paso con todo el detalle local está en
[docs/demo-fase5.md](docs/demo-fase5.md). En local, los correos no se envían: se guardan en la tabla
`email_outbox` (ver [Solución de problemas](#9-solución-de-problemas)), y la IA simulada extrae las
líneas "Etiqueta: $ monto" del PDF de prueba.

Para detener todo: **Ctrl+C** en cada ventana y `docker compose stop` en `renta-ia-database` y en
`renta-ia-backend`.

## 5. Acceso y roles

### Roles

| Rol                        | Qué puede hacer                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Contador**               | Crear y ver **sus** clientes, subir documentos, revisar conceptos, ver el original y la vista dividida, alertas, resumen y asistente de IA. No ve los clientes de otros contadores.    |
| **Asistente**              | Lo mismo con los clientes de **su** contador, sin crear ni borrar clientes.                                                                                                            |
| **Contribuyente** (portal) | Solo lectura de **su** expediente, y solo de lo ya revisado. Ve **Descargar** en vez del visor.                                                                                        |
| **Administrador**          | Invitar personas (Usuarios), reasignar los clientes de un contador a otro y ver el rendimiento web. Verificación en dos pasos obligatoria: hasta activarla, solo puede usar Seguridad. |

Un recurso de otro cliente responde **404** (no 403), para no revelar que existe. La interfaz oculta
lo que tu rol no puede hacer, pero quien decide es la API.

### Credenciales

Las credenciales **no** están en este README. El estudiante las entrega por un canal privado, o
envía **invitaciones por correo** a la dirección del profesor, idealmente una por rol (administrador,
contador y, si se quiere probar el portal, contribuyente):

<!-- ACCESO: lo completa el estudiante -->

- **Invitación por correo:** trae un enlace para activar la cuenta y elegir la contraseña (10 a 72
  caracteres, sin contraseñas comunes ni tu correo o tu nombre). El enlace **vence a las 72 horas** y
  sirve una sola vez.
- **Si la invitación venció:** en **Usuarios**, el administrador ve la invitación como **Vencida** y
  puede **Reenviar** (llega un enlace nuevo y el anterior deja de servir). Pídeselo al estudiante.
- **Si no llega el correo:** revisa spam. El correo está en modo de pruebas y solo entrega a
  direcciones verificadas por el estudiante (ver
  [Limitaciones](#8-limitaciones-conocidas-y-decisiones-de-diseño)).

### Verificación en dos pasos

- **Administrador: obligatoria.** En el primer ingreso la app lleva a **Seguridad**: confirma la
  contraseña → **Empezar** → escanea el QR (o escribe la clave) → escribe el código → **Activar**.
  Aparecen **10 códigos de recuperación** una sola vez (**Descargar (.txt)**); **Listo** se habilita al
  marcar que los guardaste.
- **Los demás roles: opcional**, en **Seguridad**.
- Al entrar con la verificación activa, después de la contraseña se pide el código de la app (o
  **Usar un código de recuperación**).

### Si algo del acceso falla

| Situación                          | Qué hacer                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Olvidaste la contraseña            | **¿Olvidaste tu contraseña?** → tu correo → **Enviar enlace**. El mensaje es el mismo exista o no la cuenta.                                                                   |
| La cuenta se bloqueó               | Tras 5 intentos fallidos el bloqueo dura 1, 2, 4… minutos (hasta 60); los códigos de verificación errados también cuentan. Espera y vuelve a intentar.                         |
| Perdiste el teléfono y los códigos | El administrador puede restablecer la verificación de tu cuenta (por la API); pídeselo al estudiante.                                                                          |
| La sesión se cerró sola            | El acceso dura 15 minutos y se renueva solo; cerrar sesiones desde **Seguridad**, restablecer la contraseña o activar la verificación invalida las demás sesiones al instante. |
