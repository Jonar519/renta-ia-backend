# 0009 — Cuentas pendientes garantizadas por el esquema (FK compuesta)

**Estado:** aceptada (Fase 5, bloque B4; migración `017_account_status_and_invitations.sql`).

## Contexto

Desde la Fase 5 las cuentas se crean **solo por invitación** de un administrador: la cuenta
nace "pendiente", sin contraseña, y la persona invitada define la suya al activarla. La regla
pedida es que **una cuenta pendiente nunca pueda tener sesiones, tokens de recuperación ni
pasos de MFA, solo su token de invitación**, y que eso lo garantice **la base de datos**, no
solo el backend: un bug futuro del backend (o alguien con acceso SQL) no debe poder saltárselo.

El obstáculo: un `CHECK` de PostgreSQL solo ve la fila de su propia tabla. No puede mirar el
estado de la cuenta en `users` desde `refresh_tokens`.

## Decisión

Usar una **clave foránea compuesta contra un par (id, estado)**, de forma declarativa y sin
triggers:

- `users.status account_status` (`invited` | `active`) con
  `CHECK ((status = 'invited' AND password_hash IS NULL) OR (status = 'active' AND password_hash IS NOT NULL))`
  y `UNIQUE (id, status)` como destino de las FK.
- Cada tabla "de cuenta activa" (hoy `refresh_tokens`; en B7 la de recuperación y en B8 las de
  MFA) lleva `user_status account_status NOT NULL DEFAULT 'active' CHECK (user_status = 'active')`
  y `FOREIGN KEY (user_id, user_status) REFERENCES users (id, status) ON DELETE CASCADE ON UPDATE NO ACTION`.
- `user_invitations` usa el mismo patrón con `'invited'`, más vigencia máxima de 72 h
  (`CHECK`), una sola invitación vigente por cuenta (índice único parcial) y solo el SHA-256
  del token.

Qué impide cada pieza:

| Intento                                                           | Lo impide                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| Crear una sesión para una cuenta pendiente                        | La FK busca `(id, 'active')`: no existe                             |
| Forzar `user_status = 'invited'` en la sesión                     | `CHECK (user_status = 'active')`                                    |
| Volver pendiente una cuenta con sesiones (aunque estén revocadas) | La FK es `ON UPDATE NO ACTION`: el `UPDATE` de `users.status` falla |
| Pendiente con contraseña, o activa sin ella                       | `chk_users_password_by_status`                                      |
| Invitar a una cuenta activa                                       | FK de `user_invitations` con `(id, 'invited')`                      |
| Activar una cuenta sin consumir su invitación                     | La misma FK: la invitación debe borrarse en la misma transacción    |

## Alternativas consideradas

- **Solo validación en el backend:** no cumple el requisito; un bug o un acceso SQL lo saltan.
- **Triggers `BEFORE INSERT/UPDATE`:** funcionan, pero son código imperativo que se puede
  desactivar (`ALTER TABLE … DISABLE TRIGGER`) y que no aparece en el esquema como
  restricción. La FK compuesta es una restricción declarativa que PostgreSQL verifica siempre.
- **Tablas separadas para cuentas pendientes y activas:** duplica columnas y complica las FK
  del resto del modelo (clientes, documentos, auditoría…).

## Consecuencias

- (+) La garantía vive en el esquema; `tests/integration/accountStatus.test.ts` la ataca con SQL directo.
- (+) Bajar una cuenta a pendiente exige borrar antes sus sesiones: no puede quedar una sesión "huérfana".
- (−) Cada tabla nueva de cuenta activa debe repetir el patrón (está documentado en la
  migración 017 y lo revisan las pruebas de B7 y B8).
- (−) Una columna extra (`user_status`, siempre igual) por fila en esas tablas.
- (−) Prisma necesita la relación compuesta en `schema.prisma` (`@@unique([id, status])` y
  `@relation(fields: [userId, userStatus], references: [id, status])`).

## Evidencia

- `tests/integration/accountStatus.test.ts` (19 pruebas con SQL directo), incluidas las
  pedidas: crear una sesión para una cuenta pendiente y volver pendiente una cuenta con sesiones.
- Mutaciones B4: quitar cada `CHECK`, volver simple cada FK, alargar la vigencia o quitar el
  índice único hace fallar la prueba correspondiente.
- Demostración sobre la base de desarrollo, dentro de una transacción con `ROLLBACK`
  (`docs/demo-fase5.md`, B4).
