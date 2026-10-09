import type { Request } from "express";
import { getGeoIpProvider } from "../../services/geoip";
import { ipPrefix, normalizeIp } from "../../utils/ip";
import { deviceLabel } from "../../utils/userAgent";

/**
 * Lo que se guarda de quién usa una sesión (B13, migración 022): prefijo de
 * la IP, ubicación aproximada y "navegador en sistema". La IP completa y el
 * User-Agent completo NO se guardan; solo se usan aquí, en memoria.
 * req.ip respeta TRUST_PROXY (app.ts): detrás de un balanceador es la IP real.
 */
export interface SessionClient {
  ipPrefix: string | null;
  location: string | null;
  device: string | null;
}

export function sessionClient(req: Request): SessionClient {
  const ip = normalizeIp(req.ip);
  return {
    ipPrefix: ipPrefix(ip),
    location: ip ? (getGeoIpProvider().lookup(ip)?.slice(0, 120) ?? null) : null,
    device: deviceLabel(req.get("user-agent")),
  };
}
