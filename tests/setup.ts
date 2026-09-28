import { vi } from "vitest";

// Ningún test necesita Redis real: se reemplazan la conexión y la cola.
vi.mock("../src/config/redis", () => ({
  redisConnection: { call: vi.fn(), on: vi.fn(), quit: vi.fn(), ping: vi.fn().mockResolvedValue("PONG") },
}));

vi.mock("../src/queues/documentQueue", () => ({
  documentQueue: {
    add: vi.fn().mockResolvedValue({ id: "job-de-prueba" }),
    getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }),
  },
}));
