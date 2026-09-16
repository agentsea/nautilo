import { describe, expect, test } from "bun:test";
import { browseLocalInstances } from "../../src/browse-mdns";

describe("browseLocalInstances", () => {
  test("completes one bounded browse and tears down its browser and Bonjour stack", async () => {
    let stopped = 0;
    let destroyed = 0;
    const rows = await browseLocalInstances({ timeoutMs: 1 }, () => ({
      find: (_options, onUp) => {
        onUp({
          name: "local",
          host: "nautilo.local.",
          port: 3180,
          addresses: ["192.168.1.10"],
          txt: { instance: "default" },
        } as never);
        return { stop: () => { stopped++; } } as never;
      },
      destroy: () => { destroyed++; },
    }));
    expect(rows).toEqual([{
      name: "local",
      host: "nautilo.local.",
      port: 3180,
      addresses: ["192.168.1.10"],
      serverUrl: "http://192.168.1.10:3180",
      txt: { instance: "default" },
    }]);
    expect(stopped).toBe(1);
    expect(destroyed).toBe(1);
  });

  test("bridges asynchronous multicast errors into rejection and exact teardown", async () => {
    let stopped = 0;
    let destroyed = 0;
    const failure = Object.assign(new Error("socket unavailable"), { code: "EACCES" });
    const result = browseLocalInstances({ timeoutMs: 100 }, (onError) => ({
      find: () => {
        queueMicrotask(() => onError(failure));
        return { stop: () => { stopped++; } } as never;
      },
      destroy: () => { destroyed++; },
    }));
    let rejection: unknown;
    try {
      await result;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBe(failure);
    expect(stopped).toBe(1);
    expect(destroyed).toBe(1);
  });

  test("stops a browser returned after a synchronous find error without arming the timeout", async () => {
    let stopped = 0;
    let destroyed = 0;
    const failure = new Error("synchronous socket failure");
    const result = browseLocalInstances({ timeoutMs: 100 }, (onError) => ({
      find: () => {
        onError(failure);
        return { stop: () => { stopped++; } } as never;
      },
      destroy: () => { destroyed++; },
    }));
    let rejection: unknown;
    try {
      await result;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBe(failure);
    expect(stopped).toBe(1);
    expect(destroyed).toBe(1);
  });
});
