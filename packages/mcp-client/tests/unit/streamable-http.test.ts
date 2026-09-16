import { describe, expect, test } from "bun:test";
import { createStreamableHttpTransport } from "../../src/transports/streamable-http.ts";
import type { McpServerConfig } from "../../src/types.ts";

const httpCfg: McpServerConfig = {
  name: "ctx7",
  host: "server",
  transportKind: "streamable-http",
  transport: { url: "https://example.com/mcp" },
};

describe("createStreamableHttpTransport", () => {
  test("builds a streamable-http transport (inner + close)", () => {
    const t = createStreamableHttpTransport(httpCfg);
    expect(t.inner).toBeDefined();
    expect(typeof t.close).toBe("function");
  });

  test("builds an sse-legacy transport", () => {
    const t = createStreamableHttpTransport({
      ...httpCfg,
      transportKind: "sse-legacy",
    });
    expect(t.inner).toBeDefined();
  });

  test("throws when the http url is missing", () => {
    expect(() =>
      createStreamableHttpTransport({
        ...httpCfg,
        transport: {} as never,
      }),
    ).toThrow("missing");
  });

  test("throws for a non-http transportKind", () => {
    expect(() =>
      createStreamableHttpTransport({
        ...httpCfg,
        transportKind: "stdio",
        transport: { command: "x" },
      }),
    ).toThrow();
  });
});
