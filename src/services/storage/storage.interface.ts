export interface SaveFileInput {
  buffer: Buffer;
  clientId: string;
  fileName: string;
}

export interface StorageService {
  /** Guarda el archivo y devuelve el storageKey (ruta relativa/identificador) */
  save(input: SaveFileInput): Promise<string>;
  /** Lee el archivo de vuelta como Buffer, a partir de su storageKey */
  readAsBuffer(storageKey: string): Promise<Buffer>;
}
