# 0007 — Esquema de sesión: access token en memoria + refresh token rotativo en cookie

**Estado:** aceptada (reemplaza al JWT de 1 día guardado en `localStorage`).

## Contexto

Antes, el login devolvía un JWT de 1 día que el frontend guardaba en
`localStorage`: cualquier XSS podía leerlo y usarlo desde otra máquina durante
un día, y cerrar sesión no lo invalidaba en el servidor.

## Decisión

- **Access token:** JWT HS256 de **15 min**, en el cuerpo de la respuesta; el
  navegador lo guarda **solo en memoria** y lo envía en `Authorization: Bearer`.
- **Refresh token:** 32 bytes aleatorios en una **cookie `httpOnly`**,
  `SameSite=Strict`, `Path=/api/auth`, `Secure` en producción; en la base solo
  su **SHA-256** (tabla `refresh_tokens`, migración 014).
- **Rotación** en cada `POST /api/auth/refresh`; **detección de reutilización**:
  si llega un token ya rotado (fuera de una ventana de gracia de 10 s para
  pestañas simultáneas) se revoca toda la familia y se audita.
- **Logout** revoca la familia en el servidor y borra la cookie; avisa a las
  otras pestañas con `BroadcastChannel`.
- **CSRF:** `SameSite=Strict` + encabezado `X-Requested-With: renta-ia` + Origin
  permitido en `/refresh` y `/logout`. CORS con `credentials: true` solo para `CORS_ORIGIN`.
- En el navegador: renovación **single-flight** (un solo `/refresh` aunque
  varias peticiones reciban 401), proactiva un minuto antes de vencer, y al abrir
  la app a partir de una pista sin secretos (`{ id, name, role }`).

## Restricción de despliegue

Con `SameSite=Strict`, el frontend y la API deben ser del **mismo sitio**
(mismo dominio registrable): por ejemplo `app.ejemplo.com` y `api.ejemplo.com`.
Si quedaran en dominios distintos, el navegador no enviaría la cookie y la
sesión no se podría renovar. En local, `localhost:5173` y `localhost:4000` son el
mismo sitio.

## Alternativas consideradas

- **JWT largo en `localStorage` (lo anterior):** robable por XSS y no revocable.
- **Todo en cookie (también el access token):** obliga a protección CSRF en
  toda la API; con `Authorization` solo `/refresh` y `/logout` usan cookie.
- **Sesiones de servidor (id de sesión en cookie + Redis):** válido; se prefirió
  JWT corto para que la API y el WebSocket validen sin consultar Redis en cada
  solicitud, dejando el estado solo en el refresh.

## Consecuencias

- (+) Un XSS no puede leer ni llevarse la sesión; lo que roba dura 15 min.
- (+) Logout real y detección de robo del refresh token.
- (−) Un refresh extra al recargar la página (medido en el navegador: la primera
  vista espera ese `/refresh` antes de pedir datos, sin 401 de más).
- (−) La restricción de mismo sitio condiciona el despliegue.

## Evidencia

`src/modules/auth/sessions.service.ts`, `auth.controller.ts`,
`src/middlewares/csrf.middleware.ts`, `tests/integration/session.test.ts`;
frontend `src/state/store.js`, `src/auth/session.js`, `src/api/http.js`,
`tests/session.test.js`, `e2e/critical-flow.spec.js`.
