# 0014 — Excepciones temporales de `npm audit` (octubre 2026)

**Estado:** aceptada (auditoría de dependencias del 29-10-2026, aprobada por el usuario).
**Revisión:** body-parser el **2026-11-05** (**cerrada ese día**, ver abajo); zod y autocannon el
**2026-11-13** (decisión explícita antes de la entrega del 17 de noviembre: migrar o entregar con
la excepción declarada); minimatch el **2026-11-13**, o antes si eslint pide `minimatch` 11
(sección 4).

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

Quedaban tres avisos, que se aceptan aquí de forma temporal. El de body-parser se cerró el
2026-11-05 (sección 1). El 2026-11-05 se registró también `minimatch` (sección 4), solo de
desarrollo, como excepción aceptada por el usuario.

## Decisión

### 1. body-parser 1.20.8 — alto, producción (GHSA-27r3-jxmh-p828) — **cerrada el 2026-11-05**

- **Cierre (2026-11-05):** `npm update body-parser --before=2026-10-22T11:40:00Z`, sin override.
  El lockfile cambia en una sola entrada: `body-parser` 1.20.8 → **1.20.9** (publicada el
  2026-10-22 a las 11:38:27 UTC; 14 días cumplidos). `qs` sigue en 6.16.1: `--before` impide que
  entren 6.16.2 o 6.17.x, que aún no cumplen 14 días. `npm audit` ya no muestra este aviso.
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
- **Revisión (2026-11-13):** decisión explícita antes de la entrega del 17 de noviembre: migrar o
  entregar con la excepción declarada.

### 3. uuid 8.3.2 / hyperid 3.3.0 / autocannon 8.0.0 — moderado, solo desarrollo (GHSA-w5hq-g745-h8pq)

- **Aviso:** falta una comprobación de límites del buffer en uuid v3/v5/v6 cuando se pasa
  `buf`.
- **Por qué no se corrige:** `autocannon` solo se usa en las pruebas de carga (`loadtests/`) y
  no llega a producción. El "arreglo" de `npm audit fix --force` **bajaría** autocannon a 2.0.1,
  lo que no tiene sentido.
- **Revisión (2026-11-13):** comprobar si hay una versión de autocannon/hyperid que use
  `uuid >= 11.1.1`. Decisión explícita antes de la entrega del 17 de noviembre: migrar o
  entregar con la excepción declarada.

### 4. minimatch 10.2.6 — moderado, solo desarrollo (GHSA-g3hv-75wg-m249) — **excepción aceptada, revisión el 2026-11-13**

- **Aviso** (publicado el 2026-10-30): denegación de servicio por amplificación de `globparts`.
  Afecta a `>=7.0.0 <11.0.1`.
- **Dónde:** solo en desarrollo, por `eslint` 10.11.0 (`^10.2.5`), `@eslint/config-array` 0.23.5
  (`^10.2.4`) y `@typescript-eslint/typescript-estree` 8.70.1 (`^10.2.2`). Ya estaba en `main`
  (10.2.6, publicada el 2026-07-27); el paso de producción del CI (`--omit=dev`) no lo ve.
  Explica 10 de los 13 avisos moderados del `npm audit` completo (los otros 3 son la sección 3),
  porque se propaga a eslint y typescript-eslint. La copia `minimatch` 3.1.5 (por
  `ts-node-dev` → `rimraf` → `glob`) queda fuera del rango afectado.
- **Por qué no se corrige hoy:**
  - la única corrección es `11.0.1`, de una versión mayor que la que piden eslint y
    typescript-eslint. Haría falta un override a través de esa versión mayor;
  - además, `11.0.1` se publicó el 2026-10-27 y cumple 14 días el **2026-11-10**;
  - el "arreglo" de `npm audit fix --force` bajaría eslint y typescript-eslint. Se descarta.
- **Exposición:** `minimatch` solo procesa los globs de la configuración de eslint, que son del
  propio repo, no entradas de usuarios.
- **Decisión (aprobada por el usuario; registrada el 2026-11-05):** **excepción documentada**:
  moderado, solo de desarrollo y **sin overrides**. Es la misma decisión del 2026-11-04 para
  Atención (ADR 0012) y Cuaderno (ADR 0008).
- **Revisión (2026-11-13), o antes** si eslint pasa a pedir `minimatch` 11 y la versión
  corregida ya cumple 14 días (11.0.1, desde el 2026-11-10). La nueva versión de eslint también
  tiene que cumplir los 14 días, y sus transitivas igual.

## Alternativas consideradas

- **Instalar las versiones nuevas ya:** rompe la regla de 14 días, cuyo fin es no ser de los
  primeros en instalar una versión comprometida.
- **`npm audit fix --force`:** sube zod a 4.x y baja autocannon a 2.0.1 sin revisión. Se
  descarta.
- **Override de zod a 4.x:** rompería `zod-to-openapi` 7 y todos los esquemas. Se descarta.

## Consecuencias

- Desde la rama `ci/security-informativo`, el paso de `npm audit` de producción del job `security`
  (`npm audit --omit=dev --audit-level=moderate`) es **informativo** (`continue-on-error: true`).
  El job queda en verde aunque el audit siga mostrando body-parser y zod.
- **El log del paso sigue siendo la evidencia:** ahí se ven los avisos en cada push.
- **Sigue informativo hasta el 13-nov** (decisión del 2026-11-04). Cerrar body-parser el 5-nov
  no basta para volverlo bloqueante: zod (y `zod-to-openapi`, por depender de él) sigue siendo
  un aviso alto de producción y lo dejaría en rojo. Se decide el 13-nov, junto con zod. minimatch
  no cuenta para este paso, que usa `--omit=dev`.
- Cada fecha de revisión obliga a cerrar la excepción o renovarla por escrito.

## Evidencia

- `src/app.ts` (`express.json({ limit: "100kb" })`).
- `src/modules/metrics/metrics.routes.ts` (16 KB) y `metrics.schema.ts` (`.max(50)`).
- [threat-model.md](../threat-model.md), sección 4.
