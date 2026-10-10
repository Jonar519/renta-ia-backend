import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { createDbIpGeoIpProvider, loadDbIpCsv, lookupIn, parseCsvLine } from "../../src/services/geoip/dbip.provider";
import { createMockGeoIpProvider } from "../../src/services/geoip/mock.provider";

/**
 * Ubicación aproximada (B13, decisión D2). El mock nunca inventa una ciudad;
 * el adaptador real lee DB-IP Lite desde un CSV local (aquí, una muestra con
 * el mismo formato).
 */
const SAMPLE = path.join(__dirname, "../fixtures/dbip-city-lite-muestra.csv");
const tmpCsv = (name: string, content: string) => {
  const file = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  fs.writeFileSync(file, content);
  return file;
};

describe("mock (por defecto)", () => {
  const geo = createMockGeoIpProvider();
  it("las IP locales son 'Red local'", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.0.1", "::1", "fd00::1", "fe80::1"]) {
      expect(geo.lookup(ip), ip).toBe("Red local");
    }
  });
  it("una IP pública queda sin ubicación (no se inventa)", () => {
    expect(geo.lookup("203.0.113.77")).toBeNull();
    expect(geo.lookup("2800:e2::1")).toBeNull();
  });
});

describe("DB-IP Lite (CSV)", () => {
  it("lee campos entre comillas con comas adentro", () => {
    expect(parseCsvLine('1.0.0.0,1.0.0.255,SA,CO,Antioquia,"Medellín, Antioquia",6.2,-75.5')).toEqual([
      "1.0.0.0",
      "1.0.0.255",
      "SA",
      "CO",
      "Antioquia",
      "Medellín, Antioquia",
      "6.2",
      "-75.5",
    ]);
    expect(parseCsvLine('a,"con ""comillas""",b')).toEqual(["a", 'con "comillas"', "b"]);
  });

  it("ubica IPv4 e IPv6 dentro de sus rangos; fuera de ellos, null", async () => {
    const t = await loadDbIpCsv(SAMPLE);
    expect(lookupIn(t, "203.0.113.77")).toBe("Bogotá, Colombia");
    expect(lookupIn(t, "203.0.113.0")).toBe("Bogotá, Colombia"); // borde inferior
    expect(lookupIn(t, "203.0.113.255")).toBe("Bogotá, Colombia"); // borde superior
    expect(lookupIn(t, "190.0.3.4")).toBe("Medellín, Antioquia, Colombia");
    expect(lookupIn(t, "200.1.1.9")).toBe("Brasil"); // sin ciudad: solo el país
    expect(lookupIn(t, "203.0.114.0")).toBeNull(); // entre rangos
    expect(lookupIn(t, "0.0.0.1")).toBeNull(); // antes del primero
    expect(lookupIn(t, "255.255.255.255")).toBeNull(); // después del último
    expect(lookupIn(t, "2800:e2:1234::9")).toBe("Bogotá, Colombia");
    expect(lookupIn(t, "2a00:1450:4001::1")).toBe("Dublin, Irlanda");
    expect(lookupIn(t, "2a00:1451::1")).toBeNull();
  });

  it("también el CSV de países (3 columnas)", async () => {
    const file = tmpCsv(
      "dbip-country",
      "203.0.113.0,203.0.113.255,CO\n2800:e2::,2800:e2:ffff:ffff:ffff:ffff:ffff:ffff,CO\n"
    );
    const t = await loadDbIpCsv(file);
    expect(lookupIn(t, "203.0.113.1")).toBe("Colombia");
    expect(lookupIn(t, "2800:e2::5")).toBe("Colombia");
    fs.rmSync(file);
  });

  it("un CSV desordenado o con basura se rechaza al cargar", async () => {
    const unordered = tmpCsv("dbip-desordenado", "203.0.113.0,203.0.113.255,CO\n1.0.0.0,1.0.0.255,AU\n");
    await expect(loadDbIpCsv(unordered)).rejects.toThrow(/fuera de orden/);
    const garbage = tmpCsv("dbip-basura", "esto,no,es,un,rango\n");
    await expect(loadDbIpCsv(garbage)).rejects.toThrow(/no es un rango/);
    fs.rmSync(unordered);
    fs.rmSync(garbage);
  });

  it("el proveedor: mientras carga, null; luego ubica; las IP locales siguen siendo 'Red local'", async () => {
    const geo = createDbIpGeoIpProvider(SAMPLE);
    expect(geo.lookup("203.0.113.77")).toBeNull();
    await geo.ready;
    expect(geo.lookup("203.0.113.77")).toBe("Bogotá, Colombia");
    expect(geo.lookup("127.0.0.1")).toBe("Red local");
  });

  it("un archivo dañado no tumba la API: la ubicación queda desconocida", async () => {
    const file = tmpCsv("dbip-danado", "basura\n");
    const geo = createDbIpGeoIpProvider(file);
    await geo.ready;
    expect(geo.lookup("203.0.113.77")).toBeNull();
    fs.rmSync(file);
  });
});
