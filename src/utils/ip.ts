import { isIPv4, isIPv6 } from "net";

/**
 * Direcciones IP de las sesiones (B13). Se guarda SOLO un prefijo:
 *  - IPv4: sin el último octeto (203.0.113.77 → 203.0.113.0), se muestra 203.0.113.x;
 *  - IPv6: el /48 (2001:db8:85a3:1::7 → 2001:db8:85a3::), se muestra 2001:db8:85a3::/48.
 * La IP completa solo se usa en memoria para la ubicación aproximada.
 */

/** IPv4 tal cual; IPv6 en minúsculas; "::ffff:1.2.3.4" (IPv4 dentro de IPv6) → "1.2.3.4". null si no es una IP. */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const ip = raw.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  if (isIPv4(ip) || isIPv6(ip)) return ip;
  return null;
}

/** Los 8 grupos de 16 bits de una IPv6 válida (expande "::"). */
export function ipv6Groups(ip: string): number[] {
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, null];
  const parse = (part: string | undefined) => (part ? part.split(":").map((h) => parseInt(h, 16)) : []);
  const left = parse(head);
  if (tail === null) return left;
  const right = parse(tail);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

export function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

/** Prefijo que se guarda (ver arriba). null si no es una IP válida. */
export function ipPrefix(raw: string | undefined | null): string | null {
  const ip = normalizeIp(raw);
  if (!ip) return null;
  if (isIPv4(ip)) return `${ip.split(".").slice(0, 3).join(".")}.0`;
  const groups = ipv6Groups(ip).slice(0, 3);
  while (groups.length && groups[groups.length - 1] === 0) groups.pop(); // ceros finales caben en "::"
  return `${groups.map((g) => g.toString(16)).join(":")}::`;
}

/** Cómo se muestra el prefijo guardado. */
export function displayIpPrefix(prefix: string | null): string | null {
  if (!prefix) return null;
  return prefix.includes(":") ? `${prefix}/48` : prefix.replace(/\.0$/, ".x");
}

/** Loopback, redes privadas, enlace local y CGNAT: no tienen ubicación pública. */
export function isLocalIp(ip: string): boolean {
  if (isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const first = ipv6Groups(ip)[0]!;
  return ip === "::1" || ip === "::" || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}
