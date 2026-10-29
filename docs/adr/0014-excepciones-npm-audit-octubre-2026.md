# 0014 — Excepciones temporales de `npm audit` (octubre 2026)

**Estado:** aceptada (auditoría de dependencias del 29-10-2026, aprobada por el usuario).
**Revisión:** body-parser el **2026-11-05**; zod y autocannon el **2026-11-30**.

## Contexto

La auditoría del 29-10-2026 (`npm audit`) encontró avisos que no se pueden corregir hoy sin
romper una de estas dos reglas:

- **Regla de 14 días:** toda versión nueva que entra al lockfile debe llevar al menos 14 días
  publicada en npm (también las transitivas).
- **Sin cambios mayores a ciegas:** una versión mayor de una dependencia de producción exige su
  propia migración y pruebas.

En la rama `chore/audit-oct` ya se corrigió lo que cumplía ambas reglas:

- `ip-address` 10.7.4 y `qs` 6.16.1 (solo lockfile).
- `vite` 7.3.7 (override).
- `vitest` 4.1.12, que quita el crítico de `tinypool` (vitest 4 ya no lo usa) y el moderado de
  `@vitest/mocker`.

Quedan tres avisos, que se aceptan aquí de forma temporal.

## Decisión

### 1. body-parser 1.20.8 — alto, producción (GHSA-27r3-jxmh-p828)

- **Aviso:** denegación de servicio con bytes sobrantes después de un cuerpo comprimido.
- **Por qué no se corrige hoy:** la corrección, `1.20.9`, se publicó el 2026-10-22 y cumple 14
  días el **2026-11-05**.
- **Cómo se corregirá:** `express` 4.22.3 pide `~1.20.5`, así que basta con
  `npm update body-parser` (solo el lockfile, sin override).
- **Mitigación mientras tanto:** `express.json({ limit: "100kb" })` (`src/app.ts`) acota el
  tamaño del cuerpo. Además, el límite global por IP (300 / 15 min) frena la repetición. Esto
  reduce el impacto, pero no lo elimina.

### 2. zod 3.25.76 — alto, producción (GHSA-mrhx-c7xc-m3w5)

Incluye también `@asteasolutions/zod-to-openapi` 7.3.4, que se marca alto solo porque depende
de zod.

- **Aviso:** validar colecciones muy grandes con restricciones puede agotar la memoria.
- **Por qué no se corrige hoy:** no hay corrección en zod 3. La primera versión corregida es
  `4.6.6` (versión mayor), que además obliga a subir `@asteasolutions/zod-to-openapi` a `9.1.0`
  (pide `zod ^4`). Hay 20 archivos con esquemas zod: es una migración aparte, no un parche.
- **Mitigación mientras tanto:**
  - Todo cuerpo JSON se corta en 100 KB, y `POST /api/metrics/web-vitals` en 16 KB.
  - Revisión de los arrays y records zod del código (29-10-2026). Solo
    `metrics.schema.ts` (`entries`) valida un array que llega de un cliente HTTP, y tiene
    `.max(50)`. Los que no tienen `.max()` validan datos de confianza, no peticiones:
    - `src/config/taxConfig.ts`: `declaracionRentaPersonasNaturales` (record y su array),
      `uvtPorAnioGravable` (record) y `tablaArt241` (array). Es configuración leída al arrancar
      desde un archivo del propio servidor.
    - `src/docs/openapi.ts`: solo documentan respuestas para el OpenAPI y no validan
      peticiones.
- **Revisión (2026-11-30):** decidir la fecha de la migración a zod 4 o renovar esta excepción
  con nueva fecha.

### 3. uuid 8.3.2 / hyperid 3.3.0 / autocannon 8.0.0 — moderado, solo desarrollo (GHSA-w5hq-g745-h8pq)

- **Aviso:** falta una comprobación de límites del buffer en uuid v3/v5/v6 cuando se pasa
  `buf`.
- **Por qué no se corrige:** `autocannon` solo se usa en las pruebas de carga (`loadtests/`) y
  no llega a producción. El "arreglo" de `npm audit fix --force` **bajaría** autocannon a 2.0.1,
  lo que no tiene sentido.
- **Revisión (2026-11-30):** comprobar si hay una versión de autocannon/hyperid que use
  `uuid >= 11.1.1`.

## Alternativas consideradas

- **Instalar las versiones nuevas ya:** rompe la regla de 14 días, cuyo fin es no ser de los
  primeros en instalar una versión comprometida.
- **`npm audit fix --force`:** sube zod a 4.x y baja autocannon a 2.0.1 sin revisión. Se
  descarta.
- **Override de zod a 4.x:** rompería `zod-to-openapi` 7 y todos los esquemas. Se descarta.

## Consecuencias

- El job `security` del CI (`npm audit --omit=dev --audit-level=moderate`) **seguirá fallando**
  por body-parser y zod hasta que se cierren estas excepciones. Es esperado y no debe
  silenciarse.
- Cada fecha de revisión obliga a cerrar la excepción o renovarla por escrito.

## Evidencia

- `src/app.ts` (`express.json({ limit: "100kb" })`).
- `src/modules/metrics/metrics.routes.ts` (16 KB) y `metrics.schema.ts` (`.max(50)`).
- [threat-model.md](../threat-model.md), sección 4.
