import fs from "fs";
import { isIPv4 } from "net";
import readline from "readline";
import { logger } from "../../config/logger";
import { ipv4ToInt, ipv6Groups, isLocalIp } from "../../utils/ip";
import type { GeoIpProvider } from "./geoip.interface";

/**
 * DB-IP Lite (https://db-ip.com/db/lite.php, CC BY 4.0) desde su CSV:
 *   ciudades: ip_start,ip_end,continent,country,stateprov,city,latitude,longitude
 *   países:   ip_start,ip_end,country
 * Se carga en memoria al arrancar, en segundo plano (mientras carga, la
 * ubicación queda "desconocida"; no bloquea el inicio de sesión). Rangos
 * ordenados → búsqueda binaria. IPv4 en Uint32Array; IPv6 en dos
 * BigUint64Array (64 bits altos y bajos); las etiquetas, sin repetir.
 */

const countryNames = new Intl.DisplayNames(["es"], { type: "region" });
const countryName = (code: string) => {
  try {
    return countryNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
};

/** Una línea CSV con campos entre comillas (las ciudades pueden llevar comas). */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

function labelFor(fields: string[]): string | null {
  if (fields.length === 3) return fields[2] ? countryName(fields[2]) : null;
  const [, , , country = "", , city = ""] = fields;
  if (!country) return null;
  return city ? `${city}, ${countryName(country)}` : countryName(country);
}

const ipv6Halves = (ip: string) => {
  const g = ipv6Groups(ip).map(BigInt);
  return [
    (g[0]! << 48n) | (g[1]! << 32n) | (g[2]! << 16n) | g[3]!,
    (g[4]! << 48n) | (g[5]! << 32n) | (g[6]! << 16n) | g[7]!,
  ];
};
const cmp = (aHi: bigint, aLo: bigint, bHi: bigint, bLo: bigint) =>
  aHi === bHi ? (aLo === bLo ? 0 : aLo < bLo ? -1 : 1) : aHi < bHi ? -1 : 1;

interface Tables {
  v4Start: Uint32Array;
  v4End: Uint32Array;
  v4Label: Uint32Array;
  v6StartHi: BigUint64Array;
  v6StartLo: BigUint64Array;
  v6EndHi: BigUint64Array;
  v6EndLo: BigUint64Array;
  v6Label: Uint32Array;
  labels: string[];
}

/** Lee el CSV completo. Lanza si una línea no se entiende o los rangos no vienen en orden. */
export async function loadDbIpCsv(path: string): Promise<Tables> {
  const labels: string[] = [];
  const labelIndex = new Map<string, number>();
  const idx = (label: string) => {
    let i = labelIndex.get(label);
    if (i === undefined) {
      i = labels.push(label) - 1;
      labelIndex.set(label, i);
    }
    return i;
  };
  const v4: number[] = [];
  const v6: bigint[] = [];
  const v6Labels: number[] = [];
  const lines = readline.createInterface({ input: fs.createReadStream(path, "utf8"), crlfDelay: Infinity });
  let n = 0;
  for await (const line of lines) {
    n++;
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    const [start = "", end = ""] = fields;
    const label = labelFor(fields);
    if (label === null) continue;
    if (isIPv4(start) && isIPv4(end)) {
      const s = ipv4ToInt(start);
      if (v4.length && s <= v4[v4.length - 2]!)
        throw new Error(`GEOIP_DBIP_CSV línea ${n}: rangos IPv4 fuera de orden`);
      v4.push(s, ipv4ToInt(end), idx(label));
    } else if (start.includes(":") && end.includes(":")) {
      const [sHi, sLo] = ipv6Halves(start) as [bigint, bigint];
      const [eHi, eLo] = ipv6Halves(end) as [bigint, bigint];
      const k = v6.length;
      if (k && cmp(sHi, sLo, v6[k - 2]!, v6[k - 1]!) <= 0) {
        throw new Error(`GEOIP_DBIP_CSV línea ${n}: rangos IPv6 fuera de orden`);
      }
      v6.push(sHi, sLo, eHi, eLo);
      v6Labels.push(idx(label));
    } else {
      throw new Error(`GEOIP_DBIP_CSV línea ${n}: no es un rango de IP`);
    }
  }
  const count4 = v4.length / 3;
  const count6 = v6Labels.length;
  const t: Tables = {
    v4Start: new Uint32Array(count4),
    v4End: new Uint32Array(count4),
    v4Label: new Uint32Array(count4),
    v6StartHi: new BigUint64Array(count6),
    v6StartLo: new BigUint64Array(count6),
    v6EndHi: new BigUint64Array(count6),
    v6EndLo: new BigUint64Array(count6),
    v6Label: Uint32Array.from(v6Labels),
    labels,
  };
  for (let i = 0; i < count4; i++) {
    t.v4Start[i] = v4[i * 3]!;
    t.v4End[i] = v4[i * 3 + 1]!;
    t.v4Label[i] = v4[i * 3 + 2]!;
  }
  for (let i = 0; i < count6; i++) {
    t.v6StartHi[i] = v6[i * 4]!;
    t.v6StartLo[i] = v6[i * 4 + 1]!;
    t.v6EndHi[i] = v6[i * 4 + 2]!;
    t.v6EndLo[i] = v6[i * 4 + 3]!;
  }
  return t;
}

/** Último rango cuyo inicio es <= la IP (búsqueda binaria); -1 si ninguno. */
function lastAtOrBelow(count: number, isAtOrBelow: (i: number) => boolean): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (isAtOrBelow(mid)) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export function lookupIn(t: Tables, ip: string): string | null {
  if (isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    const i = lastAtOrBelow(t.v4Start.length, (k) => t.v4Start[k]! <= n);
    return i >= 0 && n <= t.v4End[i]! ? t.labels[t.v4Label[i]!]! : null;
  }
  const [hi, lo] = ipv6Halves(ip) as [bigint, bigint];
  const i = lastAtOrBelow(t.v6Label.length, (k) => cmp(t.v6StartHi[k]!, t.v6StartLo[k]!, hi, lo) <= 0);
  return i >= 0 && cmp(hi, lo, t.v6EndHi[i]!, t.v6EndLo[i]!) <= 0 ? t.labels[t.v6Label[i]!]! : null;
}

export function createDbIpGeoIpProvider(path: string): GeoIpProvider & { ready: Promise<void> } {
  let tables: Tables | null = null;
  const started = Date.now();
  const ready = loadDbIpCsv(path).then(
    (t) => {
      tables = t;
      logger.info(
        { ipv4: t.v4Start.length, ipv6: t.v6Label.length, ms: Date.now() - started },
        "GeoIP: DB-IP Lite cargada"
      );
    },
    (err: unknown) => {
      // Un archivo dañado no tumba la API: la ubicación queda "desconocida".
      logger.error({ err: err instanceof Error ? err.message : err }, "GeoIP: no se pudo cargar DB-IP Lite");
    }
  );
  return {
    name: "dbip",
    ready,
    lookup: (ip) => (isLocalIp(ip) ? "Red local" : tables ? lookupIn(tables, ip) : null),
  };
}
