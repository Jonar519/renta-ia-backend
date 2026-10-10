import { afterEach, describe, expect, it, vi } from "vitest";
import { base32Decode, base32Encode, hotp, otpauthUri, stepAt, totp, verifyTotp } from "../../src/modules/mfa/totp";
import { open, seal } from "../../src/utils/secretBox";
import { encode } from "uqr";
import { qrSvg } from "../../src/modules/mfa/qr";
import { normalizeRecoveryCode } from "../../src/modules/mfa/mfa.service";

// Secreto de los vectores de prueba de los RFC 4226 y 6238 (SHA-1).
const RFC_SECRET = Buffer.from("12345678901234567890");

describe("HOTP (RFC 4226, apéndice D)", () => {
  it("coincide con los 10 vectores oficiales", () => {
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    expect(expected.map((_, counter) => hotp(RFC_SECRET, counter))).toEqual(expected);
  });
});

describe("TOTP (RFC 6238, apéndice B, SHA-1, 8 dígitos)", () => {
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("t = %i s → %s", (seconds, code) => {
    expect(totp(RFC_SECRET, seconds * 1000, 8)).toBe(code);
  });
});

describe("base32 (RFC 4648)", () => {
  it("codifica el secreto del RFC como lo esperan las apps y vuelve a decodificarlo", () => {
    expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").equals(RFC_SECRET)).toBe(true);
    expect(base32Decode("gezdgnbv").equals(RFC_SECRET.subarray(0, 5))).toBe(true);
    expect(() => base32Decode("GEZ1")).toThrow(/base32/);
  });
});

describe("verificación", () => {
  const now = 1_790_000_000_000;
  const step = stepAt(now);

  it("acepta el paso actual y ±1 (reloj desfasado ±30 s); rechaza ±2", () => {
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now), null, now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 30_000), null, now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now + 30_000), null, now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 60_000), null, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now + 60_000), null, now)).toBeNull();
  });

  it("anti-replay: no acepta el paso ya usado ni uno anterior", () => {
    const code = totp(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, code, BigInt(step), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 30_000), BigInt(step - 1), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now + 30_000), BigInt(step), now)).toBe(step + 1);
  });

  it("rechaza lo que no son 6 dígitos y el código de otro secreto", () => {
    expect(verifyTotp(RFC_SECRET, "12345", null, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", null, now)).toBeNull();
    expect(verifyTotp(Buffer.from("otro secreto distinto"), totp(RFC_SECRET, now), null, now)).toBeNull();
  });

  it("otpauth:// con emisor, cuenta y parámetros estándar (lo que lee la app)", () => {
    const raw = otpauthUri(RFC_SECRET, "ana@example.com");
    expect(raw.startsWith("otpauth://totp/Renta%20IA:ana%40example.com?")).toBe(true);
    const uri = new URL(raw);
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      issuer: "Renta IA",
      algorithm: "SHA1",
      digits: "6",
      period: "30",
    });
  });

  it("códigos de recuperación: tolera minúsculas, espacios, guiones y O/0, I/L/1", () => {
    expect(normalizeRecoveryCode("abcd-efgh o0il 1234")).toBe("ABCDEFGH00111234");
  });
});

describe("secretBox (AES-256-GCM)", () => {
  const key = Buffer.alloc(32, 7);
  const secret = Buffer.from("secreto totp de prueba");

  it("descifra con la misma clave y contexto; el IV cambia en cada cifrado", () => {
    const a = seal(secret, key, "renta-ia/mfa/u1");
    const b = seal(secret, key, "renta-ia/mfa/u1");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\.[\w-]{16}\.[\w-]{22}\.[\w-]+$/);
    expect(a).not.toContain(secret.toString("base64url"));
    expect(open(a, key, "renta-ia/mfa/u1").equals(secret)).toBe(true);
  });

  it("falla con otra clave, con el contexto de otra cuenta o si se altera", () => {
    const sealed = seal(secret, key, "renta-ia/mfa/u1");
    expect(() => open(sealed, Buffer.alloc(32, 8), "renta-ia/mfa/u1")).toThrow();
    expect(() => open(sealed, key, "renta-ia/mfa/u2")).toThrow();
    const [v, iv, tag, data] = sealed.split(".");
    // Se cambia el PRIMER carácter: el último puede llevar solo bits de relleno.
    const flipped = (data!.startsWith("A") ? "B" : "A") + data!.slice(1);
    expect(() => open([v, iv, tag, flipped].join("."), key, "renta-ia/mfa/u1")).toThrow();
    expect(() => open("v2.x.y.z", key, "renta-ia/mfa/u1")).toThrow(/Formato/);
  });
});

describe("MFA_ENCRYPTION_KEY al arrancar (env.ts)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("en producción es obligatoria", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ORIGIN", "https://app.example.com");
    vi.stubEnv("MFA_ENCRYPTION_KEY", "");
    vi.resetModules();
    await expect(import("../../src/config/env")).rejects.toThrow(/MFA_ENCRYPTION_KEY/);
  });

  it("fuera de producción es opcional (la API arranca sin ella)", async () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY", "");
    vi.resetModules();
    const { env } = await import("../../src/config/env");
    expect(env.mfaEncryptionKey).toBeUndefined();
  });

  it.each(["corta", Buffer.alloc(16).toString("base64"), Buffer.alloc(48).toString("base64")])(
    "rechaza una clave que no sea de 32 bytes en base64 (%s)",
    async (value) => {
      vi.stubEnv("MFA_ENCRYPTION_KEY", value);
      vi.resetModules();
      await expect(import("../../src/config/env")).rejects.toThrow(/32 bytes/);
    }
  );
});

describe("QR en SVG (servidor)", () => {
  it("dibuja exactamente los módulos oscuros de la matriz, con margen de 4 módulos", () => {
    const text = otpauthUri(RFC_SECRET, "ana@example.com");
    const { size, data } = encode(text, { ecc: "M", border: 4 });
    const svg = qrSvg(text);
    expect(svg).toContain(`viewBox="0 0 ${size} ${size}"`);
    const drawn = new Set<string>();
    for (const [, x, y, w] of svg.matchAll(/M(\d+) (\d+)h(\d+)v1H\d+z/g)) {
      for (let i = 0; i < Number(w); i++) drawn.add(`${Number(x) + i},${y}`);
    }
    const dark = new Set<string>();
    data.forEach((row, y) => row.forEach((on, x) => on && dark.add(`${x},${y}`)));
    expect(drawn).toEqual(dark);
    // Margen: las 4 primeras filas y columnas, vacías.
    for (const cell of dark) {
      const [x, y] = cell.split(",").map(Number);
      expect(x).toBeGreaterThanOrEqual(4);
      expect(y).toBeGreaterThanOrEqual(4);
    }
  });
});
