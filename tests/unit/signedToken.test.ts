import { describe, expect, it } from "vitest";
import { createSignedToken, hashToken, verifySignedToken } from "../../src/utils/signedToken";

/**
 * Tokens firmados de un solo uso (invitación; luego recuperación y cambio de
 * correo). La firma es defensa en profundidad: un token alterado, inventado o
 * de otro propósito se rechaza ANTES de consultar la base.
 */
describe("signedToken", () => {
  it("un token recién creado verifica y su hash es el que se guarda en la base", () => {
    const { token, hash } = createSignedToken("invitation");
    expect(token).toMatch(/^[\w-]{43}\.[\w-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySignedToken(token, "invitation")).toBe(hash);
    expect(hashToken(token)).toBe(hash);
  });

  it("cada token es distinto (32 bytes aleatorios)", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => createSignedToken("invitation").token));
    expect(tokens.size).toBe(50);
  });

  it("rechaza un token de OTRO propósito (una invitación no sirve como recuperación)", () => {
    const { token } = createSignedToken("password_reset");
    expect(verifySignedToken(token, "invitation")).toBeNull();
    expect(verifySignedToken(createSignedToken("invitation").token, "email_change")).toBeNull();
  });

  it("rechaza tokens alterados, inventados o mal formados", () => {
    const { token } = createSignedToken("invitation");
    const [body, signature] = token.split(".") as [string, string];
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [
      `${flip(body)}.${signature}`,
      `${body}.${flip(signature)}`,
      `${body}.${body}`,
      body,
      `${token}.extra`,
      "",
      "a".repeat(500),
      `${body}.`,
    ]) {
      expect(verifySignedToken(bad, "invitation")).toBeNull();
    }
    expect(verifySignedToken(undefined, "invitation")).toBeNull();
    expect(verifySignedToken(12345, "invitation")).toBeNull();
  });
});
