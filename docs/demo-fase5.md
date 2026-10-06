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

## B2: Estados explícitos en todas las vistas

Detalle técnico: `renta-ia-frontend/docs/ui-states.md`. Para forzar cada estado sin tocar el
código, usa DevTools (F12) de Chrome.

1. **Cargando (skeleton).** DevTools → Network → "No throttling" → **Slow 4G**. Entra a
   "Clientes" o al detalle de un cliente: ves filas grises con la forma de la tabla (quietas,
   sin brillo) en lugar de "Cargando...".
2. **Error con "Reintentar".** Con la app abierta, detén la API (Ctrl+C en la ventana de
   `npm run dev` del backend) y navega a "Clientes". Aparece "No se pudieron cargar tus
   clientes." con el botón **Reintentar**. Vuelve a arrancar la API y pulsa Reintentar: la
   tabla se llena **sin recargar la página** (la pestaña no muestra el ícono de carga).
   - Lo mismo en el detalle: conceptos, documentos, alertas, resumen y chat tienen su propio
     Reintentar, que pide solo esa sección.
3. **Vacío orientativo.** En el detalle de "María Gómez" (seed, sin documentos): conceptos,
   documentos y alertas explican qué hacer. Inicia sesión como `luis@example.com` (asistente):
   si no tuviera clientes, el mensaje no le pide crear uno (no puede).
4. **Confirmación de cada acción.** Crea un cliente (botón "Guardando…" y luego el toast
   `Cliente "X" creado.`), marca una alerta como vista o resuelta (toast), cierra sesión
   (toast "Cerraste sesión.").
5. **Procesando con IA.** Sube un documento: mientras se analiza, el estado "Procesando"
   lleva un punto que pulsa. Es la única animación continua de la app. Pasa lo mismo con
   "Generando…" en el resumen y "Pensando…" en el chat. Con "Efectos de animación" desactivado
   en Windows, el punto queda quieto.
6. **Conectividad.** DevTools → Network → **Offline**. Aparecen el toast "Se perdió la conexión
   a internet…" y el banner "Sin conexión". Los botones que necesitan red quedan atenuados y un
   lector de pantalla los anuncia como no disponibles. Vuelve a "No throttling": toast
   "Conexión restablecida." y el banner desaparece.
7. **Los avisos no bloquean clics.** Justo después de iniciar sesión, el toast "Bienvenido…"
   tapa la esquina inferior derecha. Haz clic sobre él: el clic llega al enlace o botón que
   está debajo.
8. **Pruebas automatizadas:** `npm test` (incluye `tests/states.test.js`) y, con el stack E2E,
   `npx playwright test e2e/states.spec.js`.

Nota: si haces muchos inicios de sesión seguidos, la API responde 429 ("Demasiadas
solicitudes"): es el limitador por IP funcionando, no un error de estos estados.

Evidencia del cierre de B2 (stack E2E, base `renta_ia_e2e`): axe sin ninguna violación en
cargando, error, vacío, sin conexión y resumen inicial, y en todas las vistas con datos, en
ambos temas. Capturas de antes y después en `files/.capturas/B2/`.

## B3: Guard de rutas por rol y menú de usuario

Detalle técnico: `renta-ia-frontend/docs/shell.md`. Usuarios del seed (contraseña `Password123!`).

1. **Un asistente escribe la URL de administración.** Inicia sesión como `luis@example.com`
   (no ve el enlace "Rendimiento"). Escribe a mano en la barra `http://localhost:5173/#/performance`
   y pulsa Enter. Vuelves a "Tus clientes" con el aviso: _No tienes permiso para ver
   "Rendimiento". Tu rol (Asistente) no tiene acceso. Te llevamos a Clientes._
   - En DevTools → Network, filtra por `performance`: el código de esa vista **no se descargó**.
   - Pulsa "Atrás" en el navegador: vuelves a la página anterior, no a la prohibida.
   - Con `ana@example.com` (contador) pasa lo mismo; con `admin@example.com` sí entras.
2. **Ruta inexistente.** Escribe `#/no-existe`: Clientes, con "La página que buscabas no existe."
3. **Menú de usuario** (abajo en el sidebar; arriba a la derecha en una ventana angosta):
   - Con el ratón: muestra nombre, rol y correo, más "Mi perfil" y "Salir".
   - Con el teclado: Tab hasta el botón, Enter (el foco pasa a "Mi perfil"), ↓ y ↑ recorren,
     Escape cierra y el foco vuelve al botón.
   - Ábrelo y haz clic en cualquier otra parte: se cierra.
   - "Mi perfil" abre tus datos; "Salir" cierra la sesión con el aviso "Cerraste sesión.".
4. **Sin conexión.** DevTools → Network → Offline: el banner aparece arriba y el menú del
   sidebar sigue completo (antes "Cerrar sesión" quedaba cortado abajo).
5. **Pruebas automatizadas:** `npm test` (incluye `tests/guard.test.js` y
   `tests/userMenu.test.js`) y, con el stack E2E y el seed cargado,
   `npx playwright test e2e/guard.spec.js`.

Evidencia del cierre de B3: capturas de antes y después (rebote, menú en escritorio y móvil,
perfil, sidebar sin conexión, en ambos temas) en `files/.capturas/B3/`.

## B4: Cuentas pendientes en la base, invitaciones y bandeja de correos

Detalle: [ADR 0009](adr/0009-cuentas-pendientes-garantizadas-por-el-esquema.md),
[ADR 0010](adr/0010-proveedores-externos-intercambiables.md) y el README de `renta-ia-database`.

1. **Aplicar la migración** (desde `renta-ia-database`):

   ```bat
   scripts\migrate.bat
   ```

   Aplica `017_account_status_and_invitations.sql`. Corriéndolo otra vez, no aplica nada.

2. **Comprobar que tus datos siguen igual:** tus usuarios quedan `active` con su contraseña.

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT status, count(*), count(password_hash) FROM users GROUP BY status"
   ```

3. **Intentar romper las reglas tú mismo** (dentro de una transacción que se deshace: no
   cambia nada). Abre `psql` con
   `docker exec -it renta_ia_postgres psql -U postgres -d renta_ia` y pega:

   ```sql
   BEGIN;
   INSERT INTO users (id, name, email, role, status)
     VALUES ('00000000-0000-0000-0000-0000000000aa', 'Invitada demo', 'demo@example.com', 'assistant', 'invited');
   SAVEPOINT s;
   -- a) Sesión para una cuenta pendiente → ERROR fk_refresh_tokens_active_user
   INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
     VALUES ('00000000-0000-0000-0000-0000000000aa', gen_random_uuid(), repeat('a', 64), now() + interval '1 day');
   ROLLBACK TO s;
   -- b) Volver pendiente una cuenta CON sesiones → ERROR fk_refresh_tokens_active_user
   UPDATE users SET status = 'invited', password_hash = NULL WHERE id = (SELECT user_id FROM refresh_tokens LIMIT 1);
   ROLLBACK TO s;
   -- c) Contraseña en una cuenta pendiente → ERROR chk_users_password_by_status
   UPDATE users SET password_hash = 'x' WHERE id = '00000000-0000-0000-0000-0000000000aa';
   ROLLBACK;
   ```

   (Para b) hace falta al menos una sesión en tu base: inicia sesión una vez en la app.)

4. **Bandeja de correos simulada.** Con la configuración por defecto (`EMAIL_PROVIDER` sin
   definir = `mock`) ningún correo sale del equipo: se guarda en `email_outbox`. A partir de B5
   (invitaciones) podrás leerlos así:

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT created_at, to_address, template, subject FROM email_outbox ORDER BY created_at DESC LIMIT 5"
   ```

5. **SES queda inerte.** Prueba a arrancar la API con `EMAIL_PROVIDER=ses` sin `SES_REGION`:
   no arranca y lo explica. Las pruebas demuestran además que, con SES configurado pero sin
   credenciales, el envío falla antes de llamar a AWS y no se guarda el cuerpo.

6. **Pruebas automatizadas** (desde `renta-ia-backend`):

   ```bash
   npx vitest run tests/integration/accountStatus.test.ts tests/integration/email.test.ts
   ```

Huella de tu base: antes y después de la migración en `files/.huellas/B4-antes-migracion.txt`
y `B4-despues-migracion.txt`. Cambian solo la migración nueva, dos tablas vacías y el hash del
esquema; no cambia ninguna fila existente.

## B5: Alta de cuentas solo por invitación (API)

La pantalla de administración y la de "Completa tu cuenta" llegan en B6. Por ahora todo se
prueba con Swagger UI. Necesitas la API (`npm run dev`) con tu `.env` (correo simulado por
defecto) y la migración 017 aplicada.

1. **Ya no hay registro.** En el login (`http://localhost:5173`) no aparece "Crear cuenta",
   solo una nota que explica que las cuentas las crea el administrador.
   `POST http://localhost:4000/api/auth/register` responde **404**, y `POST /api/admin/users`
   (el alta con contraseña por un admin) también.
2. **Invitar como admin.** Abre `http://localhost:4000/docs`:
   - `POST /api/auth/login` → Try it out → `{"email":"admin@example.com","password":"Password123!"}`.
     Copia el `accessToken` y pulsa **Authorize** (arriba a la derecha).
   - `POST /api/admin/invitations` →
     `{"name":"Asistente Demo","email":"asistente.demo@example.com","role":"assistant","accountantUserId":"11111111-1111-1111-1111-111111111111"}`
     (Ana, del seed). La respuesta muestra el estado `pending` y el vencimiento (72 h), **y ningún
     token ni enlace**.
3. **Leer el correo "enviado"** (bandeja del proveedor simulado):

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT body_text FROM email_outbox WHERE to_address = 'asistente.demo@example.com' ORDER BY created_at DESC LIMIT 1"
   ```

   El enlace tiene la forma `http://localhost:5173/#/invitacion/<token>`. Copia el token (lo que
   sigue a `invitacion/`). Comprueba que en la base solo está su hash:

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT token_hash, expires_at FROM user_invitations"
   ```

4. **Activar la cuenta** (lo que hará la pantalla de B6). En Swagger:
   - `POST /api/auth/invitations/lookup` con `{"token":"<token>"}` → nombre, correo y rol.
   - `POST /api/auth/invitations/accept` con `{"token":"<token>","password":"una frase larga propia"}`
     → sesión iniciada.
   - Repite el `accept` con el mismo token: **410** (un solo uso).
   - Inicia sesión en la app con `asistente.demo@example.com` y esa frase: ves los clientes de Ana.
5. **Reenviar y cancelar.** Invita otro correo, luego `POST /api/admin/invitations/{userId}/resend`:
   llega un correo nuevo y el enlace anterior da 410. `DELETE /api/admin/invitations/{userId}` cancela
   (elimina la cuenta pendiente). Con el `userId` de una cuenta activa, responde 404.
6. **El token nunca queda en la auditoría.** `GET /api/admin/audit` muestra
   `admin.invitation.create`, `resend`, `cancel` y `auth.invitation.accept`, sin el token.
7. **Pruebas automatizadas** (desde `renta-ia-backend`):

   ```bash
   npx vitest run tests/integration/invitations.test.ts tests/integration/invitationRateLimit.test.ts tests/unit/signedToken.test.ts
   ```

   `invitations.test.ts` incluye la prueba que recorre todo lo que hace el admin (invitar,
   listar, reenviar, ver la auditoría, cancelar) y verifica que el token, ninguna de sus partes
   ni su hash aparecen en ninguna respuesta, cabecera ni fila de `audit_log`.

## B6: Pantallas de invitación

Necesitas la API, el frontend (`npm run dev` en cada uno) y la migración 017.

1. **Invitar desde la pantalla.** Inicia sesión como `admin@example.com`. En el sidebar aparece
   **Usuarios**. Invita a alguien (por ejemplo, rol Asistente, eligiendo a Ana en "Contador al
   que asistirá"). Aparece en "Invitaciones pendientes" como **Pendiente**, con fecha y
   "vence dentro de 3 días". **En ninguna parte de la pantalla aparece el enlace.**
   - Rol Contribuyente: busca un expediente por nombre (por ejemplo "María") y elígelo.
2. **Leer el correo** (bandeja simulada) y copiar el enlace completo:

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT body_text FROM email_outbox ORDER BY created_at DESC LIMIT 1"
   ```

3. **Completar la cuenta.** Abre el enlace en **otra ventana privada** (otra persona).
   - La barra de direcciones pasa a `#/invitacion`: el token desaparece apenas se lee.
   - Escribe la contraseña dos veces (prueba antes a poner dos distintas: lo avisa). El botón
     **Mostrar** la deja ver; un lector de pantalla anuncia "Mostrar contraseña, presionado".
   - "Activar mi cuenta": entras a Clientes con el aviso "Tu cuenta está activa".
   - Abre el mismo enlace otra vez: "Este enlace de invitación no es válido o ya venció".
4. **Reenviar y cancelar.** Invita a otra persona y pulsa **Reenviar**: el enlace del primer
   correo deja de servir y el nuevo sí. **Cancelar** abre una confirmación; con Escape o
   "Volver" no pasa nada y el foco vuelve al botón; "Cancelar invitación" la elimina.
5. **Solo el admin.** Como `luis@example.com`, escribe `#/admin/users`: vuelves a Clientes con
   el aviso de que no tienes permiso.
6. **Pruebas automatizadas:** `npm test` en el frontend (incluye `tests/invitations.test.js`) y,
   con el stack E2E, `npx playwright test e2e/invitations.spec.js`.

Capturas en `files/.capturas/B6/`.

## B7: Recuperación de contraseña

Necesitas la migración 018 (`scripts\migrate.bat` en `renta-ia-database`), la API y el
frontend de **esta** carpeta (rama `feat/identidad-profesional`).

1. **Pedir el enlace.** En el login, pulsa **¿Olvidaste tu contraseña?**, escribe
   `ana@example.com` y pulsa "Enviar enlace". Aparece "Revisa tu correo".
   - Repite con un correo que no existe (`nadie@example.com`): la pantalla, el código (202) y el
     cuerpo de la respuesta son **idénticos**. Compruébalo en las herramientas del navegador
     (pestaña Red). La respuesta sale antes de buscar la cuenta, así que el tiempo tampoco
     revela nada.
2. **Leer el correo** (bandeja simulada):

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT body_text FROM email_outbox WHERE template = 'password_reset' ORDER BY created_at DESC LIMIT 1"
   ```

   En la base solo queda el hash, con 15 minutos de vigencia:

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT token_hash, expires_at - created_at AS vigencia, used_at, revoked_at FROM password_reset_tokens ORDER BY created_at DESC LIMIT 3"
   ```

   - Si pides otro enlace **dentro del mismo minuto**, no llega un correo nuevo: sigue sirviendo
     el anterior. Pasado el minuto, el nuevo **revoca** el anterior.

3. **Prepara una "otra sesión".** En otra ventana privada, inicia sesión como `ana@example.com`
   y deja abierta la lista de Clientes.
4. **Nueva contraseña.** Abre el enlace del correo en la ventana normal.
   - La barra pasa a `#/restablecer`: el token sale de la dirección apenas se lee.
   - Escribe la nueva contraseña dos veces y pulsa "Guardar contraseña". Vuelves al login
     con el aviso "se cerraron todas tus sesiones".
   - En la **otra** ventana, recarga o navega: la sesión ya no sirve y aparece el login. El
     access token que ya tenía se rechaza **al instante**, sin esperar sus 15 minutos: cada
     petición autenticada y el WebSocket comprueban que su sesión (`sid`) siga viva.
   - La contraseña anterior da error; la nueva entra.
   - Abre el mismo enlace otra vez: "no es válido o ya venció", con un botón "Pedir un enlace nuevo".
5. **Límite de solicitudes.** Hay como máximo 20 pedidos por IP cada 15 minutos (después, 429)
   y un correo por minuto a la misma cuenta. Usar el enlace (consultarlo o confirmarlo) admite
   20 intentos **fallidos** por IP.
6. **Auditoría** (`GET /api/admin/audit` como admin): verás `auth.password_reset.requested`,
   `auth.password_reset.completed` y `auth.password_reset.invalid`, sin el correo, el token ni
   su hash. Las sesiones revocadas quedan con motivo `password_reset`:

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT revoke_reason, count(*) FROM refresh_tokens GROUP BY 1"
   ```

7. **Pruebas automatizadas:**
   - Backend: `npx vitest run tests/integration/passwordReset.test.ts tests/integration/passwordResetRateLimit.test.ts tests/integration/session.test.ts`.
   - Frontend: `npm test` (incluye `tests/passwordReset.test.js`) y, con el stack E2E,
     `npx playwright test e2e/passwordReset.spec.js`.

Capturas en `files/.capturas/B7/`.

## B8: Verificación en dos pasos (MFA), backend

Las pantallas llegan en B9; aquí todo se prueba en **Swagger** (`http://localhost:4000/docs`,
botón **Authorize** con el `accessToken`). Necesitas la migración 019 y una app de
autenticación en el teléfono (Google o Microsoft Authenticator, 1Password, Aegis…).

1. **Clave de cifrado.** Genera una y ponla en `renta-ia-backend\.env`; luego reinicia la API:

   ```bat
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   `MFA_ENCRYPTION_KEY=<lo que salió>`. Sin ella la API arranca igual, y las rutas de MFA
   responden 503 diciendo qué falta (pruébalo antes de ponerla).

2. **Configurar** (con sesión de `ana@example.com`): `POST /api/users/me/mfa/setup` con
   `{"password":"Password123!"}`. Devuelve `secret` y `otpauthUri`. En la app, "agregar
   cuenta" → "ingresar clave" → pega el `secret`. Con una contraseña incorrecta: 400.
   En la base el secreto está **cifrado**:

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT left(secret_ciphertext, 30) AS cifrado, enabled_at FROM user_mfa"
   ```

3. **Activar:** `POST /api/users/me/mfa/enable` con `{"code":"<6 dígitos de la app>"}`.
   Devuelve **10 códigos de recuperación** (anótalos: no se vuelven a mostrar). Si tenías otra
   sesión abierta (otra ventana con la app), se cierra: activó MFA y esa sesión era de un solo factor.
4. **Login en dos pasos:** `POST /api/auth/login` con la contraseña de Ana. Ahora responde
   `{"mfaRequired":true,"challengeToken":"…"}`, **sin** `accessToken` ni cookie. Luego
   `POST /api/auth/login/mfa` con `{"challengeToken":"…","code":"<código actual>"}` → sesión.
   - El mismo código otra vez (en el mismo medio minuto) → 401: un código sirve una sola vez.
   - Un código de recuperación en lugar del de la app → entra, y ese código queda gastado.
   - 5 códigos incorrectos en el mismo paso → el paso muere y la cuenta queda bloqueada
     unos minutos (el mismo bloqueo de las contraseñas).
5. **Desactivar o regenerar:** `POST /api/users/me/mfa/disable` pide contraseña **y** código.
   `POST /api/users/me/mfa/recovery-codes` pide un código de la app y anula los anteriores.
6. **Admin:** como `admin@example.com`, `DELETE /api/admin/users/{id de Ana}/mfa` le quita el
   MFA y le cierra todas las sesiones (sobre tu propia cuenta responde 403).
7. **Auditoría** (`GET /api/admin/audit`): `mfa.setup.started`, `mfa.enabled`,
   `auth.login.mfa_challenge`, `auth.mfa.failure`, `auth.mfa.recovery_code_used`,
   `admin.mfa.reset`, sin secretos ni códigos.
8. **Pruebas automatizadas:** `npx vitest run tests/unit/totp.test.ts tests/integration/mfa.test.ts tests/integration/mfaRateLimit.test.ts`.
   `totp.test.ts` compara con los vectores oficiales de los RFC 4226 y 6238.

Huellas de la base antes y después de la 019 en `files/.huellas/B8-*.txt`.
