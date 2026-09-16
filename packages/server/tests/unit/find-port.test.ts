import { describe, test, expect } from "bun:test";
import { createServer } from "node:net";
import { findAvailablePort } from "../../src/utils/find-port";

function occupyPort(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

describe("findAvailablePort", () => {
  test("returns the preferred port when available", async () => {
    const port = await findAvailablePort(19876);
    expect(port).toBe(19876);
  });

  test("skips a busy port and returns the next one", async () => {
    const server = await occupyPort(19877);
    try {
      const port = await findAvailablePort(19877);
      expect(port).toBe(19878);
    } finally {
      server.close();
    }
  });

  test("throws if no port available in range", async () => {
    expect(findAvailablePort(19879, 0)).rejects.toThrow("No available port");
  });
});
