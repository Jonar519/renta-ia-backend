# 0013 — Sesiones activas: qué se guarda y cómo se cierra

**Estado:** propuesta (Fase 5, B13; pendiente de la revisión del checkpoint).

## Contexto

Cada persona debe poder ver dónde está abierta su cuenta y cerrar lo que no reconozca. Una
sesión ya existía como **familia de refresh tokens** (`family_id`, el `sid` del access token;
ADR 0007), pero sin ningún dato para reconocerla. Hay que decidir qué datos guardar, cómo
mantenerlos y qué tan rápido surte efecto un cierre.

Una restricción práctica: la base de desarrollo la comparten la rama de trabajo y `main`, que
sigue creando refresh tokens sin saber nada de esta tabla.

## Decisión

1. **Una fila por sesión en `user_sessions`** (migración 022), con `id = family_id`. FK
   compuesta `(family_id, user_id)` desde `refresh_tokens`: cada token pertenece a una sesión
   de su misma cuenta. Solo cuentas activas, con el mismo patrón de ADR 0009.
2. **Un trigger crea esa fila** con el primer token de la familia y, con cada token nuevo
   (rotación), mueve `last_seen_at` hacia adelante (`GREATEST`). ADR 0009 descarta triggers para
   hacer cumplir reglas. Este trigger no hace cumplir ninguna (de eso se encargan la FK
   compuesta y los `CHECK`): mantiene un dato derivado y hace que la FK se cumpla para cualquier
   versión de la API que escriba tokens. Sin él, la migración rompería el inicio de sesión de
   `main` contra la base compartida.
3. **Datos mínimos.**
   - IP **recortada**: IPv4 sin el último octeto; IPv6, solo el /48. Un `CHECK` impide guardar
     la IP completa.
   - **Ubicación aproximada**, calculada al vuelo con la IP completa, que se descarta.
   - "Navegador en sistema", no el User-Agent completo.
   - Las sesiones anteriores a 022 quedan sin estos datos, y la pantalla las muestra como
     "desconocida".
4. **Geolocalización detrás de una interfaz** (`services/geoip`, regla de proveedores
   externos, decisión D2).
   - `mock` es el valor por defecto: solo reconoce IP locales y nunca inventa una ciudad.
   - `dbip` usa DB-IP Lite en CSV, en memoria, sin llamadas externas: la IP nunca sale del
     servidor.
   - Si el archivo está dañado, la ubicación queda desconocida y la API no se cae.
5. **Cierre inmediato.**
   - Cerrar revoca los tokens de la familia (`session_closed`). Como cada petición verifica el
     `sid` (B7), el access token deja de servir en la siguiente petición.
   - El WebSocket revisa en cada latido (30 s), con **una** consulta, si siguen activas las
     sesiones de todos sus sockets. Esto cubre también Salir y el cambio de contraseña, y
     funciona con varias instancias sin pub/sub.
6. **Sin reautenticación para cerrar.** Cerrar sesiones solo quita acceso. Alguien que use una
   sesión robada podría cerrar la de la dueña, pero ella vuelve a entrar y, al cambiar la
   contraseña, se cierran todas las demás. La sesión actual no se cierra desde aquí: para eso
   está "Salir".

## Consecuencias

- La última actividad tiene la granularidad de la renovación del token (unos 15 minutos
  mientras se usa), y la pantalla lo dice así.
- Una escritura más por inicio de sesión y por rotación (la actualización de IP, ubicación y
  equipo), dentro de la misma transacción.
- Con DB-IP Lite, la base de ciudades ocupa memoria en cada instancia de la API. Para
  producción conviene medirla antes; la de países es mucho más liviana.
