import { isLocalIp } from "../../utils/ip";
import type { GeoIpProvider } from "./geoip.interface";

/** Sin base de ubicaciones: solo reconoce las IP locales. Nunca inventa una ciudad. */
export function createMockGeoIpProvider(): GeoIpProvider {
  return {
    name: "mock",
    lookup: (ip) => (isLocalIp(ip) ? "Red local" : null),
  };
}
