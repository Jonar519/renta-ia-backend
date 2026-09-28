# Pruebas de carga (autocannon)

Resultados e interpretación: `docs/load-test-report.md`. Los JSON de cada corrida
quedan en `loadtests/results/`.

> Usa SIEMPRE una base de pruebas (por ejemplo `renta_ia_e2e`) y una base de Redis
> aparte (`/3`): `setup.mjs` crea usuarios y clientes sintéticos, y las ráfagas
> llenan la cola.

## 1. Arrancar una API y un worker de pruebas (cmd.exe)

Una ventana para la API (puerto 4300, IA simulada, límites ×1000):

```bat
cd renta-ia-backend
npm run build
set NODE_ENV=loadtest
set AI_PROVIDER=mock
set AI_MOCK_LATENCY_MS=300
set DATABASE_URL=postgresql://postgres:postgres@localhost:5433/renta_ia_e2e
set REDIS_URL=redis://localhost:6379/3
set METRICS_TOKEN=token-de-carga
set WORKER_METRICS_PORT=9466
set PORT=4300
set LOG_LEVEL=warn
set RATE_LIMIT_SCALE=1000
node dist\server.js > %TEMP%\lt-api.log 2>&1
```

Otra ventana para el worker (mismas variables, sin `PORT`), eligiendo la concurrencia:

```bat
set WORKER_CONCURRENCY=4
node dist\workers\documentProcessing.worker.js > %TEMP%\lt-worker.log 2>&1
```

`AI_PROVIDER=mock` es solo para pruebas: la API se niega a arrancar con él si
`NODE_ENV=production`. Lo mismo `RATE_LIMIT_SCALE`.

## 2. Datos sintéticos

```bat
npm run loadtest:setup
```

Crea 20 usuarios para login, un contador con 250 clientes, un usuario de chat y
uno de subidas, y guarda sus correos en `loadtests\.state.json` (ignorado por git).

## 3. Escenarios

En una tercera ventana (`set LOADTEST_API_URL=http://localhost:4300` si usas otro puerto):

```bat
npm run loadtest:login
npm run loadtest:list
npm run loadtest:mixed
set LOADTEST_AI_MOCK_LATENCY_MS=300
npm run loadtest:chat
set METRICS_TOKEN=token-de-carga
set LOADTEST_WORKER_METRICS_URL=http://localhost:9466/metrics
set LOADTEST_WORKER_CONCURRENCY=4
npm run loadtest:upload
```

Variables útiles: `LOADTEST_DURATION` (segundos, por defecto 20),
`LOADTEST_CONNECTIONS`, `LOADTEST_UPLOADS` (por defecto 100) y `LOADTEST_LABEL`
(sufijo del archivo de resultados, p. ej. `antes` / `despues`).

## 4. Rate limiting con los límites reales

Reinicia la API **sin** `RATE_LIMIT_SCALE` y ejecuta:

```bat
set LOADTEST_REDIS_URL=redis://localhost:6379/3
npm run loadtest:ratelimit
```

El script borra los contadores `rl:*` de esa base de Redis antes y después.
