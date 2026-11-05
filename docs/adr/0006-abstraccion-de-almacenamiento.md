# 0006 — Abstracción de almacenamiento de archivos

**Estado:** aceptada. Generalizada en la Fase 5 (B12) para la foto de perfil. Implementación S3 (Cloudflare R2) agregada el 5-11-2026 para el despliegue (rama `feat/almacenamiento-s3`).

## Contexto

En desarrollo los documentos se guardan en disco; en producción irán a un
almacenamiento de objetos (S3). El worker, que corre en otro proceso (y en
producción en otra máquina), necesita leer el mismo archivo.

## Decisión

- Interfaz `StorageService` con `save`, `readAsBuffer` y `delete`.
- Implementación `local` (disco) seleccionada con `STORAGE_DRIVER`; ningún
  módulo importa la implementación directamente, siempre `storageService`.
- La **clave** del archivo la genera el servidor (`clients/<clientId>/documents/<timestamp>-<nombre saneado>`,
  con `clientId` validado como UUID)
  y la implementación local verifica que la ruta resultante no salga de su
  carpeta (defensa contra path traversal).

## Generalización (Fase 5, B12)

La interfaz pasó de `save({ buffer, clientId, fileName })` (solo documentos) a
`save({ key, buffer })`. Las claves se arman **solo** en `src/services/storage/keys.ts`:

- `storageKeys.document(clientId, nombre)`: `clients/<clientId>/documents/<timestamp>-<16 hex>-<nombre>`.
  El sufijo aleatorio llegó en `fix/dedupe-estable`: dos subidas del mismo nombre en el mismo
  milisegundo compartían archivo. Las claves anteriores siguen valiendo; documentos y worker no
  cambiaron.
- `storageKeys.avatar(userId, tipo)`: `users/<userId>/avatar/<timestamp>-<16 hex>.<jpg|png>`.

Las dos validan el UUID, y la implementación local sigue verificando que la ruta no salga de su
carpeta. Ningún dato del cliente llega tal cual a la ruta. Pasar a S3 sigue siendo implementar
`save`, `readAsBuffer` y `delete`.

## Implementación S3 (despliegue, 5-11-2026)

En Railway, la API y el worker son **servicios distintos** y un volumen solo se monta en uno:
con `local`, el worker no vería los archivos que sube la API. Por eso el despliegue usa
`STORAGE_DRIVER=s3` contra **Cloudflare R2**, compatible con S3.

- `src/services/storage/s3-storage.service.ts` implementa los mismos tres métodos con
  `@aws-sdk/client-s3`, que tiene la misma versión que `client-sesv2`.
- **Mismas garantías que el local:**
  - la clave se vuelve a validar antes de llamar a S3: sin `..` ni `.`, sin barra inicial
    ni invertida, sin segmentos vacíos ni caracteres de control;
  - nunca se pisa un objeto: `PutObject` con `IfNoneMatch: "*"`, el equivalente del flag
    `wx`. Un 412 se traduce a `StorageKeyExistsError`.
- **Credenciales propias** (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`): nunca la cadena por
  defecto del SDK, que tomaría las `AWS_*` de SES.
- **Con `S3_ENDPOINT` (R2):**
  - estilo de ruta y región `auto` por defecto;
  - checksums solo cuando la operación los exige, porque los checksums por defecto de las
    versiones nuevas del SDK no los aceptan todos los servicios compatibles.
- `env.ts` valida `STORAGE_DRIVER` (`local` | `s3`) al arrancar y exige las variables de S3.
- **Probado** con un doble del cliente (`tests/unit/s3Storage.test.ts`, sin red).
- **No probado contra R2 real** (no hay credenciales todavía). Se verifica en el ensayo:
  1. subir, leer y borrar;
  2. que el worker lea lo que subió la API;
  3. que un segundo `PutObject` con la misma clave dé 412.

  Si R2 no aceptara `If-None-Match` en `PutObject`, la salida es quitar esa condición y
  dejar la protección en la clave: ya lleva marca de tiempo y 16 caracteres hex aleatorios.

## Alternativas consideradas

- **Llamar a `fs` directamente:** más simple hoy, pero el cambio a S3 tocaría
  el servicio de documentos y el worker.
- **Guardar el archivo en PostgreSQL (`bytea`):** infla la base y sus backups.

## Consecuencias

- (+) Pasar a S3 fue agregar `s3-storage.service.ts` y cambiar una variable: documentos y worker no cambiaron.
- (−) Con `local`, la API y el worker deben compartir el disco (misma máquina). En el despliegue se usa `s3`.
- (−) Sin cifrado en reposo en local (riesgo aceptado en `docs/threat-model.md`).

## Evidencia

`src/services/storage/storage.interface.ts`, `src/services/storage/index.ts`,
`src/services/storage/local-storage.service.ts`, `src/services/storage/s3-storage.service.ts`,
`src/services/storage/keys.ts`; pruebas en `tests/integration/avatar.test.ts` ("StorageService
generalizado") y `tests/unit/s3Storage.test.ts`.
