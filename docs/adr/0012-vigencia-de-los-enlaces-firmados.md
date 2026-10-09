# 0012 — Vigencia de cada enlace o paso firmado

**Estado:** aceptada (Fase 5; reúne lo decidido en B4, B7, B8 y B11).

## Contexto

La Fase 5 usa cuatro tokens firmados (`src/utils/signedToken.ts`). Todos comparten el mismo
diseño:

- firma HMAC con una clave derivada del propósito;
- un solo uso;
- en la base, solo el SHA-256;
- el token viaja en el fragmento `#` del enlace y en el cuerpo de las peticiones.

Lo que cambia es **cuánto tiempo sirven**. La pregunta para cada uno es la misma: si alguien
se queda con el enlace, ¿qué consigue y durante cuánto tiempo? Y, a la vez, ¿cuánto necesita
de verdad la persona legítima para usarlo? La base impone cada vigencia con un `CHECK`, así
que ni un bug del backend puede alargarla.

## Decisión

| Token                            | Vigencia              | Qué da a quien lo tenga                                               | Por qué esa vigencia                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paso de MFA del login (019)      | **5 min**, 5 intentos | La sesión, **solo** con un código válido de la app                    | La persona ya está frente a la pantalla con el teléfono en la mano: el paso dura lo que dura un login. Más tiempo solo daría más margen para adivinar códigos.                                                                                                                                                                                                                                                                                    |
| Recuperación de contraseña (018) | **15 min**            | **Toda la cuenta**: define una contraseña nueva sin saber la anterior | Es el token más poderoso: no exige nada más que el enlace. Lo pide la propia persona, que está esperando el correo, así que 15 minutos bastan. Si el buzón está comprometido o el correo se reenvía, la ventana de abuso es mínima. Si vence, se pide otro en segundos.                                                                                                                                                                           |
| Cambio de correo (020)           | **24 h**              | Solo **confirmar** un cambio que ya pidió la dueña de la cuenta       | No da acceso a la cuenta. El cambio lo pidió alguien con sesión iniciada **y** la contraseña actual, y el enlace solo prueba que el correo nuevo es suyo. Ese correo puede ser uno que no revisa a cada momento (el corporativo, otro dispositivo), así que exigirle 15 minutos haría fallar cambios legítimos. Además, el correo anterior recibe un aviso al pedir el cambio y otro al completarlo, y la dueña puede cancelarlo desde Mi perfil. |
| Invitación (017)                 | **72 h**              | Activar una cuenta **nueva**, todavía sin datos                       | La persona invitada no esperaba el correo: puede llegarle un viernes y abrirlo el lunes. La cuenta pendiente no tiene datos ni sesiones (la base lo impide), y el admin puede reenviar, lo que invalida el enlace anterior, o cancelar.                                                                                                                                                                                                           |

En resumen: **cuanto más da el enlace por sí solo, menos dura.** La recuperación da la cuenta
entera sin otro factor y dura 15 minutos. El cambio de correo necesita, además, un pedido hecho
con la contraseña, así que puede durar 24 horas sin agrandar mucho el riesgo.

## Alternativas consideradas

- **Una sola vigencia para todos (p. ej., 1 h).** Es más simple, pero sería demasiado larga
  para la recuperación y demasiado corta para invitaciones y cambios de correo, que dependen de
  cuándo la persona mire un buzón que quizá no usa a diario.
- **Cambio de correo de 15 min, como la recuperación.** Su riesgo es distinto (ya exige
  contraseña y sesión) y fallaría más a menudo por un motivo legítimo.

## Consecuencias

- Cada vigencia vive en dos lugares sincronizados: la constante del servicio y el `CHECK` de la
  base. Las pruebas rompen ambos, mutando la constante y el `CHECK`.
- Un enlace vencido siempre responde lo mismo, "no es válido o ya venció" (410), y la pantalla
  ofrece pedir otro.

## Evidencia

- **Vigencias impuestas por la base:**
  - `chk_mfa_challenges_expiry` (019);
  - `chk_password_reset_tokens_expiry` (018);
  - `chk_email_change_tokens_expiry` (020);
  - `chk_user_invitations_expiry` (017).
- **Pruebas que las rompen:**
  - `tests/integration/mfa.test.ts`;
  - `passwordReset.test.ts`;
  - `profile.test.ts`;
  - `invitations.test.ts`.
