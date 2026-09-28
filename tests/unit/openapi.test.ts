import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { buildOpenApiDocument } from "../../src/docs/openapi";
import { createApp } from "../../src/app";
import { env } from "../../src/config/env";

describe("OpenAPI", () => {
  const originalNodeEnv = env.nodeEnv;
  afterEach(() => {
    env.nodeEnv = originalNodeEnv;
  });

  it("docs/openapi.json está al día con los schemas zod (si falla: npm run openapi)", () => {
    const committed = fs.readFileSync(path.resolve(__dirname, "../../docs/openapi.json"), "utf8");
    expect(committed).toBe(`${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
  });

  it("documenta las validaciones reales (p. ej. límites del listado y del chat)", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, { parameters?: { name: string; schema: { maximum?: number } }[] }>>;
    };
    const limit = doc.paths["/api/clients"]!.get!.parameters!.find((p) => p.name === "limit");
    expect(limit?.schema.maximum).toBe(100);
    expect(JSON.stringify(doc.paths["/api/ai/chat"])).toContain('"maxLength":1000');
  });

  it("GET /docs sirve Swagger UI fuera de producción", async () => {
    const app = createApp();
    const res = await request(app).get("/docs/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("swagger-ui");
    expect((await request(app).get("/docs/openapi.json")).body.openapi).toBe("3.0.3");
  });

  it("en producción /docs no existe", async () => {
    env.nodeEnv = "production";
    const app = createApp();
    expect((await request(app).get("/docs/")).status).toBe(404);
    expect((await request(app).get("/docs/openapi.json")).status).toBe(404);
  });
});
