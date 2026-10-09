/**
 * Ubicación aproximada de una IP (regla de proveedores externos, Fase 5;
 * decisión D2). El resto del código solo conoce esta interfaz y obtiene la
 * implementación de services/geoip/index.ts. Hoy hay dos:
 *  - mock (por defecto): no consulta nada; las IP locales (loopback, redes
 *    privadas) son "Red local" y cualquier otra queda sin ubicación.
 *  - dbip: la base gratuita DB-IP Lite (CSV de ciudades o de países, licencia
 *    CC BY 4.0) cargada en memoria desde un archivo local; se activa cuando se
 *    descarga el archivo (GEOIP_PROVIDER=dbip + GEOIP_DBIP_CSV). No hay
 *    llamadas a servicios externos: la IP nunca sale del servidor.
 *
 * Es APROXIMADA: la ciudad de la IP suele ser la del proveedor de internet,
 * no la de la persona. La pantalla lo dice así.
 */
export interface GeoIpProvider {
  readonly name: "mock" | "dbip";
  /** Etiqueta para mostrar ("Bogotá, Colombia"), o null si no se sabe. */
  lookup(ip: string): string | null;
}
