import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { sessionClient } from "../../src/modules/auth/sessionClient";
import { displayIpPrefix, ipPrefix, isLocalIp, normalizeIp } from "../../src/utils/ip";
import { deviceLabel } from "../../src/utils/userAgent";

/** Lo que se guarda de una sesión (B13): prefijo de IP y "navegador en sistema", nunca la IP completa. */

const fakeReq = (ip: string | undefined, userAgent?: string) =>
  ({ ip, get: (h: string) => (h.toLowerCase() === "user-agent" ? userAgent : undefined) }) as unknown as Request;

describe("prefijo de la IP", () => {
  it("IPv4: sin el último octeto; se muestra con x", () => {
    expect(ipPrefix("203.0.113.77")).toBe("203.0.113.0");
    expect(displayIpPrefix("203.0.113.0")).toBe("203.0.113.x");
  });
  it("IPv4 dentro de IPv6 (::ffff:) se trata como IPv4", () => {
    expect(normalizeIp("::ffff:203.0.113.77")).toBe("203.0.113.77");
    expect(ipPrefix("::ffff:127.0.0.1")).toBe("127.0.0.0");
  });
  it("IPv6: solo el /48, comprimido", () => {
    expect(ipPrefix("2001:0db8:85a3:0001:0000:8a2e:0370:7334")).toBe("2001:db8:85a3::");
    expect(ipPrefix("2800:e2::1")).toBe("2800:e2::");
    expect(ipPrefix("2001:db8:0:1::5")).toBe("2001:db8::");
    expect(ipPrefix("::1")).toBe("::");
    expect(displayIpPrefix("2001:db8:85a3::")).toBe("2001:db8:85a3::/48");
  });
  it("lo que no es una IP: null", () => {
    expect(ipPrefix("no-es-ip")).toBeNull();
    expect(ipPrefix(undefined)).toBeNull();
    expect(displayIpPrefix(null)).toBeNull();
  });
  it("IP locales", () => {
    expect(isLocalIp("100.64.0.1")).toBe(true); // CGNAT
    expect(isLocalIp("172.32.0.1")).toBe(false);
    expect(isLocalIp("8.8.8.8")).toBe(false);
  });
});

describe("equipo (User-Agent)", () => {
  const cases: [string, string | null][] = [
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
      "Chrome en Windows",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0",
      "Edge en Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      "Safari en macOS",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox en Linux"],
    [
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36",
      "Samsung Internet en Android",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1",
      "Chrome en iOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
      "Chrome en Windows",
    ],
    ["curl/8.4.0", null],
    ["", null],
  ];
  it.each(cases)("%s → %s", (ua, label) => expect(deviceLabel(ua)).toBe(label));
});

describe("sessionClient", () => {
  it("IP pública con el mock: prefijo sí, ubicación desconocida (no se inventa)", () => {
    const req = fakeReq("203.0.113.77", "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0");
    expect(sessionClient(req)).toEqual({ ipPrefix: "203.0.113.0", location: null, device: "Firefox en Linux" });
  });
  it("sin IP ni User-Agent: todo null", () => {
    expect(sessionClient(fakeReq(undefined))).toEqual({ ipPrefix: null, location: null, device: null });
  });
});
