import { vi } from "vitest";

// Ningún test necesita Redis real: se reemplazan la conexión y la cola.
vi.mock("../src/config/redis", () => ({
  redisConnection: { call: vi.fn(), on: vi.fn(), quit: vi.fn() },
}));

vi.mock("../src/queues/documentQueue", () => ({
  documentQueue: { add: vi.fn().mockResolvedValue({ id: "job-de-prueba" }) },
}));
