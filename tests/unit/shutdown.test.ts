import http from "http";
import type { AddressInfo } from "net";
import { describe, expect, it, vi } from "vitest";
import { closeHttpServer, createGracefulShutdown } from "../../src/lifecycle/shutdown";

const log = () => undefined;

describe("createGracefulShutdown", () => {
  it("ejecuta los pasos en orden y sale con 0", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createGracefulShutdown(
      ["a", "b", "c"].map((name) => ({ name, run: async () => void order.push(name) })),
      { timeoutMs: 1000, log, exit }
    );
    await shutdown("SIGTERM");
    expect(order).toEqual(["a", "b", "c"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("una segunda señal no repite el apagado", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const shutdown = createGracefulShutdown([{ name: "x", run }], { timeoutMs: 1000, log, exit });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("si un paso falla sale con 1", async () => {
    const exit = vi.fn();
    const shutdown = createGracefulShutdown([{ name: "x", run: () => Promise.reject(new Error("boom")) }], {
      timeoutMs: 1000,
      log,
      exit,
    });
    await shutdown("SIGTERM");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("si se cuelga, fuerza la salida con 1 al vencer el tiempo máximo", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown([{ name: "colgado", run: () => new Promise(() => undefined) }], {
      timeoutMs: 5000,
      log,
      exit,
    });
    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(4999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });
});

describe("closeHttpServer", () => {
  it("espera la solicitud en curso, rechaza conexiones nuevas y no espera a las keep-alive ociosas", async () => {
    let release!: () => void;
    const server = http.createServer((req, res) => {
      if (req.url === "/lenta") {
        release = () => res.end("terminada");
        return;
      }
      res.end("rapida");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    // Conexión keep-alive ociosa (fetch reutiliza sockets) + una solicitud lenta en curso.
    await fetch(`${base}/rapida`).then((r) => r.text());
    const slow = fetch(`${base}/lenta`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50));

    let closed = false;
    const closing = closeHttpServer(server).then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(false); // sigue esperando la solicitud lenta
    await expect(fetch(`${base}/rapida`, { headers: { Connection: "close" } })).rejects.toThrow();

    release();
    await expect(slow).resolves.toBe("terminada");
    // Termina enseguida: no espera el keep-alive timeout de la conexión que quedó ociosa.
    const start = Date.now();
    await closing;
    expect(closed).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
