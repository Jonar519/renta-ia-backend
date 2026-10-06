# Demo de la Fase 5: identidad profesional y evolución visual

Pasos para probar cada bloque con tus propias manos. Rama
`feat/identidad-profesional` en los tres repositorios.

## B0: Preparación y auditoría

No agrega funciones visibles. Lo que se puede comprobar:

1. **Huella de la base de desarrollo** (solo lectura), desde Git Bash en
   `renta-ia-database`:

   ```bash
   ./scripts/fingerprint.sh > /tmp/huella.txt
   ```

   Muestra las migraciones aplicadas, las filas por tabla y el SHA-256 del
   esquema. Huella tomada al iniciar la fase: 16 migraciones (001–016),
   esquema `9cdedda8…f4b468`.

2. **Tests del backend independientes del `.env` local.** Con
   `AI_PROVIDER=mock` en `renta-ia-backend/.env` (configuración del stack E2E),
   antes fallaban 4 tests (`aiChat`, `ragIsolation`, `summary` ×2). Ahora:

   ```bash
   npm test
   ```

   Resultado esperado: `191 passed`.

3. **Auditoría del sistema de diseño:** `renta-ia-frontend/docs/design-tokens-audit.md`.

## B1: Tokens, modo oscuro y tipografía de datos

Detalle técnico: `renta-ia-frontend/docs/dark-mode.md`.

1. **El tema sigue al sistema operativo, en vivo.** Abre la app (`npm run dev` en
   `renta-ia-frontend`) e inicia sesión. Con la app abierta, cambia el tema de Windows
   (Configuración → Personalización → Colores → "Elige el modo" → Oscuro/Claro). La app
   cambia de inmediato, sin recargar.
   - No hay ningún botón ni interruptor de tema en ninguna pantalla, ni en el perfil.
   - Para probarlo sin tocar Windows: DevTools → ⋮ → More tools → Rendering →
     "Emulate CSS media feature prefers-color-scheme".
2. **Cifras en monoespaciada.** En "Clientes" (documento y fecha de creación), en el detalle
   de un cliente (montos, años, fecha de subida, totales por año, fechas de las alertas) y en
   "Rendimiento" (p75 y muestras), las cifras usan JetBrains Mono y los montos van alineados
   a la derecha. Nombres, descripciones y etiquetas siguen en Inter.
3. **Contorno de los inputs (corrección WCAG 1.4.11).** Los campos del login y de "Nuevo
   cliente" tienen ahora un borde visible (3.45:1; antes 1.26:1).
4. **Contenido de IA con tono propio.** En el detalle de un cliente, la respuesta de la IA en
   el chat y el texto del resumen ejecutivo usan violeta. El ámbar queda solo para
   advertencias (badge "Alta", "Procesado con advertencias", banner sin conexión).
5. **Movimiento reducido.** Con "Efectos de animación" desactivado en Windows (Accesibilidad →
   Efectos visuales), los toasts aparecen sin desplazamiento.
6. **Pruebas automatizadas:**

   ```bash
   node scripts/contrast.mjs        # tabla de contraste de ambos temas (74 pares)
   npm test                         # incluye contrast, theme y motion
   npm run build                    # presupuesto de fuentes 95 KB
   ```

   E2E del cambio en vivo (solo necesita el frontend compilado y servido en 4173):

   ```bash
   npx playwright test e2e/theme.spec.js
   ```

   Evidencia del cierre de B1 (stack E2E con IA simulada, base `renta_ia_e2e`): axe sin
   ninguna violación (de ningún nivel) en clientes, las cuatro pestañas del detalle de cliente
   y rendimiento, en tema claro y oscuro; capturas de antes y después en
   `files/.capturas/B1/` (fuera de los repositorios).
