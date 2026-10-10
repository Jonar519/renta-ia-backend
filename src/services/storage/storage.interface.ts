/**
 * Almacenamiento de archivos (ADR 0006). La CLAVE la arma siempre el servidor
 * con storageKeys (keys.ts): nunca viene del cliente. Así, la misma interfaz
 * sirve a documentos y avatares, y pasar a S3 (Fase 6) es implementar estos
 * tres métodos.
 */
export interface SaveFileInput {
  /** Ruta relativa armada por storageKeys (p. ej. "users/<id>/avatar/…"). */
  key: string;
  buffer: Buffer;
}

export interface StorageService {
  /** Guarda el archivo en `key` y devuelve esa misma clave. */
  save(input: SaveFileInput): Promise<string>;
  /** Lee el archivo de vuelta como Buffer, a partir de su clave. */
  readAsBuffer(storageKey: string): Promise<Buffer>;
  /** Borra el archivo (no falla si ya no existe). */
  delete(storageKey: string): Promise<void>;
}
