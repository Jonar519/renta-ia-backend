# Informe de pruebas de carga

Todos los números salen de corridas ejecutadas el **2026-09-28** con los scripts de
`loadtests/`. Los JSON crudos (una respuesta = una muestra; percentiles exactos
por _nearest-rank_) están en `loadtests/results/`. Lo que no se midió se dice
explícitamente.

## Máquina y entorno

|                    |                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| CPU                | AMD Ryzen 9 7900 (12 núcleos, 24 hilos)                                                                                            |
| RAM                | 31,1 GB                                                                                                                            |
| SO                 | Windows 11 Pro (10.0.26200)                                                                                                        |
| Node               | v24.13.1                                                                                                                           |
| PostgreSQL         | 16.15 + pgvector (imagen `pgvector/pgvector:pg16`) en Docker Desktop 29.7.2                                                        |
| Redis              | 7.4.11 (imagen `redis:7-alpine`) en Docker Desktop, `maxmemory-policy noeviction`                                                  |
| API y worker       | build compilado (`node dist/...`), **un solo proceso** cada uno, `NODE_ENV=loadtest` (logs `combined` a archivo), `LOG_LEVEL=warn` |
| IA                 | `AI_PROVIDER=mock` con `AI_MOCK_LATENCY_MS=300` (latencia **simulada** por llamada)                                                |
| Generador de carga | autocannon 8 en la **misma máquina** (compite por CPU con la API)                                                                  |
| Base               | `renta_ia_e2e` con datos sintéticos de `loadtests/setup.mjs` (20 usuarios de login, 250 clientes para el listado)                  |
| Rate limiting      | `RATE_LIMIT_SCALE=1000` en todos los escenarios salvo el de rate limiting (límites reales)                                         |

Cada escenario de duración fija corrió **20 s**.

## Resultados

### Resumen

| Escenario                               | Conexiones | Solicitudes |     Throughput |          p50 |          p95 |          p99 | Errores |
| --------------------------------------- | ---------: | ----------: | -------------: | -----------: | -----------: | -----------: | ------: |
| Login — antes (bcryptjs)                |         20 |         394 |     19,6 req/s |     990,4 ms |    1209,7 ms |    1472,8 ms |     0 % |
| **Login — después (bcrypt nativo)**     |         20 |        1784 | **88,6 req/s** | **223,9 ms** | **233,6 ms** | **238,3 ms** |     0 % |
| Login — después, `UV_THREADPOOL_SIZE=8` |         20 |        3345 |    166,6 req/s |     118,9 ms |     137,1 ms |     140,9 ms |     0 % |
| Listado paginado — antes                |         50 |      26 334 |   1314,7 req/s |      37,4 ms |      46,6 ms |      52,3 ms |     0 % |
| Listado paginado — después              |         50 |      27 350 |   1365,5 req/s |      35,9 ms |      45,4 ms |      51,4 ms |     0 % |
| Chat IA (mock, 2 × 300 ms simulados)    |         20 |         580 |     28,8 req/s |     682,0 ms |     693,6 ms |     704,3 ms |     0 % |

El listado alterna la primera página (`limit=50`) y la segunda (con cursor) de
un contador con 250 clientes.

### Cuello de botella principal: bcrypt en el event loop

Escenario `mixed.mjs`: login (20 conexiones) y listado (50 conexiones) **a la vez**.

|                         | Listado: throughput | Listado: p50 |  Listado: p95 | Listado: p99 | Login: throughput | Login: p50 |
| ----------------------- | ------------------: | -----------: | ------------: | -----------: | ----------------: | ---------: |
| Antes (bcryptjs)        |         120,8 req/s |      98,9 ms | **1035,2 ms** |    1062,9 ms |        17,2 req/s |  1112,1 ms |
| Después (bcrypt nativo) |    **1154,5 req/s** |      42,6 ms |   **52,6 ms** |      57,4 ms |        72,9 req/s |   272,5 ms |

**Diagnóstico.** `bcryptjs` es JavaScript puro: cada `compare` (costo 10) ocupa
el hilo principal de Node. Con 20 logins concurrentes el event loop pasaba casi
todo el tiempo calculando hashes, así que **todas** las demás solicitudes
esperaban: el listado cayó de 1315 a 121 req/s y su p95 subió de 47 a 1035 ms.

**Arreglo** (commit `perf(auth): bcrypt nativo…`): `bcrypt` nativo, que calcula
el hash en el thread pool de libuv. Mismo formato de hash (`$2a$`/`$2b$`): las
contraseñas existentes siguen funcionando (`tests/unit/passwordHashing.test.ts`
verifica el hash del seed). Resultado: login ×4,5 (19,6 → 88,6 req/s) y, sobre
todo, el resto de la API ya no se degrada con logins concurrentes.

**Palanca adicional (no aplicada por defecto):** el login queda limitado por los
4 hilos por defecto del thread pool. Con `UV_THREADPOOL_SIZE=8` se midieron
166,6 req/s. Conviene ajustarlo al número de vCPU de la instancia de producción;
con 1–2 vCPU no aportaría.

### Cola de documentos: ráfaga de subidas y drenaje

`upload-burst.mjs`: 10 subidas simultáneas de PDFs sintéticos distintos; se
mide la latencia de cada subida y el tiempo hasta que la cola queda vacía
(`waiting + active = 0`, leído de `/metrics`). La concurrencia del worker se
cambia con `WORKER_CONCURRENCY` (un solo proceso worker).

| `WORKER_CONCURRENCY` | Documentos | Subida p50 / p95 / p99   | Todos encolados en | Cola vacía en | Documentos/s | Espera media en cola | Duración media por documento |
| -------------------: | ---------: | ------------------------ | -----------------: | ------------: | -----------: | -------------------: | ---------------------------: |
|                    1 |        100 | 114,0 / 383,4 / 430,7 ms |              1,6 s |        68,6 s |         1,46 |               33,1 s |                     678,8 ms |
|      2 (por defecto) |        100 | 112,6 / 146,5 / 378,0 ms |              1,3 s |        34,5 s |         2,90 |               16,1 s |                     681,0 ms |
|                    4 |        100 | 114,7 / 144,5 / 350,5 ms |              1,3 s |        17,4 s |         5,76 |                7,7 s |                     685,6 ms |
|                    8 |        100 | 114,7 / 151,0 / 390,1 ms |              1,3 s |         9,3 s |        10,81 |                3,4 s |                     687,1 ms |
|                   16 |        200 | 116,9 / 141,6 / 329,8 ms |              2,5 s |         9,4 s |        21,31 |                2,9 s |                     696,7 ms |

Duración media por etapa (métricas del worker, iguales en todas las corridas
±5 ms): extracción de texto 1,2–1,6 ms, conceptos (LLM simulado) ≈ 306 ms,
embeddings (simulado) ≈ 305 ms. Todas las subidas respondieron 201.

**Lectura.** Un documento pasa ~89 % del tiempo esperando a la IA (≈ 610 de 687 ms con concurrencia 8), así que
el drenaje escala casi linealmente con la concurrencia: el throughput siguió
creciendo hasta 16 (no se midió el uso de CPU ni de PostgreSQL durante las corridas). En producción el límite real será el **rate
limit de Anthropic y Voyage** de la cuenta, que **no se midió** (las pruebas
usan el proveedor simulado para no gastar crédito). Con la IA real, cada
documento tardará lo que tarden esas APIs, no 300 ms.

### Rate limiting (límites reales, `ratelimit.mjs`)

- **Límite global (300 solicitudes / 15 min por IP):** 350 `GET /api/clients`
  con 10 conexiones → **299 × 200 y 51 × 429** (la solicitud número 300 fue el
  login previo del mismo script, que también pasa por el límite global). Los 429
  responden en p50 7,3 ms (el total de la corrida: p95 9,8 ms, p99 34,3 ms).
- **Fuerza bruta en login (10 fallos / 15 min por IP):** 12 intentos fallidos con
  correos distintos → `401 × 10` y luego `429 × 2`.
- Los contadores viven en Redis (`rate-limit-redis`), así que el límite se
  comparte entre varias instancias de la API (no medido con varias instancias).

## Límites conocidos de estas mediciones

- **Una sola máquina:** generador, API, worker, PostgreSQL y Redis comparten los
  24 hilos; PostgreSQL y Redis corren dentro de la VM de Docker Desktop (WSL2).
  Los números absolutos no se trasladan a AWS; sirven para comparar antes/después
  y para encontrar cuellos de botella.
- **IA simulada:** no se midió la latencia ni los límites de Anthropic/Voyage.
- **No medido:** subidas grandes (se usaron PDFs de ~1 KB; el límite es 15 MB),
  OCR de imágenes (Tesseract), WebSocket con muchas conexiones simultáneas,
  varias instancias de la API detrás de un balanceador, y pruebas de resistencia
  de más de 20 s por escenario.
- El chat se midió sobre un cliente **sin documentos** (la búsqueda vectorial no
  devuelve fragmentos); con muchos embeddings, el costo de pgvector crecerá (no medido).

## Cómo reproducir (cmd.exe)

Ver `loadtests/README.md`.
