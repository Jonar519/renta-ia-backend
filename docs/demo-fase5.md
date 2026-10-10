# Guía de prueba completa de la plataforma (Fase 5)

Una sola guía, en orden, para recorrer la plataforma de principio a fin con tus propias manos:
la preparación y después cada bloque, de **B0 a B18**. Cada paso dice **qué rol usar**, **qué
hacer** y **qué debes ver** (→). Los pasos están ordenados para que lo que creas en uno sirva en
los siguientes, así que conviene no saltarse ninguno.

**Convenciones**

- **Rol:** la cuenta con la que haces el paso.
- **→** lo que debes ver.
- Los comandos son de `cmd.exe` salvo que se diga otra cosa. Los `docker exec … psql` solo
  **leen** la base, salvo los de B4, que corren dentro de una transacción que se deshace.

**Cuentas que vas a usar**

| Cuenta                               | Rol                                               | De dónde sale                                                                 |
| ------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ana@example.com` / `Password123!`   | Contador (2 clientes: Carlos Pérez y María Gómez) | seed                                                                          |
| `luis@example.com` / `Password123!`  | Asistente de Ana                                  | seed                                                                          |
| `admin@example.com` / `Password123!` | Admin (verificación en dos pasos obligatoria)     | seed                                                                          |
| `asistente.demo@example.com`         | Asistente de Ana                                  | la creas en **B5**. En B7, B11 y B14 la usas para lo que no se puede deshacer |
| `portal.demo@example.com`            | Contribuyente (portal de María Gómez)             | la creas en **B6**                                                            |
| `contador.demo@example.com`          | Contador sin clientes                             | la creas en **B6**; sirve para reasignar clientes                             |

**El visor del original y la vista dividida (B17-B18) son solo para el contador y el
asistente.** El contribuyente y el admin ven "Descargar" en su lugar.

---

## 0. Preparación (una sola vez)

### 0.1 Detén la versión de `main`

Si tienes corriendo la versión de `main` (por ejemplo desde otra carpeta), detenla con
**Ctrl+C** en cada ventana (API, worker y frontend). Esta guía usa los mismos puertos (4000,
5173 y 9464) y el código de **esta** carpeta.

### 0.2 Base de datos (desde `renta-ia-database`)

```bat
docker compose up -d
scripts\migrate.bat
scripts\seed.bat
```

→ `migrate` aplica lo que falte hasta `026_concept_review.sql`. Si lo corres otra vez: `Listo: 0
migración(es)`. El seed es idempotente.

### 0.3 Configuración del backend (`renta-ia-backend\.env`)

1. **Clave de la verificación en dos pasos.** Genera una y pégala como
   `MFA_ENCRYPTION_KEY=<lo que salió>`:

   ```bat
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   Es solo de tu equipo. La de producción irá a Secrets Manager al desplegar.

2. **IA para la demo.** Sin claves de Anthropic/Voyage, deja `AI_PROVIDER=mock` y
   `AI_MOCK_LATENCY_MS=1500`.
   - La IA simulada lee las líneas "Etiqueta: $ monto" del PDF de prueba y extrae sus conceptos.
   - Con 1,5 s por llamada se alcanza a ver el estado "Procesando".
   - Con claves reales, usa `AI_PROVIDER=anthropic` (la lista de pruebas con IA real está en el
     README raíz).
3. **Orígenes.** `CORS_ORIGIN=http://localhost:5173,http://localhost:4173`: 5173 es el
   desarrollo y 4173 el build con su CSP.
4. **Correo y ubicación** quedan simulados por defecto (`EMAIL_PROVIDER` y `GEOIP_PROVIDER` sin
   definir = `mock`).

### 0.4 Arrancar (cada proceso en su ventana, en este orden)

| #   | Dónde               | Comando                | → Listo cuando ves                             |
| --- | ------------------- | ---------------------- | ---------------------------------------------- |
| 1   | `renta-ia-backend`  | `docker compose up -d` | `renta_ia_redis … (healthy)` en `docker ps`    |
| 2   | `renta-ia-backend`  | `npm run dev`          | `Servidor escuchando en http://localhost:4000` |
| 3   | `renta-ia-backend`  | `npm run worker`       | `… escuchando la cola 'document-processing'`   |
| 4   | `renta-ia-frontend` | `npm run dev`          | `Local: http://localhost:5173/`                |

La app es **http://localhost:5173**. En desarrollo no hay Service Worker ni CSP. Donde una prueba
los necesita (B12, B17), se indica cómo usar el build:

```bat
:: desde renta-ia-frontend, en otra ventana
npm run build
npm run preview
```

Ese build queda en **http://localhost:4173**.

### 0.5 Archivos de prueba

Desde `renta-ia-frontend`:

```bat
node scripts\demo-files.mjs %USERPROFILE%\Desktop\renta-demo
```

→ En el Escritorio, `renta-demo\certificado-demo.pdf` (certificado con texto: la IA simulada
extrae Ingresos brutos, Deducción y Retención) y `renta-demo\extracto-demo.png`. Son datos
sintéticos.

### 0.6 Herramientas que usarás

- **Código de verificación sin celular.** Imprime el código de 6 dígitos de los próximos
  segundos (cambia cada 30 s). Pega la clave tal como la muestra la pantalla, con espacios:

  ```bat
  node -e "const s=process.argv.slice(1).join('').toUpperCase(),A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',b=[...s].map(c=>A.indexOf(c).toString(2).padStart(5,'0')).join(''),k=Buffer.from(b.match(/.{8}/g).map(x=>parseInt(x,2))),m=Buffer.alloc(8);m.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const h=require('crypto').createHmac('sha1',k).update(m).digest(),o=h[19]&15;console.log(String(h.readUInt32BE(o)&0x7fffffff).padStart(6,'0').slice(-6))" CLAVE DE LA PANTALLA
  ```

  También sirve una app de autenticación (Google o Microsoft Authenticator, Aegis…).

- **Bandeja de correos simulada.** Ningún correo sale del equipo: se guardan en `email_outbox`.
  Para ver el último:

  ```bat
  docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT created_at, to_address, template, body_text FROM email_outbox ORDER BY created_at DESC LIMIT 1"
  ```

- **Swagger** de la API: **http://localhost:4000/docs**. Para autenticarte, botón **Authorize**
  con el `accessToken`.

### 0.7 Primer ingreso del admin: activar la verificación en dos pasos

**Rol:** admin. Es obligatoria para un administrador y la necesitas desde B5. Las demás
comprobaciones de MFA están en B8 y B9.

1. Entra con `admin@example.com` / `Password123!`.
   → La app te lleva a **Seguridad**: "primero debes activar la verificación en dos pasos".
2. Confirma la contraseña y pulsa "Empezar".
   → Aparecen un QR y la **clave** en grupos de 4.
3. Corre el comando de 0.6 con esa clave (o escanea el QR), escribe el código y pulsa "Activar".
4. Aparecen **10 códigos de recuperación**, una sola vez.
   - "Descargar (.txt)" los guarda. Guárdalos: los usarás en B9.
   - "Listo" no avanza hasta marcar "Los guardé en un lugar seguro".
5. → "Activa desde…" y ya puedes usar Clientes y Usuarios. **Desde ahora, cada ingreso del admin
   pide el código** (corre de nuevo el comando de 0.6 con la misma clave: guárdala junto a los
   códigos).

---

## B0: Preparación y auditoría

**Rol:** ninguno (terminal).

1. **Huella de la base** (solo lectura, desde Git Bash en `renta-ia-database`):

   ```bash
   ./scripts/fingerprint.sh
   ```

   → Las migraciones aplicadas (001–026), las filas por tabla y el SHA-256 del esquema.

2. **Tests del backend independientes del `.env`** (desde `renta-ia-backend`, con
   `AI_PROVIDER=mock` en tu `.env`): `npm test`.
   → Todos pasan (445). Los tests fijan su propia configuración.
3. **Auditoría del sistema de diseño:** `renta-ia-frontend/docs/design-tokens-audit.md`.

## B1: Tokens, modo oscuro y tipografía de datos

**Rol:** Ana. Detalle técnico: `renta-ia-frontend/docs/dark-mode.md`.

1. **El tema sigue al sistema operativo, en vivo.** Con la app abierta, cambia el tema de Windows
   (Configuración → Personalización → Colores → "Elige el modo").
   → La app cambia al instante, sin recargar. No hay ningún interruptor de tema en ninguna
   pantalla.
   - Sin tocar Windows: DevTools → ⋮ → More tools → Rendering → "Emulate CSS media feature
     prefers-color-scheme".
2. **Cifras en monoespaciada.** Mira Clientes (documento y fecha), el detalle de un cliente
   (montos, años, fechas, totales) y, como admin, Rendimiento.
   → Las cifras en JetBrains Mono y los montos alineados a la derecha. El texto sigue en Inter.
3. **Contorno de los inputs.** Los campos del login y de "Nuevo cliente".
   → Borde visible (3,45:1; antes 1,26:1, WCAG 1.4.11).
4. **La IA tiene su tono.** En el detalle de un cliente, el chat y el resumen.
   → El contenido generado por la IA va en violeta. El ámbar queda solo para advertencias.
5. **Movimiento reducido.** Desactiva "Efectos de animación" en Windows (Accesibilidad → Efectos
   visuales).
   → Los avisos (toasts) aparecen sin desplazarse.

## B2: Estados explícitos en todas las vistas

**Rol:** Ana. Detalle: `renta-ia-frontend/docs/ui-states.md`. Usa DevTools (F12).

1. **Cargando.** Network → **Slow 4G**. Entra a Clientes y al detalle de María Gómez.
   → Filas grises con la forma de la tabla, quietas, en vez de "Cargando…". Vuelve a "No
   throttling".
2. **Error con Reintentar.** Detén la API (Ctrl+C en su ventana) y navega a Clientes.
   → "No se pudieron cargar tus clientes." con **Reintentar**. Arranca la API (`npm run dev`) y
   pulsa Reintentar.
   → La tabla se llena **sin recargar la página**. En el detalle, cada sección tiene su propio
   Reintentar.
3. **Vacío que orienta.** En el detalle de María Gómez (seed, sin documentos con archivo), mira
   conceptos, documentos y alertas.
   → Cada uno explica qué hacer.
4. **Confirmación de cada acción.** Crea un cliente y marca una alerta como vista.
   → El botón dice "Guardando…" y después aparece un toast. Al cerrar sesión: "Cerraste sesión."
   (vuelve a entrar como Ana).
5. **Procesando con IA (y los originales de B16-B18).** En el detalle de **María Gómez** →
   Documentos, sube `certificado-demo.pdf` (tipo "Certificado de ingresos") y después
   `extracto-demo.png`.
   → Mientras se analiza, el estado "Procesando" lleva un punto que pulsa: es la única animación
   continua de la app. Después cambia a "Procesado" **sin recargar** (tiempo real) y aparecen
   tres conceptos del PDF.
6. **Conectividad.** Network → **Offline**.
   → El toast "Se perdió la conexión…", el banner "Sin conexión" y los botones que necesitan red
   atenuados. Vuelve a "No throttling": "Conexión restablecida.".
7. **Los avisos no bloquean clics.** Justo después de entrar, haz clic sobre el toast
   "Bienvenido…".
   → El clic llega a lo que está debajo.

Si inicias sesión muchas veces seguidas, la API responde 429: es el límite por IP.

## B3: Guard de rutas por rol y menú de usuario

**Rol:** Luis (asistente), después Ana y admin. Detalle: `renta-ia-frontend/docs/shell.md`.

1. **URL prohibida.** Como `luis@example.com`, escribe `http://localhost:5173/#/performance`.
   → Vuelves a "Tus clientes" con el aviso: _No tienes permiso para ver "Rendimiento". Tu rol
   (Asistente) no tiene acceso. Te llevamos a Clientes._
   - Network, filtro `performance`: el código de esa vista **no se descargó**.
   - "Atrás" del navegador te deja en la página anterior, no en la prohibida.
   - Con Ana pasa lo mismo; con el admin sí entras.
2. **Ruta inexistente:** `#/no-existe`.
   → Clientes, con "La página que buscabas no existe."
3. **Menú de usuario** (abajo en el sidebar; arriba a la derecha si la ventana es angosta).
   → Nombre, rol, correo, "Mi perfil" y "Salir".
   - Con teclado: Tab hasta el botón y Enter (el foco va a "Mi perfil"); ↓ y ↑ recorren; Escape
     cierra y el foco vuelve al botón.
   - Un clic afuera también lo cierra.
4. **Sin conexión:** Network → Offline.
   → El banner arriba y el menú del sidebar completo (no se corta "Salir").

## B4: Cuentas pendientes en la base, invitaciones y bandeja de correos

**Rol:** ninguno (base de datos). Detalle: ADR 0009 y 0010, y el README de `renta-ia-database`.

1. **Tus usuarios siguen activos y con contraseña:**

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT status, count(*), count(password_hash) FROM users GROUP BY status"
   ```

2. **Intenta romper las reglas** (todo se deshace). Abre
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

   → Los tres terminan en ERROR, con el nombre de la restricción.

3. **SES queda inerte.** Arranca la API con `EMAIL_PROVIDER=ses` y sin `SES_REGION`.
   → No arranca, y dice por qué. Quita la variable y vuelve a arrancarla normal.

## B5: Alta de cuentas solo por invitación (API)

**Rol:** admin, en Swagger (**http://localhost:4000/docs**).

1. **Ya no hay registro.** En el login no aparece "Crear cuenta", solo una nota que dice que las
   cuentas las crea el administrador.
   → `POST /api/auth/register` y `POST /api/admin/users` responden **404**.
2. **Entrar como admin en Swagger** (dos pasos):
   - `POST /api/auth/login` con `{"email":"admin@example.com","password":"Password123!"}`.
     → `{"mfaRequired":true,"challengeToken":"…"}`, sin sesión.
   - `POST /api/auth/login/mfa` con `{"challengeToken":"…","code":"<código de 0.6>"}`.
     → `accessToken`. Pégalo en **Authorize**.
3. **Invitar.** `POST /api/admin/invitations` con:
   `{"name":"Asistente Demo","email":"asistente.demo@example.com","role":"assistant","accountantUserId":"11111111-1111-1111-1111-111111111111"}`
   (Ana, del seed).
   → Estado `pending` y vencimiento a 72 h, **sin token ni enlace**.
4. **El correo y el hash.** Mira el último correo (0.6) y copia el token, lo que sigue a
   `#/invitacion/`. En la base está solo su hash:

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT token_hash, expires_at FROM user_invitations"
   ```

5. **Activar.**
   - `POST /api/auth/invitations/lookup` con `{"token":"<token>"}` → nombre, correo y rol.
   - `POST /api/auth/invitations/accept` con `{"token":"<token>","password":"<una frase larga tuya>"}`
     → sesión iniciada.
   - El mismo `accept` otra vez → **410** (un solo uso).

   Anota la frase: es la contraseña de `asistente.demo@example.com`.

6. **Reenviar y cancelar.** Invita a `prueba.cancelar@example.com` (rol assistant, mismo
   `accountantUserId`).
   - `POST /api/admin/invitations/{userId}/resend` → llega un correo nuevo, y el enlace anterior
     da 410.
   - `DELETE /api/admin/invitations/{userId}` → la cuenta pendiente desaparece.
   - Con el `userId` de una cuenta activa → 404.
7. **El token nunca queda en la auditoría.** `GET /api/admin/audit`.
   → `admin.invitation.create`, `resend`, `cancel` y `auth.invitation.accept`, sin el token.

## B6: Pantallas de invitación

**Rol:** admin, y luego las personas invitadas (en ventanas privadas).

1. **Invitar desde la pantalla.** Entra como admin (contraseña y código) → **Usuarios**.
   1. Invita a **Contador Demo**, `contador.demo@example.com`, rol Contador.
   2. Invita a **Contribuyente Demo**, `portal.demo@example.com`, rol Contribuyente. Busca
      "María" y elige su expediente.

   → Ambas en "Invitaciones pendientes" como **Pendiente**, con "vence dentro de 3 días".
   **En ninguna parte aparece el enlace.**

2. **Completar la cuenta.** Copia el enlace del correo de `portal.demo@example.com` (0.6) y
   ábrelo en una **ventana privada**.
   → La barra pasa a `#/invitacion`: el token desaparece apenas se lee.
   - Escribe dos contraseñas distintas → lo avisa. Escríbela bien dos veces.
   - **Mostrar** deja ver la contraseña (un lector de pantalla anuncia "Mostrar contraseña,
     presionado").
   - "Activar mi cuenta" → entras con el aviso "Tu cuenta está activa". Ves solo el expediente
     de María, en solo lectura.
   - El mismo enlace otra vez → "Este enlace de invitación no es válido o ya venció".

   Repite con el enlace de `contador.demo@example.com`. Anota ambas contraseñas.

3. **Reenviar y cancelar desde la pantalla.** Invita a otra persona y pulsa **Reenviar**.
   → El enlace del primer correo deja de servir y el nuevo sí.
   - **Cancelar** abre una confirmación. Escape o "Volver" no hacen nada y el foco vuelve al
     botón.
   - "Cancelar invitación" la elimina.
4. **Solo el admin.** Como Luis, escribe `#/admin/users`.
   → Vuelves a Clientes con el aviso de que no tienes permiso.

## B7: Recuperación de contraseña

**Rol:** `asistente.demo@example.com` (su contraseña cambiará; Ana no se toca).

1. **Pedir el enlace.** En el login, "¿Olvidaste tu contraseña?", escribe
   `asistente.demo@example.com` y pulsa "Enviar enlace".
   → "Revisa tu correo".
   - Repite con `nadie@example.com`: la pantalla, el código (202) y la respuesta son
     **idénticos**. Compruébalo en Network.
2. **El correo y el hash** (15 minutos de vigencia):

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT body_text FROM email_outbox WHERE template = 'password_reset' ORDER BY created_at DESC LIMIT 1"
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT token_hash, expires_at - created_at AS vigencia, used_at, revoked_at FROM password_reset_tokens ORDER BY created_at DESC LIMIT 3"
   ```

   Si pides otro enlace dentro del mismo minuto, no llega un correo nuevo. Pasado el minuto, el
   nuevo revoca el anterior.

3. **Otra sesión abierta.** En una ventana privada, entra como `asistente.demo` y deja abierta
   la lista de Clientes.
4. **Nueva contraseña.** Abre el enlace del correo en la ventana normal.
   → La barra pasa a `#/restablecer`.
   - Escribe la nueva dos veces y pulsa "Guardar contraseña".
     → Vuelves al login con "se cerraron todas tus sesiones".
   - En la otra ventana, recarga.
     → El login: la sesión murió **al instante**, sin esperar los 15 minutos del token.
   - La contraseña anterior falla y la nueva entra. **Desde aquí, esa es la contraseña de
     `asistente.demo`.**
   - El mismo enlace otra vez → "no es válido o ya venció", con "Pedir un enlace nuevo".
5. **Auditoría** (como admin, `GET /api/admin/audit` en Swagger).
   → `auth.password_reset.requested`, `completed` e `invalid`, sin correo ni token.

## B8: Verificación en dos pasos (MFA), backend

**Rol:** Ana, en Swagger (Authorize con el `accessToken` de su `POST /api/auth/login`).

1. **Sin clave, 503.** Opcional: quita `MFA_ENCRYPTION_KEY` del `.env` y reinicia la API.
   → Las rutas de MFA responden 503 diciendo qué falta. Vuelve a ponerla y reinicia.
2. **Configurar.** `POST /api/users/me/mfa/setup` con `{"password":"Password123!"}`.
   → `secret` y `otpauthUri`. Con una contraseña incorrecta: 400.
   - En la base, el secreto está **cifrado**:

     ```bat
     docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT left(secret_ciphertext, 30) AS cifrado, enabled_at FROM user_mfa"
     ```

3. **Activar.** `POST /api/users/me/mfa/enable` con `{"code":"<código de 0.6 con el secret>"}`.
   → 10 códigos de recuperación. Si Ana tenía otra sesión abierta, se cierra.
4. **Login en dos pasos.** `POST /api/auth/login` con la contraseña de Ana.
   → `mfaRequired` y `challengeToken`, sin `accessToken` ni cookie. Después,
   `POST /api/auth/login/mfa` con el código → sesión.
   - El mismo código otra vez → 401 (sirve una sola vez).
   - Un código de recuperación en su lugar → entra, y ese código queda gastado.
5. **Desactivar** (para seguir la guía sin código para Ana).
   `POST /api/users/me/mfa/disable` con contraseña **y** un código nuevo.
   → Ana vuelve a entrar solo con la contraseña.
6. **Admin.** El reseteo del MFA de otra persona por un admin se prueba en B9.

## B9: Pantallas de verificación en dos pasos

**Rol:** admin (ya la activaste en 0.7), después Ana.

1. **Login en dos pasos.** Sal y vuelve a entrar como admin.
   → Después de la contraseña: "Verificación en dos pasos".
   - Un código incorrecto → "El código no es correcto.", y te deja reintentar.
   - El código correcto → entras.
2. **Código de recuperación.** Sal otra vez. En el segundo paso, pulsa "Usar un código de
   recuperación" y escribe uno de los de 0.7.
   → Entras, y ese código queda gastado.
3. **Sin opción de desactivarla.** Admin → Seguridad.
   → "Activa desde…", sin "Desactivar".
4. **Otros roles: opcional.** Como Ana → Seguridad: puede activarla (y desactivarla, con
   contraseña y código). **Actívala** para el paso siguiente.
5. **Si alguien pierde el teléfono y los códigos,** un admin hace
   `DELETE /api/admin/users/11111111-1111-1111-1111-111111111111/mfa` (Ana) en Swagger.
   → A Ana se le cierran todas las sesiones, y vuelve a entrar solo con la contraseña. Así sigue
   el resto de la guía. Sobre tu propia cuenta → 403.

## B10: Rediseño del login

**Rol:** ninguno (sin sesión).

1. **Sigue el tema del sistema.** En `#/login`, cambia el tema de Windows.
   → El login cambia en vivo.
2. **Escritorio.**
   - A la izquierda, la composición "papel contable": renglones finos, "Renta IA" en serif, "La
     IA lee. Tú decides." y tres líneas con puntos guía. **Sin cifras y sin violeta.**
   - A la derecha, "Inicia sesión".
   - La tercera línea dice "Tú decides — lo extraído queda marcado hasta que lo revisas": es
     verdad desde B16.
3. **Móvil** (DevTools → modo dispositivo, 375 y 320 px).
   → Primero el formulario y después la composición, sin desplazamiento horizontal.
4. **"Mostrar".** Es la única micro-interacción del login: deja ver la contraseña.

## B11: Mi perfil

**Rol:** `asistente.demo@example.com` (su correo cambiará), en Mi perfil (menú de la cuenta).

1. **Nombre y teléfono.** Cambia el nombre y escribe `+57 300 123 4567`. Guarda.
   → El menú de la cuenta muestra el nombre nuevo sin recargar.
   - Un teléfono con letras → el motivo del error.
   - Vacío → lo borra.
2. **Cambiar el correo** a `asistente.demo2@example.com`.
   - Con una contraseña incorrecta → "La contraseña actual no es correcta." (cuenta en el
     bloqueo).
   - Con la correcta → "Esperando confirmación de …", y el correo **todavía no cambia**.
   - Llegan dos correos:

     ```bat
     docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT to_address, template, subject FROM email_outbox ORDER BY created_at DESC LIMIT 2"
     ```

     → El enlace al correo **nuevo** y el aviso al **anterior**.

   - Abre el enlace en una ventana privada → "Listo: tu correo cambió". **Desde aquí se entra
     con `asistente.demo2@example.com`.**
   - El mismo enlace otra vez → "no es válido o ya venció".
3. **Cambiar la contraseña** con otra sesión abierta (en una ventana privada).
   → "Cambiaste tu contraseña y cerramos N sesiones más". La otra ventana vuelve al login al
   recargar, y llega el aviso `password_change_notice`.
4. **Auditoría** (admin): `user.profile.update`, `user.email_change.requested/completed` y
   `user.password.change`, sin correos ni teléfonos.

## B12: Foto de perfil

**Rol:** Ana → Mi perfil → Foto de perfil.

1. **Elegir y encuadrar.** "Elegir foto" y una imagen PNG o JPG tuya.
   → Recorte circular. Arrastra la foto, o haz clic en la vista previa y usa las flechas (con
   Mayús, pasos largos). El zoom nunca deja huecos.
2. **Guardar.**
   → La foto en el perfil y en el menú de la cuenta, sin recargar. El navegador la reduce a
   256×256 JPEG, así que no viajan los datos del archivo original.
3. **Validación en la API.** Renombra un PDF a `foto.png` e intenta subirlo.
   → El navegador avisa que no puede leerlo. Directo a la API → 415 (firma del contenido). Más de
   512 KB → 413.
4. **Dónde queda.** El archivo va a `uploads/users/<id de Ana>/avatar/`. En la base, solo la
   clave:

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT email, avatar_key, avatar_updated_at FROM users WHERE avatar_key IS NOT NULL"
   ```

5. **Solo tú la ves.** Se pide con tu sesión (`GET /api/users/me/avatar`) y se muestra como
   `blob:`. No existe una URL para la foto de otra persona.

### Entre B12 y B13: metadatos de las fotos y vigilancia de la CSP

**Rol:** Ana (terminal, con su token).

1. Genera una foto con ubicación GPS (desde `renta-ia-backend`):

   ```bat
   npx ts-node --transpile-only -e "require('fs').writeFileSync('foto-gps.jpg', require('./tests/fixtures/images').jpegWithGps())"
   ```

2. Súbela **directo a la API** (el token, en DevTools → Network → la petición a `/api/users/me` →
   encabezado `Authorization`):

   ```bat
   curl -s -X POST http://localhost:4000/api/users/me/avatar -H "Authorization: Bearer <token>" -F "avatar=@foto-gps.jpg;type=image/jpeg"
   ```

3. Compara el archivo original con el guardado:

   ```bat
   findstr /m "Exif TelefonoX" foto-gps.jpg
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -tAc "SELECT avatar_key FROM users WHERE avatar_key IS NOT NULL ORDER BY avatar_updated_at DESC LIMIT 1"
   findstr /m "Exif TelefonoX" uploads\<clave que devolvió la consulta>
   ```

   → El primer `findstr` muestra el nombre del archivo; el segundo, nada: la API quitó EXIF, GPS
   y fabricante. Un archivo cortado a la mitad → 422, y no se guarda nada. Borra `foto-gps.jpg`
   al terminar.

4. **CSP.** En el build (`http://localhost:4173`, ver 0.4), recorre la app con la consola
   abierta.
   → Ninguna violación de "Content Security Policy". Las pruebas E2E fallan ante cualquiera.

## B13: Sesiones activas

**Rol:** Ana, en Seguridad → "Sesiones activas".

1. **Varias sesiones.** Entra con Ana en dos navegadores (por ejemplo Chrome y una ventana de
   incógnito).
   → Las dos sesiones, con:
   - navegador y sistema ("Chrome en Windows"), y "Esta sesión" en la actual;
   - ubicación aproximada ("Red local" con el proveedor simulado);
   - la IP **recortada** (`x.x.x.x` sin el último número);
   - cuándo empezó y su última actividad.

   Lo que no se sabe dice "desconocida".

2. **Cerrar una.** "Cerrar sesión" en la otra fila.
   → En el otro navegador, la siguiente acción lleva al login. El tiempo real puede tardar hasta
   30 s en cortarse.
3. **Cerrar todas las demás.** El botón pide confirmación y dice cuántas cerrará.
   → "Volver" no cierra nada. La actual sigue abierta: para cerrarla está "Salir".
4. **En la base, nunca la IP completa:**

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT u.email, s.created_at, s.last_seen_at, s.ip_prefix, s.location, s.device FROM user_sessions s JOIN users u ON u.id = s.user_id ORDER BY s.last_seen_at DESC LIMIT 10"
   ```

5. **Ubicación real (opcional).** Descarga "IP to City Lite" (CSV) de
   https://db-ip.com/db/lite.php. En el `.env`, pon `GEOIP_PROVIDER=dbip` y
   `GEOIP_DBIP_CSV=<ruta>`, y reinicia la API. La IP nunca sale del servidor.

## B14: Exportar y eliminar la cuenta

**Rol:** Ana, después `asistente.demo2@example.com` y el admin, en Mi perfil → "Tus datos".
Política: `docs/data-retention.md`.

1. **Descargar mis datos (Ana).** Escribe la contraseña y pulsa "Descargar mis datos".
   → `renta-ia-mis-datos-AAAA-MM-DD.json` con:
   - la cuenta, las sesiones, la actividad, las conversaciones con la IA y los documentos que
     subió (solo metadatos);
   - de sus clientes, solo **cuántos** son.

   Sin contraseñas, hashes ni el secreto del MFA.

2. **Un contador con clientes no puede eliminarse (Ana).**
   → La sección dice cuántos clientes tiene y que un admin debe reasignarlos. No hay formulario.
3. **Eliminar (`asistente.demo2@example.com`).**
   1. Escribe la contraseña y marca "Entiendo que no se puede deshacer".
   2. "Eliminar mi cuenta" y confirma.
      → El login con "Eliminamos tu cuenta". Ese correo da "Credenciales inválidas".
4. **La lápida en la base:**

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT id, status, name, email, phone, deleted_at FROM users WHERE status = 'deleted'"
   ```

   → La fila sigue, sin datos personales. Lo que subió esa cuenta sigue en el expediente, con
   autor "Cuenta eliminada".

5. **El único admin no puede eliminarse (admin).**
   → La sección pide invitar a otro admin antes.

## B15: Densidad de las tablas y tablas en móvil

**Rol:** Ana.

1. **Densidad.** Encima de Clientes, de Documentos (en el detalle) y de Usuarios (admin) está
   "Densidad de la tabla". Elige "Compacta" en Clientes.
   → Las filas se juntan, y el detalle → Documentos también queda compacto.
2. **Viaja con la cuenta.** Entra con Ana en otro navegador.
   → Llega ya en "Compacta". Vuelve a "Cómoda".
3. **En la base** (solo `comfortable` o `compact`):

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT email, table_density FROM users WHERE status = 'active'"
   ```

4. **Móvil (375 px).** Recorre Clientes, el detalle (todas las pestañas) y, como admin, Usuarios
   y Rendimiento.
   - → Ninguna pantalla se sale del ancho.
   - → Clientes, Documentos, Conceptos y Usuarios pasan a **tarjetas** (cada valor con su
     encabezado).
   - → Las tablas de cifras se desplazan dentro de su región, que se alcanza con Tab.

### Después de B15: reasignar clientes

**Rol:** admin → Usuarios → "Reasignar clientes".

1. Origen **Ana** (aparece con cuántos clientes) y destino **Contador Demo** (de B6). Cada
   opción lleva nombre y correo.
2. "Reasignar" pide confirmación con cuántos y a quién. "Volver" no mueve nada. Confirma.
   - → Como `contador.demo@example.com`, ves los clientes de Ana.
   - → Ana ya no los ve.
   - → En Mi perfil → "Tus datos", Ana ya podría eliminarse (no lo hagas).
3. **Devuélvelos:** reasigna de **Contador Demo** a **Ana**.
   → Ana vuelve a verlos todos, con sus documentos y conceptos.
4. Si el destino ya tiene un cliente con el mismo número de documento, no se mueve ninguno (409),
   y el mensaje dice cuáles chocan.

## B16: Revisión de conceptos

**Rol:** Ana, después `portal.demo@example.com`.

1. **El estado de cada concepto.** Detalle de María Gómez → Documentos → "Conceptos tributarios
   extraídos".
   → En la columna **Revisión**, los del PDF de B2 dicen **"Extraído por IA · sin revisar"**
   (violeta: es lo que produjo la IA). Los totales dicen "Incluye N conceptos extraídos por IA
   sin revisar".
2. **Revisar.** "Revisar" en la Retención.
   → El monto se edita en la misma fila, con "La IA leyó …" debajo. Escribe `450.000` y pulsa
   "Confirmar".
   → "Revisado", "por Ana Contadora", "Corregido · la IA leyó $500.000". El badge cambia con un
   pequeño efecto, **una sola vez**.
   - Los totales se recalculan y la nota baja.
   - **Recarga:** sigue revisado.
   - "Revisar" en otro concepto, sin cambiar el monto → "Revisado" (de la IA, sin "Corregido").
3. **En la base:**

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT t.concept_type, t.amount, t.ai_amount, t.source, t.reviewed_at, u.name AS revisor FROM tax_concepts t LEFT JOIN users u ON u.id = t.reviewed_by JOIN clients c ON c.id = t.client_id WHERE c.full_name = 'María Gómez'"
   ```

   La base rechaza combinaciones imposibles (migración 026).

4. **El contribuyente** (`portal.demo@example.com`, detalle de su expediente).
   → Solo "Revisado" o "Extraído por IA · sin revisar": sin botón, sin quién lo revisó ni el
   valor de la IA. En Network → `tax-concepts`, la API ni siquiera los envía.
5. **Reprocesar con revisiones (D6).** Si un documento con conceptos revisados ofrece
   "Reintentar análisis":
   → "¿Descartar las revisiones?" con cuántas. "Volver" no cambia nada. Confirmar vuelve a
   extraerlos sin revisar y queda auditado como `document.reprocess.discard_reviews`.

## B17: El documento original (visor para contador y asistente)

**Rol:** Ana (contador) y Luis (asistente). Después el contribuyente y el admin.

1. **Ver original (Ana).** Detalle de María Gómez → Documentos → **"Ver original"** en
   `extracto-demo.png`.
   → El visor, con el nombre como título (recibe el foco) y la imagen tal cual.
   "Cerrar" o Escape → el foco vuelve al botón.
2. **PDF.** "Ver original" en `certificado-demo.pdf`.
   → La página dibujada, "‹ ›" para cambiar de página, "− +" para el zoom y siempre
   "Descargar".
3. **Luis** (asistente de Ana) hace lo mismo.
   → Igual que Ana.
4. **pdf.js solo al abrir un PDF.** En el build (`http://localhost:4173`, ver 0.4), DevTools →
   Network, filtro `pdf`:
   - abrir Documentos → nada;
   - "Ver original" en la imagen → solo `documentViewer-…js`, sin pdf.js;
   - "Ver original" en el PDF → `pdf.min-…mjs` y `pdf.worker.min-…mjs`, del mismo origen.

   En la consola, ninguna violación de CSP: `object-src` y `frame-src` siguen en `'none'`.

5. **Estados.** Si un archivo no está, el visor dice "El archivo original de este documento no
   está disponible." con Reintentar. Los documentos del seed (en Carlos Pérez) no tienen archivo:
   ábrelos para verlo. Un PDF dañado o con contraseña tiene su propio mensaje.
6. **Contribuyente y admin: "Descargar".** Como `portal.demo@example.com`, y después como admin,
   en el detalle de María Gómez → Documentos.
   → "Descargar" en lugar de "Ver original". Baja el archivo con su nombre, sin visor y sin
   pdf.js.
7. **Propiedad del archivo.** Como `contador.demo@example.com` (no atiende a María), pide en
   Swagger `GET /api/documents/{id del PDF}/file`.
   → **404**. Cada vista queda auditada:

   ```bat
   docker exec renta_ia_postgres psql -U postgres -d renta_ia -c "SELECT action, entity_id, created_at FROM audit_log WHERE action = 'document.file.view' ORDER BY created_at DESC LIMIT 5"
   ```

## B18: Vista dividida (contador y asistente)

**Rol:** Ana (y Luis si quieres). El contribuyente y el admin no la tienen.

1. **Lado a lado.** En una ventana de 1200 px o más, "Ver original" en `certificado-demo.pdf`.
   - → El visor a la izquierda, fijo mientras bajas.
   - → A la derecha, el panel **"Conceptos tributarios extraídos"** con solo los conceptos de ese
     documento, en tarjetas.
   - → Arriba, "Conceptos de certificado-demo.pdf: 3 de N. Los totales son de todo el cliente…".
2. **Filtrado al documento.** "Ver original" en `extracto-demo.png`.
   → "Este documento no tiene conceptos extraídos." (la IA no sacó cifras de la imagen).
3. **Revisar al lado del original.** Abre otra vez el PDF y pulsa "Revisar" en un concepto sin
   revisar. Compara con la imagen, escribe el monto y pulsa "Confirmar".
   → Es el mismo formulario y el mismo endpoint de B16 (en Network, un solo `PATCH …/tax-concepts/…`).
   No hay otra forma de editar un concepto.
4. **Al cerrar** (Escape o "Cerrar").
   → Vuelven todos los conceptos, con la revisión aplicada y los totales recalculados. El foco
   vuelve a "Ver original".
5. **Teclado.** Al abrir, el foco está en el título del visor. Tab recorre primero los controles
   del visor y luego los conceptos ("Revisar…").
6. **Pantallas angostas y móvil** (DevTools, 375 y 320 px).
   → El visor arriba y los conceptos debajo, sin desplazamiento horizontal. En las tarjetas de
   Documentos, "Ver original" y "Reintentar análisis" pasan a otra línea en vez de cortarse.

---

## Pruebas automatizadas

Con todo lo anterior hecho a mano, esto es lo que corre solo:

| Repo                | Comando                                                             | Qué cubre                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renta-ia-database` | `scripts\migrate.bat` dos veces                                     | la segunda no aplica nada                                                                                                                                                  |
| `renta-ia-backend`  | `npm test` · `npm run lint` · `npm run typecheck` · `npm run build` | 445 tests de integración y unitarios, incluidas las reglas de la base                                                                                                      |
| `renta-ia-frontend` | `npm test` · `npm run lint` · `npm run build`                       | 252 tests. El build falla si se pasa algún presupuesto (por rol, primera carga, CSS, pdf.js)                                                                               |
| `renta-ia-frontend` | `npm run test:e2e`                                                  | 44 pruebas E2E con Playwright, axe en claro y oscuro y cero violaciones de CSP, contra el stack con IA simulada ([`e2e/README.md`](../../renta-ia-frontend/e2e/README.md)) |

Cada bloque tiene además sus capturas de antes y después en `files/.capturas/B<n>/` y las huellas
de la base en `files/.huellas/` (fuera de los repositorios).

## Lo que no se prueba aquí

Lo que depende de crédito real de Anthropic/Voyage, de un lector de pantalla o del despliegue
está en la lista de **pruebas manuales pendientes** del README raíz.
