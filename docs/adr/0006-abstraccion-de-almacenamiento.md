# 0006 — Abstracción de almacenamiento de archivos

**Estado:** aceptada (implementación S3 pendiente, fuera del alcance del Proyecto 1).

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

## Alternativas consideradas

- **Llamar a `fs` directamente:** más simple hoy, pero el cambio a S3 tocaría
  el servicio de documentos y el worker.
- **Guardar el archivo en PostgreSQL (`bytea`):** infla la base y sus backups.

## Consecuencias

- (+) Pasar a S3 será agregar `s3-storage.service.ts` y cambiar una variable.
- (−) En local, API y worker deben compartir el disco (misma máquina).
- (−) Sin cifrado en reposo en local (riesgo aceptado en `docs/threat-model.md`).

## Evidencia

`src/services/storage/storage.interface.ts`, `src/services/storage/index.ts`,
`src/services/storage/local-storage.service.ts`.
