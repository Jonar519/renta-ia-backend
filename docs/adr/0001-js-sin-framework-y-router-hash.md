# 0001 — Frontend en JavaScript sin framework, con router por hash

**Estado:** aceptada.

## Contexto

La materia (Programación orientada a la web) evalúa el dominio de la plataforma:
DOM, eventos, `fetch`, History/URL, Web Workers, Service Workers, IndexedDB,
accesibilidad y rendimiento. La interfaz tiene pocas vistas (login, lista de
clientes, detalle con pestañas, rendimiento) y un equipo de una persona.

## Decisión

- **JavaScript moderno (módulos ES) sin framework**, empaquetado con Vite solo
  para el build (hash de contenido, code-splitting, minificado).
- **Router por hash** (`#/clients/:id`) propio: `src/router.js` (registro de
  rutas con parámetros, vistas asíncronas, cancelación de peticiones y limpieza
  de suscripciones al cambiar de vista, foco en el `<h1>` para lectores de pantalla).
- Estado mínimo en `src/state/store.js` (suscripción simple).

## Alternativas consideradas

- **React/Vue/Svelte:** resuelven reactividad y componentes, pero ocultan
  justamente lo que se quiere demostrar y agregan dependencias y peso.
- **History API (`/clients/:id`) en vez de hash:** URLs más limpias, pero exige
  que el servidor estático reescriba todas las rutas a `index.html`; con hash,
  cualquier hosting estático sirve la app sin configuración.

## Consecuencias

- (+) Bundle pequeño y controlado: presupuesto verificado en cada build
  (`scripts/check-bundle.mjs`; JS de entrada 4,00 KB gzip, JS total 27,61 KB gzip
  medidos el 2026-09-28).
- (+) Cada técnica de la plataforma es visible y enseñable en el código.
- (−) Más código propio que mantener (router, render por lotes, limpieza de vistas).
- (−) Las plantillas usan `innerHTML`: **todo** dato de la API pasa por
  `escapeHtml`, y la CSP estricta (ADR 0007, `docs/security.md` del frontend) es la segunda barrera.
- (−) URLs con `#`; los parámetros no llegan al servidor (aceptable: es una app autenticada).

## Evidencia

`renta-ia-frontend/src/router.js`, `src/main.js` (code-splitting por vista),
`scripts/check-bundle.mjs`, `docs/performance-report.md`.
