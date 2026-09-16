import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  ENABLED_SERVER_NOTIFICATION_METHODS,
  ENABLED_SERVER_REQUEST_METHODS,
  REVIEWED_CLIENT_METHODS,
  buildServerRequestWireResponse,
  type EnabledServerNotificationMethod,
  type EnabledServerRequestMethod,
  type ReviewedClientMethod,
} from "../../src/rpc-types";
import corpusJson from "../../fixtures/0.146.0/protocol-corpus.json";
import { PROTOCOL_CAPABILITY_POLICY } from "../../src/capability-policy";
import { CONSUMED_FIELD_REQUIREMENTS } from "../../src/compatibility-contract";
import {
  CLIENT_RESPONSE_SCHEMAS,
  COMPATIBILITY_PROJECTION_SCHEMAS,
  CLIENT_REQUEST_SCHEMAS,
  SERVER_NOTIFICATION_SCHEMAS,
  SERVER_REQUEST_SCHEMAS,
  SERVER_REQUEST_RESPONSE_SCHEMAS,
  assertReviewedJson,
  buildClientWireParams,
  decodeThreadItem,
  rpcRuntimeDecoder,
} from "../../src/validators";

describe("runtime validators", () => {
  test("keeps every direct Zod projection field in the compatibility manifest", () => {
    const collectProperties = (
      schema: unknown,
      target = new Set<string>(),
    ): Set<string> => {
      if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
        return target;
      }
      const record = schema as Record<string, unknown>;
      if (
        record["properties"] !== null &&
        typeof record["properties"] === "object" &&
        !Array.isArray(record["properties"])
      ) {
        for (const name of Object.keys(record["properties"])) target.add(name);
      }
      for (const keyword of ["oneOf", "anyOf", "allOf"]) {
        const branches = record[keyword];
        if (Array.isArray(branches)) {
          for (const branch of branches) collectProperties(branch, target);
        }
      }
      return target;
    };
    const collectSignatures = (
      schema: unknown,
      target: Array<{
        name: string;
        required: boolean;
        literals: Set<string | number | boolean | null>;
      }> = [],
    ) => {
      if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
        return target;
      }
      const record = schema as Record<string, unknown>;
      const properties =
        record["properties"] !== null &&
        typeof record["properties"] === "object" &&
        !Array.isArray(record["properties"])
          ? record["properties"] as Record<string, unknown>
          : undefined;
      const required = new Set(
        Array.isArray(record["required"])
          ? record["required"].filter((name): name is string =>
            typeof name === "string")
          : [],
      );
      if (properties) {
        for (const [name, property] of Object.entries(properties)) {
          const literals = new Set<string | number | boolean | null>();
          const visitLiterals = (value: unknown): void => {
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
              return;
            }
            const candidate = value as Record<string, unknown>;
            if (
              candidate["const"] === null ||
              ["string", "number", "boolean"].includes(typeof candidate["const"])
            ) {
              literals.add(
                candidate["const"] as string | number | boolean | null,
              );
            }
            if (Array.isArray(candidate["enum"])) {
              for (const literal of candidate["enum"]) {
                if (
                  literal === null ||
                  ["string", "number", "boolean"].includes(typeof literal)
                ) {
                  literals.add(literal as string | number | boolean | null);
                }
              }
            }
            for (const keyword of ["oneOf", "anyOf", "allOf"]) {
              const branches = candidate[keyword];
              if (Array.isArray(branches)) branches.forEach(visitLiterals);
            }
            if (candidate["items"] !== undefined) {
              visitLiterals(candidate["items"]);
            }
          };
          visitLiterals(property);
          target.push({ name, required: required.has(name), literals });
        }
      }
      for (const keyword of ["oneOf", "anyOf", "allOf"]) {
        const branches = record[keyword];
        if (Array.isArray(branches)) {
          for (const branch of branches) collectSignatures(branch, target);
        }
      }
      return target;
    };
    for (const [typeNames, schema] of Object.entries(
      COMPATIBILITY_PROJECTION_SCHEMAS,
    )) {
      const outboundResponse = [
        "ApplyPatchApprovalResponse",
        "ExecCommandApprovalResponse",
        "CommandExecutionRequestApprovalResponse",
        "FileChangeRequestApprovalResponse",
        "PermissionsRequestApprovalResponse",
        "ToolRequestUserInputResponse",
      ].includes(typeNames);
      const projected = collectProperties(
        z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
      );
      const manifest = new Set(
        CONSUMED_FIELD_REQUIREMENTS
          .filter(({ path }) =>
            typeNames.split("|").some((name) => path.startsWith(`${name}.`)),
          )
          .map(({ path }) => path.slice(path.indexOf(".") + 1)),
      );
      expect(manifest, typeNames).toEqual(projected);
      for (const signature of collectSignatures(
        z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
      )) {
        const candidates = CONSUMED_FIELD_REQUIREMENTS.filter(
          ({ path }) =>
            typeNames.split("|").some(
              (name) => path === `${name}.${signature.name}`,
            ),
        );
        expect(
          candidates.some(({ required }) => required === signature.required) ||
            (outboundResponse && signature.required),
          `${typeNames}.${signature.name} required=${String(signature.required)}`,
        ).toBe(true);
        for (const literal of signature.literals) {
          if (
            literal === "denied" &&
            (typeNames === "ApplyPatchApprovalResponse" ||
              typeNames === "ExecCommandApprovalResponse")
          ) {
            expect(buildServerRequestWireResponse(
              typeNames === "ApplyPatchApprovalResponse"
                ? "applyPatchApproval"
                : "execCommandApproval",
              { decision: "denied" },
            )).toEqual({ decision: { denied: { rejection: "Denied by user." } } });
            continue;
          }
          expect(
            candidates.some(({ literals }) => literals?.includes(literal)),
            `${typeNames}.${signature.name} literal=${String(literal)}`,
          ).toBe(true);
        }
      }
    }
  });

  test("binds every recursively reached object projection to a canonical component", () => {
    type JsonSchema = Record<string, unknown>;
    const isSchema = (value: unknown): value is JsonSchema =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    const literalValues = (
      schema: unknown,
      target = new Set<string | number | boolean | null>(),
    ): Set<string | number | boolean | null> => {
      if (!isSchema(schema)) return target;
      const literal = schema["const"];
      if (
        literal === null ||
        ["string", "number", "boolean"].includes(typeof literal)
      ) target.add(literal as string | number | boolean | null);
      if (Array.isArray(schema["enum"])) {
        for (const value of schema["enum"]) {
          if (
            value === null ||
            ["string", "number", "boolean"].includes(typeof value)
          ) target.add(value as string | number | boolean | null);
        }
      }
      for (const keyword of ["oneOf", "anyOf", "allOf"]) {
        const branches = schema[keyword];
        if (Array.isArray(branches)) {
          for (const branch of branches) literalValues(branch, target);
        }
      }
      if (schema["items"] !== undefined) {
        literalValues(schema["items"], target);
      }
      return target;
    };
    const directSignature = (schema: JsonSchema): string => {
      const properties = isSchema(schema["properties"])
        ? schema["properties"] : {};
      const required = new Set(
        Array.isArray(schema["required"])
          ? schema["required"].filter((name): name is string =>
            typeof name === "string")
          : [],
      );
      return JSON.stringify(Object.keys(properties).sort().map((name) => ({
        name,
        required: required.has(name),
        literals: [...literalValues(properties[name])]
          .sort((left, right) => String(left).localeCompare(String(right))),
      })));
    };
    const rootObjectSignatures = (
      schema: unknown,
      target = new Set<string>(),
    ): Set<string> => {
      if (!isSchema(schema)) return target;
      if (isSchema(schema["properties"])) target.add(directSignature(schema));
      for (const keyword of ["oneOf", "anyOf", "allOf"]) {
        const branches = schema[keyword];
        if (Array.isArray(branches)) {
          for (const branch of branches) rootObjectSignatures(branch, target);
        }
      }
      return target;
    };
    const jsonSchemas = Object.fromEntries(
      Object.entries(COMPATIBILITY_PROJECTION_SCHEMAS).map(
        ([name, schema]) => [
          name,
          z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
        ],
      ),
    );
    const canonical = new Set<string>();
    for (const schema of Object.values(jsonSchemas)) {
      rootObjectSignatures(schema, canonical);
    }
    const auditNested = (
      schema: unknown,
      path: string,
      atRoot = true,
    ): void => {
      if (!isSchema(schema)) return;
      if (!atRoot && isSchema(schema["properties"])) {
        expect(
          canonical.has(directSignature(schema)),
          `${path} is not bound to a canonical projection component`,
        ).toBe(true);
      }
      const properties = isSchema(schema["properties"])
        ? schema["properties"] : undefined;
      if (properties) {
        for (const [name, property] of Object.entries(properties)) {
          auditNested(property, `${path}.${name}`, false);
        }
      }
      if (schema["items"] !== undefined) {
        auditNested(schema["items"], `${path}[]`, false);
      }
      if (schema["additionalProperties"] !== undefined) {
        auditNested(
          schema["additionalProperties"],
          `${path}{value}`,
          false,
        );
      }
      for (const keyword of ["oneOf", "anyOf", "allOf"]) {
        const branches = schema[keyword];
        if (Array.isArray(branches)) {
          branches.forEach((branch, index) =>
            auditNested(branch, `${path}.${keyword}[${index}]`, atRoot));
        }
      }
    };
    for (const [name, schema] of Object.entries(jsonSchemas)) {
      auditNested(schema, name);
    }
  });

  test("are exhaustive over the reviewed inventories", () => {
    const enabled = (surface: string) => PROTOCOL_CAPABILITY_POLICY.entries
      .filter((entry) => entry.surface === surface && entry.state === "enabled")
      .map((entry) => entry.name)
      .sort();
    expect(Object.keys(CLIENT_RESPONSE_SCHEMAS).sort()).toEqual(enabled("client_request"));
    expect(Object.keys(CLIENT_REQUEST_SCHEMAS).sort()).toEqual(enabled("client_request"));
    expect(Object.keys(SERVER_REQUEST_SCHEMAS).sort()).toEqual(enabled("server_request"));
    expect(Object.keys(SERVER_REQUEST_RESPONSE_SCHEMAS).sort())
      .toEqual(enabled("server_request"));
    expect(Object.keys(SERVER_NOTIFICATION_SCHEMAS).sort()).toEqual(enabled("server_notification"));
    expect([...REVIEWED_CLIENT_METHODS].map(String).sort()).toEqual(enabled("client_request"));
    expect([...ENABLED_SERVER_REQUEST_METHODS].map(String).sort()).toEqual(enabled("server_request"));
    expect([...ENABLED_SERVER_NOTIFICATION_METHODS].map(String).sort()).toEqual(enabled("server_notification"));
  });

  test("validates, bounds, and strips every enabled handler response", () => {
    const valid: Record<EnabledServerRequestMethod, unknown> = {
      applyPatchApproval: { decision: "approved", leak: true },
      execCommandApproval: { decision: "denied", leak: true },
      "item/commandExecution/requestApproval": { decision: "accept", leak: true },
      "item/fileChange/requestApproval": { decision: "decline", leak: true },
      "item/permissions/requestApproval": {
        permissions: { network: { enabled: true }, leak: true },
        scope: "turn",
        strictAutoReview: true,
        leak: true,
      },
      "item/tool/requestUserInput": {
        answers: { question: { answers: ["yes"], leak: true } },
        leak: true,
      },
    };
    for (const method of ENABLED_SERVER_REQUEST_METHODS) {
      const decoded = rpcRuntimeDecoder.decodeServerRequestResponse(
        method,
        valid[method],
      );
      expect(JSON.stringify(decoded)).not.toContain("leak");
      expect(() =>
        rpcRuntimeDecoder.decodeServerRequestResponse(method, null),
      ).toThrow();
    }
  });

  test("preserves the complete anchored command approval union and additive input deadline", () => {
    const command = rpcRuntimeDecoder.decodeServerRequest(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread", turnId: "turn", itemId: "item", startedAtMs: 1,
        command: "curl https://example.invalid", cwd: "/workspace",
        networkApprovalContext: { host: "example.invalid", protocol: "https", ignored: true },
        commandActions: [
          { type: "search", command: "rg needle", query: "needle", path: null, ignored: true },
        ],
        proposedExecpolicyAmendment: ["rg", "needle"],
        proposedNetworkPolicyAmendments: [{ host: "example.invalid", action: "allow", ignored: true }],
        additionalPermissions: {
          network: { enabled: true, ignored: true },
          fileSystem: {
            read: ["/workspace"], write: null, globScanMaxDepth: 2,
            entries: [{
              path: { type: "glob_pattern", pattern: "src/**", ignored: true },
              access: "read", ignored: true,
            }],
          },
        },
        availableDecisions: [
          "accept",
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rg"], ignored: true } },
          { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.invalid", action: "allow", ignored: true } } },
        ],
        ignored: true,
      },
    );
    expect(command).toEqual({
      threadId: "thread", turnId: "turn", itemId: "item", startedAtMs: 1,
      command: "curl https://example.invalid", cwd: "/workspace",
      networkApprovalContext: { host: "example.invalid", protocol: "https" },
      commandActions: [{ type: "search", command: "rg needle", query: "needle", path: null }],
      proposedExecpolicyAmendment: ["rg", "needle"],
      proposedNetworkPolicyAmendments: [{ host: "example.invalid", action: "allow" }],
      additionalPermissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/workspace"], write: null, globScanMaxDepth: 2,
          entries: [{ path: { type: "glob_pattern", pattern: "src/**" }, access: "read" }],
        },
      },
      availableDecisions: [
        "accept",
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rg"] } },
        { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.invalid", action: "allow" } } },
      ],
    });
    expect(rpcRuntimeDecoder.decodeServerRequestResponse(
      "item/commandExecution/requestApproval",
      { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rg"], ignored: true } } },
    )).toEqual({ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rg"] } } });
    expect(rpcRuntimeDecoder.decodeServerRequest("item/tool/requestUserInput", {
      threadId: "thread", turnId: "turn", itemId: "item", autoResolutionMs: 4_000,
      questions: [], future: "discarded",
    })).toEqual({
      threadId: "thread", turnId: "turn", itemId: "item", autoResolutionMs: 4_000,
      questions: [],
    });
    expect(() => rpcRuntimeDecoder.decodeServerRequest("item/tool/requestUserInput", {
      threadId: "thread", turnId: "turn", itemId: "item",
      questions: [
        { id: "same", header: "One", question: "First?", isOther: false, isSecret: false, options: null },
        { id: "same", header: "Two", question: "Second?", isOther: false, isSecret: false, options: null },
      ],
    })).toThrow("unique");
  });

  test("builds wire requests from compact validated semantic arguments", () => {
    expect(buildClientWireParams("thread/start", {})).toEqual({
      model: undefined,
      cwd: undefined,
      approvalPolicy: undefined,
      sandbox: undefined,
      permissions: undefined,
    });
    expect(buildClientWireParams("turn/start", {
      threadId: "thread-1",
      text: "hello",
      model: "gpt-5",
      collaborationMode: "plan",
      collaborationModePreset: { name: "Plan", mode: "plan", model: null, reasoningEffort: "medium" },
      selectedThreadModel: "gpt-5",
    })).toEqual({
      threadId: "thread-1",
      clientUserMessageId: undefined,
      input: [{ type: "text", text: "hello", text_elements: [] }],
      cwd: undefined,
      approvalPolicy: undefined,
      permissions: undefined,
      model: "gpt-5",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5",
          reasoning_effort: "medium",
          developer_instructions: null,
        },
      },
    });
    expect(buildClientWireParams("getAuthStatus", { refreshToken: true })).toEqual({
      includeToken: false,
      refreshToken: true,
    });
    expect(() => buildClientWireParams("turn/start", {
      threadId: "thread-1",
      text: 42,
    } as never)).toThrow("invalid");
  });

  test("accepts anchored projections and strips additive fields", () => {
    expect(rpcRuntimeDecoder.decodeClientResponse("turn/steer", {
      turnId: "turn-1", future: "ignored",
    })).toEqual({ turnId: "turn-1" });
    expect(rpcRuntimeDecoder.decodeError({
      code: -32001, message: "busy", data: { secret: true },
    })).toEqual({ code: -32001, message: "busy" });
    expect(rpcRuntimeDecoder.decodeClientResponse("account/read", {
      account: {
        type: "chatgpt", email: "safe@example.invalid", planType: "unknown",
        providerSecret: "drop",
      },
      requiresOpenaiAuth: true,
      future: "drop",
    })).toEqual({
      account: {
        type: "chatgpt", email: "safe@example.invalid", planType: "unknown",
      },
      requiresOpenaiAuth: true,
    });
    expect(rpcRuntimeDecoder.decodeClientResponse("getAuthStatus", {
      authMethod: "chatgpt", authToken: "must-not-cross", requiresOpenaiAuth: true,
    })).toEqual({ authMethod: "chatgpt", requiresOpenaiAuth: true });
    expect(rpcRuntimeDecoder.decodeClientResponse("account/read", {
      account: {
        type: "chatgpt", email: null, planType: "ent26",
      },
      requiresOpenaiAuth: true,
    })).toEqual({
      account: { type: "chatgpt", email: null, planType: "ent26" },
      requiresOpenaiAuth: true,
    });
    expect(rpcRuntimeDecoder.decodeServerNotification("account/updated", {
      authMode: "bedrockApiKey", planType: null,
    })).toEqual({ authMode: "bedrockApiKey", planType: null });
  });

  test("rejects malformed errors, responses, requests, and notifications", () => {
    expect(() => rpcRuntimeDecoder.decodeError({ code: "-32001", message: "busy" })).toThrow();
    expect(() => rpcRuntimeDecoder.decodeClientResponse("initialize", {})).toThrow();
    expect(() => rpcRuntimeDecoder.decodeServerNotification("turn/diff/updated", {
      threadId: "t", turnId: "u", diff: 1,
    })).toThrow();
    expect(() => rpcRuntimeDecoder.decodeClientResponse("account/read", {
      account: 42, requiresOpenaiAuth: true,
    })).toThrow();
    expect(() => rpcRuntimeDecoder.decodeClientResponse("account/rateLimits/read", {
      rateLimits: "invalid", rateLimitsByLimitId: null,
    })).toThrow();
    expect(() => rpcRuntimeDecoder.decodeClientResponse("account/usage/read", {
      summary: false, dailyUsageBuckets: ["bad"],
    })).toThrow();
  });

  test("decodes every applicable committed anchored server-to-client fixture", () => {
    const responseMethods = new Map<string, ReviewedClientMethod>([
      ["initialize.success", "initialize"],
      ["steer.success", "turn/steer"],
      ["interrupt.success", "turn/interrupt"],
      ["login.success", "account/login/start"],
      ["account.success", "account/read"],
      ["usage.success", "account/rateLimits/read"],
    ]);
    let decoded = 0;
    for (const fixture of corpusJson.fixtures) {
      for (const frame of fixture.frames) {
        if (frame.direction !== "server_to_client") continue;
        const message = frame.message as Record<string, unknown>;
        if (typeof message["method"] === "string" && Object.hasOwn(message, "id")) {
          if (ENABLED_SERVER_REQUEST_METHODS.includes(
            message["method"] as EnabledServerRequestMethod,
          )) {
            rpcRuntimeDecoder.decodeServerRequest(
              message["method"] as EnabledServerRequestMethod,
              message["params"],
            );
            decoded += 1;
          }
        } else if (typeof message["method"] === "string") {
          if (ENABLED_SERVER_NOTIFICATION_METHODS.includes(
            message["method"] as EnabledServerNotificationMethod,
          )) {
            rpcRuntimeDecoder.decodeServerNotification(
              message["method"] as EnabledServerNotificationMethod,
              message["params"],
            );
            decoded += 1;
          }
        } else if (Object.hasOwn(message, "result")) {
          const method = responseMethods.get(fixture.id);
          if (method) {
            rpcRuntimeDecoder.decodeClientResponse(method, message["result"]);
            decoded += 1;
          }
        } else if (Object.hasOwn(message, "error")) {
          rpcRuntimeDecoder.decodeError(message["error"]);
          decoded += 1;
        }
      }
    }
    expect(decoded).toBeGreaterThanOrEqual(20);
  });

  test("hides unknown thread items without retaining payload but faults malformed known items", () => {
    expect(decodeThreadItem({ type: "futureItem", id: "i", secret: "drop" }))
      .toEqual({ type: "hidden", reason: "unknown_thread_item" });
    expect(() => decodeThreadItem({ type: "agentMessage", id: "i" })).toThrow();
    expect(decodeThreadItem({
      type: "userMessage",
      id: "i",
      content: [{
        type: "text",
        text: "hello",
        text_elements: [{
          byteRange: { start: 0, end: 5 },
          placeholder: null,
          additive: "drop",
        }],
      }],
    })).toEqual({ type: "hidden", reason: "unconsumed_thread_item" });
    expect(() => decodeThreadItem({
      type: "userMessage",
      id: "i",
      content: [{ type: "text", text: 42 }],
    })).toThrow();
    expect(decodeThreadItem({
      type: "userMessage",
      id: "i",
      content: [{ type: "futureContent", payload: { additive: true } }],
    })).toEqual({ type: "hidden", reason: "unconsumed_thread_item" });
    expect(() => decodeThreadItem({
      type: "userMessage",
      id: "i",
      content: [{ type: "futureContent", payload: Number.NaN }],
    })).toThrow();
  });

  test("bounds arbitrary JSON by depth, nodes, finite numbers, and plain objects", () => {
    expect(() => assertReviewedJson({ ok: [1, true, null] })).not.toThrow();
    expect(() => assertReviewedJson({ bad: Number.NaN })).toThrow();
    expect(() => assertReviewedJson(new Date())).toThrow();
    expect(() => assertReviewedJson([[0]], { maxDepth: 1, maxNodes: 10 })).toThrow();
    expect(() => assertReviewedJson([0, 1], { maxDepth: 2, maxNodes: 2 })).toThrow();
  });
});
