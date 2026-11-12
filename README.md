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
6. [Guía de pruebas función por función](#6-guía-de-pruebas-función-por-función)
7. [Pruebas automatizadas](#7-pruebas-automatizadas)
8. [Limitaciones conocidas y decisiones de diseño](#8-limitaciones-conocidas-y-decisiones-de-diseño)
9. [Solución de problemas](#9-solución-de-problemas)
10. [Estructura del repositorio](#10-estructura-del-repositorio)
11. [Glosario](#11-glosario)

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
[Node.js](https://nodejs.org/) 24 (el backend funciona desde Node 20, pero las pruebas del frontend usan Node 24, como su CI), [Git](https://git-scm.com/) y los puertos libres 5433
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

## 6. Guía de pruebas función por función

Un recorrido de unos **25 minutos** en producción, en este orden. La columna **Depende de** indica si
la función usa un servicio externo (si ese servicio falla, la función puede fallar sin que sea un
error del proyecto); "No" significa que solo usa la API, la base y Redis propios.

**Preparación:** ventana A (normal) con la cuenta de **contador**; ventana B (incógnito) con la de
**administrador** (y, para el portal, la de contribuyente). Ten a mano el PDF con texto y la imagen
de prueba. La base de producción no trae datos de ejemplo: el contador empieza sin clientes.

### A. Entrar (2 min)

| Función                          | Qué hace                                   | Pasos para probarla                                                    | Resultado esperado                                                                                                                                         | Depende de |
| -------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A1. Pantalla de inicio           | Presenta el producto y el inicio de sesión | Abre <https://renta.jonarproyectos.com>                                | **Inicia sesión** con correo y contraseña, **¿Olvidaste tu contraseña?**, el aviso de que las cuentas las crea el administrador y "La IA lee. Tú decides." | No         |
| A2. Entrar con dos pasos (admin) | Contraseña y código                        | En la ventana B entra como administrador → escribe el código de la app | Llegas a la app; si la verificación aún no estaba activa, te lleva a **Seguridad** para activarla antes de todo lo demás.                                  | No         |
| A3. Entrar como contador         | Sesión normal                              | En la ventana A entra como contador; recarga (F5)                      | **Tus clientes**; tras recargar, la sesión sigue (se renovó con la cookie).                                                                                | No         |

### B. Clientes y documentos (6 min)

| Función                                 | Qué hace                                                | Pasos para probarla                                                                                                                           | Resultado esperado                                                                                                                                                         | Depende de                         |
| --------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| B1. Crear un cliente                    | Alta de un contribuyente del contador                   | **Nuevo cliente** → nombre, documento (solo números, letras, puntos y guiones) y correo ficticios → **Guardar cliente**                       | Aparece en **Tus clientes contribuyentes** con **Ver detalle**.                                                                                                            | No                                 |
| B2. Densidad de la tabla                | Filas cómodas o compactas, recordadas en tu perfil      | **Densidad de la tabla** → **Compacta**                                                                                                       | La tabla se compacta; al volver a entrar sigue igual.                                                                                                                      | No                                 |
| B3. Subir y analizar un documento       | Guarda el archivo y lo analiza en segundo plano         | **Ver detalle** del cliente → pestaña **Documentos** → **Tipo de documento** (Certificado de ingresos) → el PDF → **Subir y analizar con IA** | "Documento subido. El análisis con IA corre en segundo plano." El estado pasa de **Procesando** a **Procesado** **sin recargar** (arriba: "Actualización en tiempo real"). | IA (Claude, Voyage), Archivos (R2) |
| B4. Duplicados                          | Detecta el mismo archivo por su huella antes de subirlo | Sube otra vez el mismo PDF                                                                                                                    | "Este archivo ya se subió como "…" (fecha); no se volvió a subir."                                                                                                         | No                                 |
| B5. Imagen con OCR                      | Lee el texto de una foto                                | Sube la imagen JPG o PNG                                                                                                                      | Se procesa con OCR; si no tiene cifras tributarias, el documento queda procesado sin conceptos.                                                                            | IA (Claude, Voyage)                |
| B6. Conceptos y totales                 | Cifras extraídas por la IA, por año gravable            | Mira **Conceptos tributarios extraídos**                                                                                                      | **Totales por año gravable** (ingreso bruto, retención, deducción, aportes) y cada concepto con **Extraído por IA · sin revisar** y **Revisar**.                           | No                                 |
| B7. Ver el original y la vista dividida | El documento al lado de sus conceptos                   | **Ver original** en el PDF (con una ventana de 1200 px o más)                                                                                 | El visor a la izquierda (**Acercar**, **Alejar**, páginas) y a la derecha solo los conceptos de ese documento. **Escape** o **Cerrar** vuelve a la vista completa.         | Archivos (R2)                      |
| B8. Revisar un concepto                 | Confirmación humana de lo que leyó la IA                | En un concepto, **Revisar** → escribe el **Monto revisado (COP)** → **Confirmar**                                                             | "Concepto revisado."; deja de decir "sin revisar" y los totales se recalculan. Queda quién y cuándo, y se conserva lo que leyó la IA.                                      | No                                 |
| B9. Reprocesar con revisiones           | Protege lo ya revisado                                  | En un documento con conceptos revisados, **Reintentar análisis**                                                                              | Pide confirmación: **¿Descartar las revisiones?** con **Descartar revisiones y reprocesar**. Sin confirmar, no se pierde nada.                                             | IA (Claude, Voyage)                |

### C. Alertas, resumen y asistente de IA (5 min)

| Función             | Qué hace                                   | Pasos para probarla                                                                | Resultado esperado                                                                                                                                                                        | Depende de          |
| ------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| C1. Alertas         | Vencimientos e inconsistencias del cliente | Pestaña **Alertas**                                                                | La lista de alertas del cliente (o "No hay alertas para este cliente."). Cada una se puede **Marcar como vista** o **Resolver**. Las fechas del calendario son de ejemplo y lo advierten. | No                  |
| C2. Resumen         | Estimación simplificada del impuesto       | Pestaña **Resumen** → **Generar resumen**                                          | Un resumen ejecutivo con ingresos brutos, deducciones, retenciones, aportes, **Impuesto estimado** y el saldo estimado a pagar o a favor, rotulado como estimación simplificada.          | IA (Claude)         |
| C3. Asistente de IA | Responde con los documentos de ese cliente | Pestaña **Asistente IA** → "¿Cuál fue el ingreso bruto reportado?" → **Preguntar** | "Pensando…" y luego una respuesta basada en los documentos del cliente. Sobre otro cliente o un tema ajeno, no inventa.                                                                   | IA (Claude, Voyage) |

### D. Roles y aislamiento (3 min)

| Función                          | Qué hace                                        | Pasos para probarla                                                                                                | Resultado esperado                                                                                                           | Depende de |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------- |
| D1. Aislamiento entre contadores | Un contador no ve los clientes de otro          | Copia la dirección del detalle de un cliente y ábrela con otra cuenta de contador (o con el contribuyente de otro) | No se muestra el cliente: la API responde 404 (no 403) para no revelar que existe.                                           | No         |
| D2. Portal del contribuyente     | Solo lectura de su expediente, solo lo revisado | Entra con la cuenta de contribuyente                                                                               | Ve su expediente sin **Nuevo cliente** ni **Subir documento**; solo los conceptos revisados; **Descargar** en vez del visor. | No         |
| D3. Guardas de la interfaz       | Las secciones de admin no se abren con otro rol | Con la cuenta de contador, escribe `https://renta.jonarproyectos.com/#/admin/users`                                | Vuelves a la app con un aviso; la API respondería 403.                                                                       | No         |

### E. Administración (4 min)

En la ventana B, como administrador.

| Función                        | Qué hace                                         | Pasos para probarla                                                                                                                                                                                    | Resultado esperado                                                                                                  | Depende de   |
| ------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------ |
| E1. Invitar a una persona      | Única forma de crear cuentas                     | **Usuarios** → **Invitar a una persona** → nombre, un correo tuyo verificado por el estudiante y el rol (para un asistente, su contador; para un contribuyente, su expediente) → **Enviar invitación** | Aparece en **Invitaciones pendientes** con su vencimiento (72 h). El enlace no se muestra: llega solo al correo.    | Correo (SES) |
| E2. Activar la cuenta invitada | La persona elige su contraseña                   | Abre el enlace del correo en otra ventana de incógnito                                                                                                                                                 | Pantalla de activación con su nombre; tras elegir la contraseña entra a la app. El mismo enlace no sirve dos veces. | Correo (SES) |
| E3. Reenviar o cancelar        | Enlace nuevo / invitación anulada                | En una pendiente: **Reenviar**, o cancelar (**¿Cancelar la invitación?**)                                                                                                                              | Reenviar invalida el enlace anterior; cancelar quita la cuenta pendiente. Las vencidas dicen **Vencida**.           | Correo (SES) |
| E4. Reasignar clientes         | Pasa todos los clientes de un contador a otro    | **Reasignar clientes** → elige el contador de origen y el de destino → **Reasignar** → confirma                                                                                                        | Los clientes pasan al otro contador. Con un solo contador activo, explica que hace falta otro.                      | No           |
| E5. Rendimiento                | Métricas web reales de los usuarios (Web Vitals) | **Rendimiento** → cambia el periodo (Últimas 24 horas, 7 o 30 días)                                                                                                                                    | Percentil 75 de cada métrica por ruta y dispositivo, con el número de muestras.                                     | No           |

### F. Tu cuenta (4 min)

Menú de usuario → **Mi perfil** y **Seguridad**.

| Función                       | Qué hace                                                 | Pasos para probarla                                                                                        | Resultado esperado                                                                                                                                                                      | Depende de    |
| ----------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| F1. Datos y foto              | Nombre, teléfono y foto                                  | **Mi perfil** → cambia el teléfono → **Guardar**; **Foto de perfil** → elige una imagen → **Guardar foto** | Se guarda; la foto aparece en el menú (sin los metadatos de la imagen original). **Quitar foto** la borra.                                                                              | Archivos (R2) |
| F2. Cambiar el correo         | Confirma la dirección nueva por correo                   | En **Mi perfil**, correo nuevo y tu contraseña                                                             | "Esperando confirmación de …": llega un enlace (24 h) al correo nuevo y un aviso al anterior.                                                                                           | Correo (SES)  |
| F3. Cambiar la contraseña     | Pide la actual                                           | En **Mi perfil**, actual y nueva                                                                           | Confirmación por pantalla y por correo; las demás sesiones se cierran.                                                                                                                  | Correo (SES)  |
| F4. Verificación en dos pasos | Activar, regenerar códigos o desactivar (salvo el admin) | **Seguridad** → **Verificación en dos pasos**                                                              | Con la verificación activa: **Generar códigos de recuperación nuevos** ("Los anteriores dejarán de servir.") y, si no eres admin, **Desactivar**.                                       | No            |
| F5. Sesiones activas          | Ver y cerrar sesiones en otros dispositivos              | Entra con la misma cuenta en otro navegador; en **Seguridad → Sesiones activas**                           | Cada sesión con equipo, **Ubicación aproximada** y última actividad; la actual dice **Esta sesión**. Cerrar las demás saca al otro navegador al instante.                               | No            |
| F6. Recuperar la contraseña   | Enlace de un solo uso, sin revelar si la cuenta existe   | **Salir** → **¿Olvidaste tu contraseña?** → tu correo → **Enviar enlace**                                  | "Revisa tu correo" (el mismo mensaje exista o no la cuenta); el enlace lleva a elegir una contraseña nueva y cierra todas las sesiones.                                                 | Correo (SES)  |
| F7. Mis datos                 | Exportar y eliminar la cuenta                            | **Mi perfil → Tus datos** → **Descargar mis datos** (pide la contraseña)                                   | Un JSON con tus datos, sin secretos. **Eliminar mi cuenta** deja una lápida anónima; un contador con clientes o el único admin no pueden. **No lo hagas con una cuenta que necesites.** | No            |

### G. Robustez y seguridad (1 min, opcional)

| Función                          | Qué hace                                           | Pasos para probarla                                                | Resultado esperado                                                                                                             | Depende de |
| -------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| G1. Sin conexión                 | El Service Worker sirve el armazón de la app       | F12 → **Red** → **Sin conexión** → recarga                         | La app carga desde la caché; las respuestas de la API nunca pasan por la caché del Service Worker (`Cache-Control: no-store`). | No         |
| G2. Ningún token en el navegador | La sesión vive en memoria y en una cookie httpOnly | F12 → **Aplicación** → almacenamiento local y de sesión            | Sin tokens: solo una pista de sesión (id, nombre y rol) que no sirve para llamar a la API.                                     | No         |
| G3. Tiempo real                  | Eventos por `wss://api-renta…`                     | F12 → **Red** → filtro **WS** con el detalle de un cliente abierto | Una conexión a `wss://api-renta.jonarproyectos.com/ws` que recibe el cambio de estado de los documentos.                       | No         |
| G4. Salud del servicio           | Sondas de la plataforma                            | Abre <https://api-renta.jonarproyectos.com/health> y `/ready`      | `{"status":"ok",…}` y `/ready` con `database` y `redis` en `ok`.                                                               | No         |

### Funciones sin pantalla (se evalúan por los tests o la documentación)

| Función                                                         | Dónde está                                                   | Cómo se comprueba                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Restablecer la verificación en dos pasos de una cuenta (admin)  | `DELETE /api/admin/users/:userId/mfa`                        | Tests de integración · [referencia técnica](docs/referencia-tecnica.md#endpoints) |
| Editar o borrar un cliente                                      | `PATCH` y `DELETE /api/clients/:id`                          | Tests de integración                                                              |
| Auditoría (sin datos sensibles)                                 | `GET /api/admin/audit`, tabla `audit_log`                    | Tests de integración                                                              |
| Ejecutar los vencimientos a mano (admin) y la tarea diaria      | `POST /api/alerts/deadlines/run`; worker a las 6:00 (Bogotá) | Tests de integración                                                              |
| Retención y purga diaria de datos                               | Worker                                                       | [docs/data-retention.md](docs/data-retention.md)                                  |
| Límites de uso y bloqueo progresivo                             | Redis                                                        | Tests de integración · [docs/threat-model.md](docs/threat-model.md)               |
| Métricas Prometheus y documentación interactiva de la API       | `GET /metrics` con token; `GET /docs` (fuera de producción)  | [Referencia técnica](docs/referencia-tecnica.md#observabilidad-y-operación)       |
| Primer administrador en producción y verificación de la IA real | `npm run admin:crear`, `npm run ai:verify`                   | [Referencia técnica](docs/referencia-tecnica.md#sesión-y-seguridad)               |

## 7. Pruebas automatizadas

Necesitan la opción local (Docker con el PostgreSQL de `renta-ia-database`). Las del backend crean
desde cero la base `renta_ia_test` con las migraciones reales (nunca tocan `renta_ia`); Redis,
Anthropic y Voyage están simulados.

| Repositorio         | Comando                                                          | Qué cubre                                                                                                                                                                                                                                                                                         | Resultado esperado                                             |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `renta-ia-backend`  | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` | Unitarias y de integración con Supertest: sesión y CSRF, bloqueo, roles y aislamiento por cliente (404), invitaciones, MFA, perfil, sesiones, mis datos, documentos y archivo original, revisión de conceptos, pipeline de IA con proveedor simulado, tiempo real, alertas, OpenAPI al día, caché | `Tests 515 passed (515)` en 58 archivos y build sin errores.   |
| `renta-ia-frontend` | `npm run lint`, `npm test`, `npm run build`                      | Sesión, router y guardas, vistas de clientes y documentos, visor, revisión, estados de carga y error, Service Worker, accesibilidad                                                                                                                                                               | `Tests 259 passed (259)` en 30 archivos.                       |
| `renta-ia-frontend` | `npm run test:e2e`                                               | Playwright + axe contra el sistema completo                                                                                                                                                                                                                                                       | Todos en verde.                                                |
| `renta-ia-database` | `scripts\migrate.bat` dos veces y `scripts\seed.bat` dos veces   | Migraciones sobre una base vacía (la segunda corrida no aplica nada) y seed idempotente                                                                                                                                                                                                           | `Listo: 0 migracion(es) nueva(s) aplicada(s).` la segunda vez. |

La **CI** (GitHub Actions) corre todo esto en cada `push`, más `npm audit` y gitleaks; las excepciones
vigentes de `npm audit` están en el [ADR 0014](docs/adr/0014-excepciones-npm-audit-octubre-2026.md).
Las pruebas de carga y sus mediciones: [docs/load-test-report.md](docs/load-test-report.md).

## 8. Limitaciones conocidas y decisiones de diseño

- **Correo en modo de pruebas.** Amazon SES está en modo _sandbox_: solo entrega a direcciones
  verificadas por el estudiante. Invitaciones, recuperación de contraseña y cambio de correo solo
  llegan a esas direcciones.
- **Producción sin datos de ejemplo.** El seed no se carga en producción: el contador empieza sin
  clientes y la primera cuenta de administrador se creó con `npm run admin:crear`.
- **Calendario tributario de ejemplo.** Las fechas de vencimiento (`src/config/tax-calendar.json`) son
  de ejemplo y cada alerta lo advierte; habría que reemplazarlas por el calendario oficial de la DIAN.
- **Estimación simplificada.** El resumen calcula una estimación del impuesto, no una declaración.
- **IA no determinista.** En producción las cifras y respuestas las genera Claude: pueden variar y
  pueden equivocarse; por eso todo lo extraído queda **sin revisar** hasta que una persona lo
  confirma, y el portal solo muestra lo revisado.
- **PDF escaneados.** Un PDF sin texto (una imagen escaneada dentro de un PDF) termina en error con un
  mensaje que pide subirlo como imagen (JPG o PNG), que sí pasa por OCR.
- **Fallos parciales.** La extracción de conceptos y los embeddings fallan por separado: el documento
  queda procesado con advertencias y se puede reintentar.
- **Sin pantalla para algunas acciones de administración:** restablecer la verificación en dos pasos de
  una cuenta, editar o borrar un cliente y consultar la auditoría se hacen por la API.
- **Ubicación de las sesiones:** se estima en el servidor con una base local de rangos de IP (la IP no
  sale); sin esa base, aparece sin ciudad.
- **Sin registro público** y **verificación obligatoria para el administrador:** decisiones de diseño.

## 9. Solución de problemas

| Síntoma                                       | Qué hacer                                                                                                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| La página no carga                            | Abre <https://api-renta.jonarproyectos.com/ready>. Si no responde, avisa al estudiante. Si responde, recarga con Ctrl+F5 o prueba en incógnito.                                                 |
| "Hay una versión nueva de Renta IA."          | Pulsa **Recargar**: el Service Worker tiene una versión más reciente de la app.                                                                                                                 |
| La sesión expiró o vuelve al inicio de sesión | Vuelve a entrar. Pasa si cerraste sesiones desde **Seguridad**, restableciste la contraseña o activaste la verificación.                                                                        |
| No llega el correo                            | Revisa spam. Solo llega a direcciones verificadas ([Limitaciones](#8-limitaciones-conocidas-y-decisiones-de-diseño)). Pide al estudiante un **Reenviar**.                                       |
| El documento se queda en **Procesando**       | El worker o la IA pueden tardar unos segundos (OCR e IA real). Si termina en error o con advertencias, usa **Reintentar análisis**.                                                             |
| El documento termina en error                 | Si es un PDF escaneado, súbelo como imagen. Revisa que pese menos de 15 MB y sea PDF, JPG o PNG.                                                                                                |
| No hay conceptos ni alertas                   | El documento no tenía cifras reconocibles; prueba con un PDF de certificado con texto.                                                                                                          |
| El asistente de IA no responde                | Pulsa **Reintentar**. Responde solo con los documentos ya procesados de ese cliente.                                                                                                            |
| La cuenta se bloqueó                          | Tras 5 intentos fallidos, espera unos minutos (el bloqueo crece: 1, 2, 4… hasta 60).                                                                                                            |
| Local: la API no arranca                      | Revisa `.env`: `JWT_SECRET` definido, PostgreSQL en 5433 y Redis en 6379 (`docker compose up -d` en los dos repositorios).                                                                      |
| Local: el análisis falla con la IA            | Sin claves de Anthropic y Voyage, deja `AI_PROVIDER=mock`.                                                                                                                                      |
| Local: no llega ningún correo                 | En local no se envían: `docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT created_at, to_address, template, body_text FROM email_outbox ORDER BY created_at DESC LIMIT 1"`. |
| Local: `prisma generate` falla con `EPERM`    | Detén la API y el worker (tienen abierta la librería de Prisma) y repite.                                                                                                                       |

## 10. Estructura del repositorio

```
renta-ia-backend/
├── src/
│   ├── app.ts · server.ts       # arranque, middlewares y apagado ordenado
│   ├── config/                  # variables validadas, logger, Prisma, Redis, calendario y reglas tributarias
│   ├── middlewares/             # autenticación, alcance por rol, CSRF, validación, límites, errores
│   ├── modules/                 # auth, invitations, mfa, users, admin, clients, documents, alerts, ai, metrics
│   ├── services/                # llm, storage, audit, email, geoip, retention, access, events
│   ├── realtime/                # WebSocket /ws
│   ├── queues/ · workers/       # cola de documentos y tareas programadas (BullMQ)
│   ├── observability/ · lifecycle/   # /health, /ready, métricas y apagado
│   ├── docs/                    # generador de OpenAPI
│   └── scripts/                 # primer administrador, verificación de la IA real
├── tests/unit · tests/integration
├── prisma/schema.prisma         # cliente de base de datos (el esquema lo manda renta-ia-database)
├── loadtests/                   # pruebas de carga
├── docs/                        # referencia técnica, guía de prueba, ADR, amenazas, retención, carga, OpenAPI
└── Dockerfile · docker-compose.yml (Redis local)
```

Los otros repositorios describen su estructura en su propio README:
[renta-ia-frontend](https://github.com/Jonar519/renta-ia-frontend#readme) y
[renta-ia-database](https://github.com/Jonar519/renta-ia-database#readme).

## 11. Glosario

| Término                             | Qué significa aquí                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **API REST**                        | Las direcciones del servidor (`/api/...`) que la app llama con métodos HTTP y que responden JSON.                 |
| **Worker / cola**                   | Proceso aparte que analiza los documentos en segundo plano, tomándolos de una cola en Redis.                      |
| **OCR**                             | Reconocimiento del texto de una imagen.                                                                           |
| **LLM**                             | Modelo de lenguaje (aquí, Claude) que lee el texto y extrae las cifras o responde preguntas.                      |
| **Embedding / pgvector**            | Lista de números que representa el significado de un texto / extensión de PostgreSQL que los guarda y compara.    |
| **RAG**                             | Antes de responder, se buscan los fragmentos relevantes de los documentos del cliente y la IA responde con ellos. |
| **Concepto tributario**             | Una cifra relevante para la renta (ingreso bruto, retención, deducción, aporte) con su año gravable.              |
| **Huella (SHA-256)**                | Resumen único del contenido de un archivo; sirve para detectar que ya se subió.                                   |
| **WebSocket**                       | Conexión abierta para que el servidor avise al navegador al instante.                                             |
| **MFA / verificación en dos pasos** | Además de la contraseña, un código de 6 dígitos de una app del teléfono (TOTP) o un código de recuperación.       |
| **Cookie httpOnly**                 | Cookie que el JavaScript de la página no puede leer: protege la sesión ante un script inyectado.                  |
| **CSRF**                            | Ataque desde otro sitio con tu sesión; se bloquea exigiendo una cabecera que solo la app envía.                   |
| **Service Worker**                  | Script del navegador que guarda la app para que cargue sin conexión.                                              |
| **Web Vitals**                      | Métricas de la experiencia real en el navegador (carga, interacción, estabilidad visual).                         |
| **Lápida**                          | Cuenta eliminada que pierde sus datos personales y conserva solo lo necesario para la integridad.                 |
| **E2E**                             | Prueba de punta a punta: un navegador automatizado usa la aplicación completa.                                    |
| **ADR**                             | Documento corto que registra una decisión técnica, sus alternativas y por qué se eligió.                          |
