import { env } from "../../config/env";
import { createDbIpGeoIpProvider } from "./dbip.provider";
import type { GeoIpProvider } from "./geoip.interface";
import { createMockGeoIpProvider } from "./mock.provider";

export type { GeoIpProvider } from "./geoip.interface";

/**
 * Único punto de entrada a la geolocalización: el resto del código nunca
 * importa un adaptador concreto. Se elige UNA vez según GEOIP_PROVIDER
 * (env.ts lo validó al arrancar).
 */
let provider: GeoIpProvider | null = null;

export function getGeoIpProvider(): GeoIpProvider {
  provider ??= env.geoipProvider === "dbip" ? createDbIpGeoIpProvider(env.geoipDbipCsv!) : createMockGeoIpProvider();
  return provider;
}
