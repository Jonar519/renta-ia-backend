# Registros de decisiones de arquitectura (ADR)

Cada ADR explica una decisión: el contexto, lo que se decidió, las alternativas
y sus consecuencias (buenas y malas). Viven aquí, en el backend, aunque algunas
tratan del frontend o de la base de datos, para tener un solo lugar donde buscarlas.

| #                                                              | Decisión                                                                              | Estado   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------- |
| [0001](0001-js-sin-framework-y-router-hash.md)                 | Frontend en JavaScript sin framework, con router por hash                             | Aceptada |
| [0002](0002-base-de-datos-en-repo-aparte.md)                   | Base de datos en un repositorio aparte, con migraciones SQL                           | Aceptada |
| [0003](0003-prisma-solo-como-cliente.md)                       | Prisma solo como cliente (no gestiona el esquema)                                     | Aceptada |
| [0004](0004-bullmq.md)                                         | Cola de trabajos con BullMQ sobre Redis                                               | Aceptada |
| [0005](0005-pgvector.md)                                       | Búsqueda semántica con pgvector dentro de PostgreSQL                                  | Aceptada |
| [0006](0006-abstraccion-de-almacenamiento.md)                  | Abstracción de almacenamiento de archivos                                             | Aceptada |
| [0007](0007-esquema-de-sesion.md)                              | Esquema de sesión: access token en memoria + refresh token rotativo en cookie         | Aceptada |
| [0008](0008-politica-de-cache.md)                              | Política de caché: nada de la API en cachés; shell y assets con Service Worker        | Aceptada |
| [0009](0009-cuentas-pendientes-garantizadas-por-el-esquema.md) | Cuentas pendientes garantizadas por el esquema (FK compuesta)                         | Aceptada |
| [0010](0010-proveedores-externos-intercambiables.md)           | Proveedores externos intercambiables, con simulado por defecto                        | Aceptada |
| [0011](0011-mfa-totp.md)                                       | Segundo factor con TOTP propio, secreto cifrado y login en dos pasos                  | Aceptada |
| [0012](0012-vigencia-de-los-enlaces-firmados.md)               | Vigencia de cada enlace o paso firmado (5 min · 15 min · 24 h · 72 h)                 | Aceptada |
| [0013](0013-sesiones-activas.md)                               | Sesiones activas: qué se guarda (IP recortada, ubicación aproximada) y cómo se cierra | Aceptada |

Formato: Contexto · Decisión · Alternativas consideradas · Consecuencias · Evidencia.
