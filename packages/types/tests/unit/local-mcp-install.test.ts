import { describe, expect, test } from "bun:test";
import {
  LocalMcpInstallValidationError,
  prepareLocalMcpInstallRequest,
} from "../../src/local-mcp-install";
import { shouldAutoResolveAsk } from "../../src/realtime";

const base = {
  version: "local-mcp-install-v1" as const,
  name: "github-mcp",
  transport: {
    kind: "stdio" as const,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github@2025.1.0"],
  },
  source: { url: "https://github.com/modelcontextprotocol/servers" },
  package: { name: "@modelcontextprotocol/server-github", version: "2025.1.0" },
  environment: ["GITHUB_TOKEN", "API_KEY", "GITHUB_TOKEN"],
};

describe("local MCP install canonical request", () => {
  test("allows only absolute directory roots after the official Filesystem MCP package", async () => {
    const filesystem = {
      ...base,
      name: "filesystem-mcp",
      transport: {
        kind: "stdio" as const,
        command: "npx",
        args: [
          "-y",
          "@modelcontextprotocol/server-filesystem@2026.7.10",
          "/tmp/approved root",
          "C:\\approved-root",
          "\\\\host\\approved-root",
        ],
      },
      package: {
        name: "@modelcontextprotocol/server-filesystem",
        version: "2026.7.10",
      },
      environment: [],
    };
    const prepared = await prepareLocalMcpInstallRequest({
      intent: filesystem,
      actorId: "user-1",
      relayId: "relay-1",
      deviceSessionId: "desktop-session-1",
    });
    expect(prepared.transport).toEqual(filesystem.transport);
    expect(prepared.package).toEqual(filesystem.package);

    for (const roots of [
      [],
      ["relative/path"],
      ["--allow-all"],
      ["/tmp/token=literal-secret"],
      Array.from({ length: 17 }, (_, index) => `/tmp/root-${index}`),
    ]) {
      expect(prepareLocalMcpInstallRequest({
        intent: {
          ...filesystem,
          transport: {
            ...filesystem.transport,
            args: [filesystem.transport.args[0]!, filesystem.transport.args[1]!, ...roots],
          },
        },
        actorId: "user-1",
        relayId: "relay-1",
        deviceSessionId: "desktop-session-1",
      })).rejects.toBeInstanceOf(LocalMcpInstallValidationError);
    }
  });

  test("normalizes Unicode/env names deterministically while preserving argv order", async () => {
    const one = await prepareLocalMcpInstallRequest({
      intent: { ...base, name: "github-mcp".normalize("NFD") },
      actorId: "user-1",
      relayId: "relay-1",
      deviceSessionId: "desktop-session-1",
    });
    const two = await prepareLocalMcpInstallRequest({
      intent: { ...base, environment: ["API_KEY", "GITHUB_TOKEN"] },
      actorId: "user-1",
      relayId: "relay-1",
      deviceSessionId: "desktop-session-1",
    });
    expect(one.digest).toBe(two.digest);
    expect(one.transport).toEqual(base.transport);
    expect(one.environment).toEqual([
      { name: "API_KEY", present: null },
      { name: "GITHUB_TOKEN", present: null },
    ]);
    expect(one.subprocessSandboxed).toBe(false);
    expect(one.digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("accepts only earned package launchers and never retains rejected credential values", async () => {
    const expectInvalid = async (
      input: Parameters<typeof prepareLocalMcpInstallRequest>[0],
      rejectedSecret?: string,
    ) => {
      let thrown: unknown;
      try {
        await prepareLocalMcpInstallRequest(input);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(LocalMcpInstallValidationError);
      if (rejectedSecret) expect(JSON.stringify(thrown)).not.toContain(rejectedSecret);
    };
    await expectInvalid({
      intent: { ...base, transport: { kind: "stdio", command: "npx; curl bad", args: [] } },
      actorId: "user-1",
      relayId: "relay-1",
      deviceSessionId: "desktop-session-1",
    });
    await expectInvalid({
      intent: { ...base, transport: { kind: "streamable-http", url: "https://token:secret@example.test/mcp" } },
      actorId: "user-1",
      relayId: "relay-1",
      deviceSessionId: "desktop-session-1",
    });
    await expectInvalid({
      intent: { ...base, transport: { kind: "sse-legacy", url: "https://example.test/sse" } } as never,
      actorId: "user-1",
      relayId: "relay-1",
      deviceSessionId: "desktop-session-1",
    });
    await expectInvalid({
      intent: { ...base, transport: { kind: "stdio", command: "npx", args: ["--token=ghp_abcdefghijklmnopqrstuvwxyz"] } },
      actorId: "user-1",
      relayId: "relay-1",
      deviceSessionId: "desktop-session-1",
    });
    await expectInvalid({
      intent: { ...base, transport: { kind: "stdio", command: "npx", args: ["--token", "literal-value"] } },
      actorId: "user-1",
      relayId: "relay-1",
      deviceSessionId: "desktop-session-1",
    }, "literal-value");
    await expectInvalid({
      intent: { ...base, transport: { kind: "streamable-http", url: "https://example.test/mcp", headers: { authorization: "secret" } } } as never,
      actorId: "user-1",
      relayId: "relay-1",
      deviceSessionId: "desktop-session-1",
    });
    await expectInvalid({
      intent: { ...base, transport: { kind: "stdio", command: "bash", args: ["-c", "echo nope"] } },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    });
    await expectInvalid({
      intent: { ...base, transport: { kind: "stdio", command: "node", args: ["-e", "process.exit()"] } },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    });
    await expectInvalid({
      intent: { ...base, transport: { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    });
    await expectInvalid({
      intent: { ...base, transport: { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2025.1.0"] } },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    });
    await expectInvalid({
      intent: { ...base, transport: { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github@2025.1.0", "--escape-hatch"] } },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    });
    await expectInvalid({
      intent: { ...base, transport: { kind: "stdio", command: "npx", args: ["AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP", "@modelcontextprotocol/server-github@2025.1.0"] } },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    }, "AKIAABCDEFGHIJKLMNOP");
    await expectInvalid({
      intent: { ...base, transport: { kind: "stdio", command: "npx", args: ["--my-token", "arbitrary-token-value", "@modelcontextprotocol/server-github@2025.1.0"] } },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    }, "arbitrary-token-value");
    await expectInvalid({
      intent: { ...base, transport: { kind: "stdio", command: "npx", args: ["--authorization", "Basic YWxpY2U6c2VjcmV0", "@modelcontextprotocol/server-github@2025.1.0"] } },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    }, "YWxpY2U6c2VjcmV0");
    await expectInvalid({
      intent: { ...base, transport: { kind: "stdio", command: "npx", args: ["-e", "AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP", "@modelcontextprotocol/server-github@2025.1.0"] } },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    }, "AKIAABCDEFGHIJKLMNOP");
  });

  test("canonicalizes documentation provenance to a safe origin and rejects model-authored labels", async () => {
    const prepared = await prepareLocalMcpInstallRequest({
      intent: { ...base, source: { url: "https://github.com/modelcontextprotocol/servers/private-token?utm_source=test#github" } },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    });
    expect(prepared.source).toEqual({ label: "github.com", url: "https://github.com/" });
    expect(JSON.stringify(prepared)).not.toContain("private-token");
    expect(JSON.stringify(prepared)).not.toContain("utm_source");
    expect(JSON.stringify(prepared)).not.toContain("#github");
    let thrown: unknown;
    try {
      await prepareLocalMcpInstallRequest({
        intent: { ...base, transport: { kind: "streamable-http", url: "https://example.test/mcp?token=nope" } },
        actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LocalMcpInstallValidationError);
    expect(prepareLocalMcpInstallRequest({
      intent: { ...base, source: { url: "https://docs.example.test/", label: "literal-secret-label" } } as never,
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    })).rejects.toBeInstanceOf(LocalMcpInstallValidationError);
    expect(prepareLocalMcpInstallRequest({
      intent: { ...base, source: { url: "https://alice:password@example.test/docs" } },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    })).rejects.toBeInstanceOf(LocalMcpInstallValidationError);
    expect(prepareLocalMcpInstallRequest({
      intent: { ...base, source: { url: "https://api-key-demo.example.test/docs" } },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    })).rejects.toBeInstanceOf(LocalMcpInstallValidationError);
    expect(prepareLocalMcpInstallRequest({
      intent: { ...base, transport: { kind: "streamable-http", url: "https://example.test/token/demo-secret-value" }, package: undefined },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    })).rejects.toBeInstanceOf(LocalMcpInstallValidationError);
    expect(prepareLocalMcpInstallRequest({
      intent: { ...base, transport: { kind: "streamable-http", url: "https://example.test/api-key-abc123" }, package: undefined },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    })).rejects.toBeInstanceOf(LocalMcpInstallValidationError);
    expect(prepareLocalMcpInstallRequest({
      intent: { ...base, transport: { kind: "streamable-http", url: "https://example.test/0123456789abcdef0123456789abcdef" }, package: undefined },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    })).rejects.toBeInstanceOf(LocalMcpInstallValidationError);
    expect(prepareLocalMcpInstallRequest({
      intent: { ...base, transport: { kind: "streamable-http", url: "https://example.test/QWxhZGRpbjpPcGVuU2VzYW1lMTIzNDU2Nzg5MA" }, package: undefined },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    })).rejects.toBeInstanceOf(LocalMcpInstallValidationError);
    expect(prepareLocalMcpInstallRequest({
      intent: { ...base, transport: { kind: "streamable-http", url: "https://QWxhZGRpbjpPcGVuU2VzYW1lMTIzNDU2Nzg5MA.example.test/mcp" }, package: undefined },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    })).rejects.toBeInstanceOf(LocalMcpInstallValidationError);
    const remote = await prepareLocalMcpInstallRequest({
      intent: { ...base, transport: { kind: "streamable-http", url: "https://example.test/operational/mcp" }, package: undefined },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    });
    expect(remote.transport).toEqual({ kind: "streamable-http", url: "https://example.test/operational/mcp" });
    expect(remote.subprocessSandboxed).toBeNull();
    const ordinary = await prepareLocalMcpInstallRequest({
      intent: { ...base, transport: { kind: "streamable-http", url: "https://example.test/mcp/v1" }, package: undefined },
      actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
    });
    expect(ordinary.transport).toEqual({ kind: "streamable-http", url: "https://example.test/mcp/v1" });
  });

  test("rejects package free text for a remote MCP without echoing it", async () => {
    const rejected = "remote-package-secret-text";
    let thrown: unknown;
    try {
      await prepareLocalMcpInstallRequest({
        intent: {
          ...base,
          transport: { kind: "streamable-http", url: "https://example.test/mcp" },
          package: { name: rejected, version: "1.2.3" },
        },
        actorId: "user-1", relayId: "relay-1", deviceSessionId: "desktop-session-1",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LocalMcpInstallValidationError);
    expect(JSON.stringify(thrown)).not.toContain(rejected);
  });
});

test("exact local MCP review cannot be session auto-approved", () => {
  expect(shouldAutoResolveAsk({
    enabled: true,
    hasNetworkContext: false,
    requiresExplicitReview: true,
  })).toBe(false);
});
