# 0011 — Segundo factor con TOTP propio, secreto cifrado y login en dos pasos

**Estado:** aceptada (Fase 5, bloque B8; migración `019_mfa.sql`).

## Contexto

Las cuentas de Renta IA dan acceso a información tributaria de terceros. Una contraseña
filtrada (reutilizada en otro sitio, phishing) no debe bastar para entrar. Se pide un
segundo factor que funcione con las apps de autenticación habituales (Google o Microsoft
Authenticator, 1Password, Aegis) y que no dependa de un proveedor externo de SMS o correo.

## Decisión

1. **TOTP (RFC 6238) implementado con `crypto` de Node, sin dependencias.** Son unas 40
   líneas (HOTP, truncamiento dinámico, base32). Se verifica contra los vectores de prueba
   oficiales de los RFC 4226 y 6238 (`tests/unit/totp.test.ts`) y, aparte, contra una
   segunda implementación independiente en una prueba de humo sobre el servidor real.
   Parámetros estándar: HMAC-SHA1, 6 dígitos, pasos de 30 s y ±1 paso de tolerancia.
2. **Anti-replay:** se guarda el último paso aceptado (`last_used_step`). Un código solo
   sirve una vez, y la actualización es condicional (dos peticiones con el mismo código a la
   vez: gana una).
3. **El secreto se guarda cifrado con AES-256-GCM.** La clave está en la variable de entorno
   `MFA_ENCRYPTION_KEY` (32 bytes en base64) y nunca en la base. Quien obtenga un volcado
   de la base no puede generar códigos.
   - El id de la cuenta va como datos asociados (AAD): copiar el secreto cifrado de una
     cuenta a otra hace fallar el descifrado.
   - Formato versionado (`v1.`), para poder rotar la clave más adelante.
   - Obligatoria en producción, opcional fuera de ella: sin la clave la API arranca y solo
     MFA responde 503 explicando qué falta.
4. **Login en dos pasos.** Si la contraseña es correcta y hay MFA, no se crea sesión ni
   cookie: se entrega un _paso de verificación_ (token firmado con propósito propio, de un
   solo uso, válido 5 minutos y con 5 intentos como máximo; la base lo impone).
   - Cada código fallido suma al bloqueo progresivo de la cuenta, el mismo de las
     contraseñas.
   - Hay además un límite por IP.
5. **Reconfirmar para cambiar el MFA:**
   - configurarlo o desactivarlo pide la contraseña actual;
   - activarlo o regenerar los códigos de recuperación pide un código de la app;
   - desactivarlo pide también un código, que puede ser uno de recuperación.

   Así una sesión robada no basta para quitarle el segundo factor a su dueño ni para poner
   uno propio.

6. **Activar MFA cierra las demás sesiones** de la cuenta: se abrieron con un solo factor.
   Reutiliza la verificación de sesión por petición (`sid`) de B7.
7. **10 códigos de recuperación** de 80 bits, de un solo uso. Se muestran una vez
   (`Cache-Control: no-store`) y en la base solo queda su SHA-256: con 80 bits de
   entropía no hace falta un hash lento.
8. **Un admin puede restablecer el MFA de otra cuenta** (nunca el suyo) cuando la persona
   perdió el teléfono y los códigos. Se borra el segundo factor y se cierran sus sesiones;
   el admin no ve ni define ningún secreto. Queda auditado.
9. **Mismo patrón de esquema que la [ADR 0009](0009-cuentas-pendientes-garantizadas-por-el-esquema.md):**
   - `user_mfa` tiene FK compuesta a `users (id, status)` con estado `active`;
   - los códigos y los pasos del login cuelgan de `user_mfa`;
   - por lo tanto, una cuenta pendiente no puede tener ninguno de los tres.

## Alternativas consideradas

- **Librería (`otplib`, `speakeasy`).** Ahorra poco código y agrega una dependencia en una
  parte sensible; `speakeasy` además está sin mantenimiento. Lo propio es pequeño y está
  verificado contra los vectores oficiales.
- **Secreto en claro en la base.** Sería simple, pero un volcado de la base anularía el
  segundo factor de todas las cuentas.
- **Derivar la clave de `JWT_SECRET`.** Evita una variable nueva, pero mezcla dos secretos
  con ciclos de vida distintos: rotar el de los JWT dejaría todos los MFA inservibles.
- **SMS o correo como segundo factor.** SMS es vulnerable a SIM swapping y requiere un
  proveedor de pago. Un código por correo protege poco si el correo es lo que se comprometió.
- **WebAuthn / passkeys.** Es más fuerte contra phishing, pero exige un flujo distinto en el
  frontend y más tiempo. Puede sumarse después sin cambiar este diseño.

## Consecuencias

- **Perder `MFA_ENCRYPTION_KEY` deja todos los MFA inservibles.** Las cuentas afectadas
  tendrían que restablecerse una por una vía admin. La clave se trata como un secreto de
  producción (gestor de secretos, copia de respaldo). La rotación queda prevista por el
  formato `v1.`, pero no implementada.
- **Restablecer la contraseña no quita el MFA.** Quien recupera su contraseña sigue
  necesitando el código, así que el correo, por sí solo, no da acceso.
- **El login con MFA responde 200 con `mfaRequired`.** Eso revela que la contraseña era
  correcta, algo inherente a cualquier login en dos pasos y mitigado por el bloqueo y los
  límites.
- **MFA obligatorio para administradores.** El backend ya expone el dato
  (`mfaRequired` en la invitación); exigirlo queda para el bloque B9, junto con las
  pantallas. Hacerlo en B8 dejaría a los admins sin poder entrar mientras no existe la
  interfaz del segundo paso.

## Evidencia

- `tests/unit/totp.test.ts`: vectores de los RFC, ventana, anti-replay, AES-GCM con AAD y
  la validación de la clave al arrancar.
- `tests/integration/mfa.test.ts`: cada regla, rota a propósito, más las restricciones SQL
  de la migración 019.
- `tests/integration/mfaRateLimit.test.ts`: límites por IP y por usuario.
