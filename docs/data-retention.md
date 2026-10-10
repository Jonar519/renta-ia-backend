# Retención de datos y eliminación de cuentas

Qué guarda Renta IA de cada persona, qué se entrega al **exportar** y qué pasa al **eliminar** la
cuenta (Fase 5, B14). La implementación está en `src/modules/users/account.service.ts`. Las
garantías de la base, en las migraciones `023_account_status_deleted.sql` y
`024_account_deletion.sql`.

Este documento describe lo que hace el sistema **hoy**.

## La regla de fondo: la cuenta eliminada queda como lápida

La fila de `users` **nunca se borra**: pasa a `status = 'deleted'` y se vacía. Hay tres motivos:

1. **`documents.uploaded_by` es `ON DELETE RESTRICT`.** Un documento (un certificado de ingresos,
   un extracto) es parte del **expediente del cliente**, no de quien lo subió. Borrar la cuenta
   no puede borrar el documento, y el documento tiene que seguir teniendo un autor. La base no
   deja borrar la fila de alguien que subió documentos, y la política lo respeta: el documento
   queda con su autor, que ahora se llama "Cuenta eliminada".
2. **`clients.accountant_user_id` también es `RESTRICT`.** Un cliente siempre tiene un contador.
   Desde 024, además, ese contador tiene que estar **activo** (FK compuesta
   `fk_clients_active_accountant`). Por eso, un contador con clientes no puede eliminar su
   cuenta (ver más abajo).
3. **Auditoría.** `audit_log.user_id` es `ON DELETE SET NULL`. Borrar la fila dejaría registros
   sin autor. Con la lápida, cada registro sigue apuntando a "Cuenta eliminada".

Lo que queda en la lápida, garantizado por la base:

| Columna                    | Valor en una cuenta eliminada                     | Quién lo garantiza                                   |
| -------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| `status`, `deleted_at`     | `deleted`, fecha de eliminación                   | `chk_users_deleted_at`                               |
| `name`                     | `Cuenta eliminada`                                | `chk_users_deleted_scrubbed`                         |
| `email`                    | `eliminada-<id>@renta-ia.invalid` (no existe)     | `chk_users_deleted_scrubbed`                         |
| `phone`, `avatar_key`      | `NULL`                                            | `chk_users_deleted_scrubbed`                         |
| `password_hash`            | `NULL` (nadie puede entrar)                       | `chk_users_password_by_status`                       |
| `role`, `id`, `created_at` | se conservan (el rol explica qué hacía la cuenta) | —                                                    |
| Sesiones, MFA, tokens      | no puede tener ninguno                            | FK compuestas de 017-022: exigen `status = 'active'` |

El correo anterior **queda libre**: un admin puede volver a invitar a esa dirección y se crea una
cuenta nueva, sin relación con la anterior.

## Eliminar la cuenta

`POST /api/users/me/deletion` (pantalla: Mi perfil → "Tus datos"). Exige:

- la **contraseña** actual (un fallo cuenta en el bloqueo progresivo, como en el login);
- si la cuenta tiene verificación en dos pasos, un **código** de la app o uno de recuperación.

No se puede eliminar (409, y la pantalla lo dice antes de pedir la contraseña) en estos casos:

- **Un contador con clientes a su cargo.** Primero un admin los **reasigna** a otro contador
  (Usuarios → "Reasignar clientes": se mueven todos, con sus documentos, alertas y
  conversaciones), o el contador los elimina. La base lo impide por su cuenta: un cliente exige
  un contador activo.
- **El único administrador activo.** Sin otro admin, nadie podría invitar ni restablecer el MFA
  de nadie.

Qué pasa, en una sola transacción:

| Dato                                                     | Qué se hace                                                                                                           | Por qué                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Nombre, correo, teléfono, contraseña                     | se vacían (lápida)                                                                                                    | datos personales                                                       |
| Foto de perfil                                           | se borra el archivo                                                                                                   | dato personal                                                          |
| Sesiones y refresh tokens (`user_sessions`)              | se borran: todas las sesiones dejan de servir                                                                         | la lápida no puede tener sesiones (FK)                                 |
| MFA (secreto, códigos de recuperación, pasos del login)  | se borran                                                                                                             | idem                                                                   |
| Enlaces de recuperación y de cambio de correo            | se borran                                                                                                             | idem                                                                   |
| Vínculos asistente ↔ contador                            | se borran                                                                                                             | ya no hay persona que asista                                           |
| Usuario de portal de un cliente                          | el cliente queda sin usuario de portal                                                                                | el cliente sigue siendo del contador                                   |
| Conversaciones con la IA que inició (`ai_conversations`) | se borran, con sus mensajes                                                                                           | son sus preguntas                                                      |
| Correos guardados para esa dirección (`email_outbox`)    | se borran (incluido un cambio de correo pendiente)                                                                    | contienen su dirección y, en el proveedor simulado, el cuerpo          |
| Contador de intentos fallidos (`login_attempts`)         | se borra                                                                                                              | ya no hay cuenta que proteger                                          |
| **Documentos que subió**                                 | **se conservan**, con autor "Cuenta eliminada"                                                                        | son del expediente del cliente (`RESTRICT`)                            |
| **Registros de auditoría** (`audit_log`)                 | **se conservan** 12 meses, con la IP **recortada** (/24 en IPv4, /48 en IPv6) y el navegador como "Chrome en Windows" | seguridad: "yo no hice eso", sin que la lápida guarde un dato personal |
| Clientes, alertas y conceptos                            | no se tocan                                                                                                           | son del contador                                                       |

Además:

- **No se envía un correo de aviso.** Enviarlo exigiría guardar la dirección en `email_outbox`
  justo después de borrarla. La confirmación se muestra en pantalla.
- Se registra `user.account.delete` en la auditoría, ya recortado como el resto de sus filas.
- Solo se recortan **sus** filas (las que hizo la cuenta). Lo que otra cuenta hizo sobre la suya
  (por ejemplo, un admin que restableció su MFA) es dato de esa otra persona y no se toca.
- Antes de recortar se esperan los registros de auditoría que estuvieran en vuelo: si no, uno
  podría escribirse después, con la IP completa.
- La respuesta borra la cookie de sesión del navegador.

## Exportar mis datos

`POST /api/users/me/export` (pide la contraseña: una sesión robada no basta) devuelve un JSON
descargable, `renta-ia-mis-datos-AAAA-MM-DD.json`, con formato `renta-ia-export-v1`:

- **Cuenta:**
  - nombre, correo, teléfono, rol y fechas;
  - un cambio de correo pendiente, si lo hay;
  - la foto, como `data:` URI.
- **Verificación en dos pasos:** si está activa, desde cuándo y cuántos códigos de recuperación
  quedan. **Nunca** el secreto ni los códigos.
- **Sesiones activas:** IP recortada, ubicación aproximada y equipo (B13).
- **Actividad** (`audit_log`): lo que hizo la persona, con IP y navegador, y lo que otras cuentas
  hicieron **sobre la suya** (por ejemplo, un admin que restableció su MFA). De esto último se
  entregan la acción y la fecha, **sin** la IP ni el navegador de la otra persona.
- **Conversaciones con la IA** que inició, con sus mensajes.
- **Documentos que subió:** solo metadatos (nombre, tipo, estado, fecha), sin los archivos.
- **Vínculos:** a qué contadores asiste o qué asistentes tiene (solo nombres).
- **Usuario del portal:** los datos de **su** cliente (son suyos).
- **Contador:** **cuántos** clientes tiene a cargo, sin sus datos. Los datos de los clientes son
  de esas personas, no del contador.

Nada secreto sale en el export: ni hashes de contraseña o de tokens ni el secreto del MFA. Las
pruebas lo verifican. Se registra `user.data.export`.

## Purga programada

Una tarea diaria del worker (`data-retention`, 03:45 hora de Colombia, junto a la de Web Vitals;
`src/services/retention/retention.service.ts`) borra lo vencido. Cada plazo protege algo:

| Dato                                            | Se borra                                               | Por qué ese plazo                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `audit_log`                                     | a los **12 meses**                                     | decisión del usuario: suficiente para investigar un "yo no hice eso"                                      |
| Sesiones (`user_sessions`, con sus tokens)      | sin ningún token vigente y **30 días** sin actividad   | una sesión cerrada sigue visible un tiempo para quien revisa qué pasó                                     |
| Refresh tokens                                  | **7 días** después de vencer                           | los rotados de una sesión ACTIVA se quedan mientras sirven: detectan el robo por reutilización (ADR 0007) |
| Enlaces de recuperación y de cambio de correo   | **7 días** después de vencer, usados o no              | ya no sirven (ADR 0012); solo se guardaba su hash                                                         |
| Pasos del login con MFA (`mfa_challenges`)      | **1 día** después de vencer                            | duran 5 minutos                                                                                           |
| `email_outbox`                                  | a los **30 días**                                      | guarda direcciones y, con el proveedor simulado, el cuerpo del correo                                     |
| Intentos fallidos (`login_attempts`)            | **30 días** sin fallos, si la cuenta no está bloqueada | el bloqueo progresivo solo mira fallos recientes                                                          |
| Web Vitals (`web_vitals`, sin datos personales) | a los **90 días** (tarea `web-vitals-retention`)       | métricas de rendimiento                                                                                   |

**No se purgan las invitaciones.** Una invitación vencida es lo que "Usuarios" muestra como
"vencida" (para reenviarla o cancelarla) y mantiene ligada la cuenta pendiente.

Las pruebas (`tests/integration/retention.test.ts`) crean, para cada categoría, un dato viejo
(se borra) y uno vigente (se queda), y comprueban que la tarea queda registrada.
