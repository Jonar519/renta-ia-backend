# 0010 — Proveedores externos intercambiables, con simulado por defecto

**Estado:** aceptada (Fase 5, bloque B4). Aplica al correo (hoy) y a la geolocalización por IP (B13).

## Contexto

La Fase 5 necesita enviar correos (invitaciones, recuperación de contraseña, cambio de correo)
y, más adelante, ubicar aproximadamente una IP. Las credenciales reales se cargan al cierre
conjunto del curso, junto con las de IA. El desarrollo no puede bloquearse por no tenerlas, y
las pruebas y demos necesitan leer lo que se "envió" sin un servidor de correo.

## Decisión

- Interfaz `EmailProvider` (`services/email/email.interface.ts`) con un único punto de entrada
  (`services/email/index.ts`). Ningún módulo importa un adaptador concreto.
- **`mock`, el valor por defecto fuera de producción**: no envía nada y guarda cada correo
  **completo** en la tabla `email_outbox`. Está prohibido con `NODE_ENV=production` (`env.ts`
  no arranca y la fábrica lo vuelve a comprobar).
- **`ses` (Amazon SES v2)**, consistente con el despliegue en AWS (decisión D2):
  - `EMAIL_PROVIDER=ses` exige `SES_REGION` y `EMAIL_FROM` al arrancar; en producción es el
    valor por defecto.
  - El SDK de AWS se carga con import dinámico en el primer envío: con el simulado, ni se carga.
  - Las credenciales las resuelve el SDK (variables `AWS_*`, perfil o rol IAM). Sin ellas el
    envío falla al resolverlas, **antes de cualquier llamada a SES**, y queda registrado como
    `failed`.
  - En `email_outbox` solo guarda metadatos. La base lo impone:
    `CHECK (provider = 'mock' OR (body_text IS NULL AND body_html IS NULL))`.

## El token en claro en `email_outbox`

El correo de invitación lleva el enlace con el token, y la regla dice que en la base solo se
guarda su hash. El simulado guarda el cuerpo completo **a propósito**: es lo que permite a las
pruebas y demos leer el enlace. Es una excepción acotada:

- solo existe en desarrollo y pruebas (el simulado está prohibido en producción);
- en producción (SES) la base rechaza guardar cuerpos;
- el token sigue siendo de un solo uso y con vencimiento, así que leerlo de la bandeja de
  desarrollo no sirve después de usarlo o de 72 h.

## Alternativas consideradas

- **SMTP genérico (nodemailer):** igual de intercambiable, pero en AWS SES evita gestionar
  credenciales SMTP aparte y se integra con el rol IAM del despliegue.
- **Servidor SMTP falso (MailHog/Mailpit) en Docker:** otra pieza de infraestructura, y sus
  correos no se pueden consultar con SQL desde las pruebas.
- **Elegir el proveedor según haya o no credenciales:** se descartó. Un `EMAIL_PROVIDER=ses`
  mal configurado debe fallar al arrancar, no caer en silencio al simulado.

## Consecuencias

- (+) Activar SES al cierre del curso es configurar tres variables más las credenciales del rol IAM.
- (+) Las pruebas leen los correos con una consulta (`email_outbox`).
- (−) Hay que verificar el remitente y el dominio en SES y salir del sandbox antes de producción.

## Evidencia

`tests/integration/email.test.ts`: simulado por defecto con el contenido completo, el SDK sin
cargar, `env.ts` rechazando las configuraciones inválidas, traducción a SES v2 con un cliente
inyectado (sin red), fallo registrado sin cuerpo, y el SES real sin credenciales fallando con
`CredentialsProviderError` en milisegundos.
