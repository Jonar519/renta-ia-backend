/**
 * "Chrome en Windows" a partir del User-Agent, para reconocer una sesión
 * (B13). Sin dependencias: solo los navegadores y sistemas comunes; lo demás
 * queda como null ("Dispositivo desconocido"). Se guarda solo esta etiqueta,
 * no el User-Agent completo.
 */
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\b(OPR|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(Firefox|FxiOS)\//, "Firefox"],
  [/\b(HeadlessChrome|Chrome|CriOS)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\b(iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

const first = (ua: string, table: [RegExp, string][]) => table.find(([re]) => re.test(ua))?.[1] ?? null;

export function deviceLabel(userAgent: string | undefined | null): string | null {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, 512);
  const browser = first(ua, BROWSERS);
  const system = first(ua, SYSTEMS);
  if (browser && system) return `${browser} en ${system}`;
  return browser ?? system;
}
