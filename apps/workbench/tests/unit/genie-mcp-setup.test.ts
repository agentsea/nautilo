import { describe, expect, test } from "bun:test";
import type { NautiloApiClient } from "@nautilo/api-client/browser";
import { GenieHandoffDeliveryError, GenieHandoffPartialSuccessError } from "../../src/lib/genie-handoff";
import {
  DEFAULT_MCP_SETUP_REQUEST,
  advancedMcpSetupHandoffInput,
  advancedMcpSetupRequest,
  defaultMcpSetupHandoffInput,
  fixLocalMcpHandoffInput,
  fixLocalMcpRequest,
  normalizeMcpConfigJson,
  sendMcpSetupToGenie,
} from "../../src/pages/connections/genie-mcp-setup";

describe("normalizeMcpConfigJson", () => {
  test("normalizes stdio and HTTP MCP entries without secret values", () => {
    const normalized = normalizeMcpConfigJson(JSON.stringify({
      mcpServers: {
        github: {
          command: " npx ",
          args: ["-y", "@example/github"],
          env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
        },
        remote: { url: " https://example.com/mcp " },
      },
    }));

    expect(normalized).toEqual({
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@example/github"],
          envPassthrough: ["GITHUB_TOKEN"],
        },
        remote: { url: "https://example.com/mcp" },
      },
    });
    expect(advancedMcpSetupRequest(normalized)).not.toContain("secret-value");
  });

  test("rejects literal environment values and HTTP headers", () => {
    expect(() => normalizeMcpConfigJson(JSON.stringify({
      mcpServers: { github: { command: "npx", env: { TOKEN: "secret-value" } } },
    }))).toThrow("contains a literal value");
    expect(() => normalizeMcpConfigJson(JSON.stringify({
      mcpServers: { remote: { url: "https://example.com/mcp", headers: { Authorization: "secret" } } },
    }))).toThrow("headers is not accepted");
  });

  test("rejects malformed or mixed transport configuration", () => {
    expect(() => normalizeMcpConfigJson("nope")).toThrow("not valid JSON");
    expect(() => normalizeMcpConfigJson("{}" )).toThrow("mcpServers");
    expect(() => normalizeMcpConfigJson(JSON.stringify({
      mcpServers: { mixed: { url: "https://example.com/mcp", command: "npx" } },
    }))).toThrow("either url or command");
  });

  test("rejects hostile URLs, names, environment conventions, and credential-shaped arguments without echoing values", () => {
    const secret = "sk-do-not-echo-abcdefghijk";
    const inputs = [
      { mcpServers: { github: { url: `https://user:${secret}@example.com/mcp` } } },
      { mcpServers: { github: { url: `https://example.com/mcp?token=${secret}` } } },
      { mcpServers: { github: { command: "npx", args: [`TOKEN=${secret}`] } } },
      { mcpServers: { github: { command: "npx", args: ["--env", "TOKEN"] } } },
      { mcpServers: { github: { command: "npx", args: ["--api-key", secret] } } },
      { mcpServers: { github: { command: "npx", args: ["--client-secret", secret] } } },
      { mcpServers: { "bad name": { command: "npx" } } },
      { mcpServers: { github: { command: "npx", env: { lowercase: "${lowercase}" } } } },
    ];
    for (const input of inputs) {
      let thrown: unknown;
      try {
        normalizeMcpConfigJson(JSON.stringify(input));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).not.toContain(secret);
      expect(JSON.stringify(thrown)).not.toContain(secret);
    }
  });
});

describe("sendMcpSetupToGenie", () => {
  test("creates the default private Genie room, sends immediately, then opens it", async () => {
    const calls: string[] = [];
    const createInputs: unknown[] = [];
    const sendInputs: Array<{ roomId: string; body: { content: string } }> = [];
    const client = {
      createRoom: async (body: { label?: string }) => {
        createInputs.push(body);
        calls.push("create");
        return { id: "room-1" };
      },
      sendRoomMessage: async (roomId: string, body: { content: string }) => {
        sendInputs.push({ roomId, body });
        calls.push(`send:${roomId}:${body.content}`);
        return {};
      },
    } as unknown as NautiloApiClient;
    const roomNavigation = {
      refreshRooms: async () => { calls.push("refresh"); },
      setActiveRoom: (roomId: string) => { calls.push(`open:${roomId}`); },
    };

    await sendMcpSetupToGenie({
      apiClient: client,
      roomNavigation,
      input: { intent: "install it", context: { mcpName: "example" } },
    });

    expect(calls).toEqual([
      "create",
      "send:room-1:install it",
      "refresh",
      "open:room-1",
    ]);
    expect(createInputs).toEqual([{ label: "Set up local MCP" }]);
    expect(sendInputs).toEqual([{
      roomId: "room-1",
      body: { content: "install it" },
    }]);
  });

  test("surfaces fixed pre-send failures and typed post-send partial success without replay", async () => {
    const secret = "sk-do-not-echo-abcdefghijk";
    const input = { intent: "install it", context: {} };
    const failedCreate = {
      createRoom: async () => { throw new Error(secret); },
    } as unknown as NautiloApiClient;
    try {
      await sendMcpSetupToGenie({
        apiClient: failedCreate,
        roomNavigation: { refreshRooms: async () => undefined, setActiveRoom: () => undefined },
        input,
      });
      throw new Error("Expected delivery failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(GenieHandoffDeliveryError);
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }

    let sends = 0;
    try {
      await sendMcpSetupToGenie({
        apiClient: {
          createRoom: async () => ({ id: "room-1" }),
          sendRoomMessage: async () => { sends += 1; },
        } as unknown as NautiloApiClient,
        roomNavigation: {
          refreshRooms: async () => { throw new Error(secret); },
          setActiveRoom: () => undefined,
        },
        input,
      });
      throw new Error("Expected partial success.");
    } catch (error) {
      expect(error).toBeInstanceOf(GenieHandoffPartialSuccessError);
      expect((error as GenieHandoffPartialSuccessError).roomId).toBe("room-1");
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
    expect(sends).toBe(1);

    let refreshes = 0;
    let opens = 0;
    try {
      await sendMcpSetupToGenie({
        apiClient: {
          createRoom: async () => ({ id: "room-2" }),
          sendRoomMessage: async () => { throw new Error(secret); },
        } as unknown as NautiloApiClient,
        roomNavigation: {
          refreshRooms: async () => { refreshes += 1; },
          setActiveRoom: () => { opens += 1; },
        },
        input,
      });
      throw new Error("Expected send failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(GenieHandoffDeliveryError);
      expect(String(error)).not.toContain(secret);
    }
    expect(refreshes).toBe(0);
    expect(opens).toBe(0);

    try {
      await sendMcpSetupToGenie({
        apiClient: {
          createRoom: async () => ({ id: "room-3" }),
          sendRoomMessage: async () => undefined,
        } as unknown as NautiloApiClient,
        roomNavigation: {
          refreshRooms: async () => undefined,
          setActiveRoom: async () => { throw new Error(secret); },
        },
        input,
      });
      throw new Error("Expected partial success.");
    } catch (error) {
      expect(error).toBeInstanceOf(GenieHandoffPartialSuccessError);
      expect((error as GenieHandoffPartialSuccessError).roomId).toBe("room-3");
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("MCP Genie handoff inputs", () => {
  test("keeps the exact default, advanced, and repair intents with bounded source context", () => {
    const config = normalizeMcpConfigJson(JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y"], env: { ZED: "${ZED}", API_TOKEN: "${API_TOKEN}" } },
      },
    }));
    expect(defaultMcpSetupHandoffInput()).toEqual({ intent: DEFAULT_MCP_SETUP_REQUEST, context: {} });
    expect(advancedMcpSetupHandoffInput(config)).toEqual({
      intent: advancedMcpSetupRequest(config),
      context: { mcpName: "github", environmentNames: ["API_TOKEN", "ZED"] },
    });
    const repaired = fixLocalMcpHandoffInput({
      name: "github",
      failureCode: "missing_environment",
      missingEnvironment: ["ZED", "API_TOKEN", "ZED"],
    });
    expect(repaired).toEqual({
      intent: fixLocalMcpRequest({
        name: "github",
        failureCode: "missing_environment",
        missingEnvironment: ["API_TOKEN", "ZED"],
      }),
      context: { mcpName: "github", failureCode: "missing_environment", environmentNames: ["API_TOKEN", "ZED"] },
    });
  });

  test("includes an MCP name only for an exactly-one-server advanced setup and validates recovery evidence", () => {
    const config = normalizeMcpConfigJson(JSON.stringify({
      mcpServers: {
        one: { command: "npx" },
        two: { command: "node" },
      },
    }));
    expect(advancedMcpSetupHandoffInput(config).context).toEqual({});
    expect(() => fixLocalMcpHandoffInput({
      name: "github",
      failureCode: "totally_unknown",
      missingEnvironment: ["TOKEN"],
    })).toThrow("not supported");
    expect(() => fixLocalMcpHandoffInput({
      name: "github",
      failureCode: "missing_environment",
      missingEnvironment: ["lowercase"],
    })).toThrow("environment names");
  });

  test("omits null and non-context known failures from context while retaining safe readable intent", () => {
    expect(fixLocalMcpHandoffInput({ name: "github", failureCode: null }).context).toEqual({ mcpName: "github" });
    for (const failureCode of ["approval_stale", "install_in_progress", "rollback_unconfirmed"]) {
      const result = fixLocalMcpHandoffInput({ name: "github", failureCode });
      expect(result.context).toEqual({ mcpName: "github" });
      expect(result.intent).toContain(failureCode);
    }
  });
});

describe("fixLocalMcpRequest", () => {
  test("sends only safe status evidence and asks for a fresh exact approval", () => {
    const request = fixLocalMcpRequest({
      name: "github-local",
      failureCode: "missing_environment",
      missingEnvironment: ["GITHUB_TOKEN"],
    });
    expect(request).toContain("github-local");
    expect(request).toContain("GITHUB_TOKEN");
    expect(request).toContain("exact MCP install approval");
    expect(request).not.toContain("ghp_example_secret");
  });
});
