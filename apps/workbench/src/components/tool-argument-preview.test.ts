import { describe, expect, test } from "bun:test";
import {
  formatToolPreview,
  isSensitiveToolArgumentKey,
  projectToolArgsForCardDisplay,
  projectToolResultForDisplay,
  projectToolResultTextForDisplay,
  parseSerializedToolArgsForDisplay,
  redactCredentialMaterialForDisplay,
  redactToolArgsForDisplay,
} from "./tool-argument-preview";

describe("tool argument display boundary", () => {
  test("redacts nested and spelling-variant secrets without mutating source args", () => {
    const args = {
      sessionToken: "live-session-secret",
      operation: "create-connector",
      request: {
        headers: {
          Authorization: "Bearer nested-secret",
          "X-API_Key": "api-key-secret",
        },
        credentials: [{ private_key: "private-secret", label: "signer" }],
      },
      nodes: ["node:one", "node:two"],
    };
    const before = structuredClone(args);

    const safe = redactToolArgsForDisplay(args);

    expect(safe).toEqual({
      sessionToken: "[redacted]",
      operation: "create-connector",
      request: {
        headers: {
          Authorization: "[redacted]",
          "X-API_Key": "[redacted]",
        },
        credentials: "[redacted]",
      },
      nodes: ["node:one", "node:two"],
    });
    expect(args).toEqual(before);
    expect(JSON.stringify(safe)).not.toContain("live-session-secret");
    expect(JSON.stringify(safe)).not.toContain("nested-secret");
    expect(JSON.stringify(safe)).not.toContain("api-key-secret");
    expect(JSON.stringify(safe)).not.toContain("private-secret");
  });

  test("recognizes known secret-bearing key variants without hiding intent keys", () => {
    for (const key of [
      "session_token",
      "accessToken",
      "Authorization",
      "api-key",
      "clientSecret",
      "private_key",
      "PASSWORD",
      "set_cookie",
      "approvalPin",
    ]) {
      expect(isSensitiveToolArgumentKey(key)).toBe(true);
    }
    for (const key of ["operation", "orderedIds", "tokenBudget", "path", "spin"]) {
      expect(isSensitiveToolArgumentKey(key)).toBe(false);
    }
  });

  test("compact preview retains bounded operation intent and redacts before serialization", () => {
    const preview = formatToolPreview({
      name: "edit-open-design",
      args: {
        operation: "connector-update",
        sessionToken: "never-render-this",
        nested: { refresh_token: "nor-this", nodeId: "node:one" },
      },
    });
    expect(preview).toContain("operation: connector-update");
    expect(preview).toContain("sessionToken: [redacted]");
    expect(preview).toContain("nodeId");
    expect(preview).not.toContain("never-render-this");
    expect(preview).not.toContain("nor-this");
  });

  test("bounds recursive, oversized, and circular input", () => {
    const circular: Record<string, unknown> = { command: "inspect" };
    circular["self"] = circular;
    const safe = redactToolArgsForDisplay({
      circular,
      huge: "x".repeat(8_000),
      values: Array.from({ length: 100 }, (_, index) => index),
    });
    expect(JSON.stringify(safe).length).toBeLessThan(8_000);
    expect(JSON.stringify(safe)).toContain("[omitted]");

    const wide = (depth: number): Record<string, unknown> => depth === 0
      ? { leaf: "visible" }
      : Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [`branch-${index}`, wide(depth - 1)]),
      );
    const boundedWide = JSON.stringify(redactToolArgsForDisplay(wide(3)));
    expect(boundedWide.length).toBeLessThan(20_000);
    expect(boundedWide).toContain("[omitted]");
  });

  test("never invokes accessors and safely projects prototype-like keys", () => {
    let getterCalls = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "sessionToken", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "getter-secret";
      },
    });
    Object.defineProperty(hostile, "visible", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "getter-visible-secret";
      },
    });
    Object.defineProperty(hostile, "__proto__", {
      enumerable: true,
      value: { polluted: "prototype-secret" },
    });

    const safe = redactToolArgsForDisplay(hostile);
    expect(getterCalls).toBe(0);
    expect(safe["sessionToken"]).toBe("[redacted]");
    expect(safe["visible"]).toBe("[omitted]");
    expect(safe["__proto__"]).toEqual({ polluted: "prototype-secret" });
    expect(Object.getPrototypeOf(safe)).toBe(Object.prototype);
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain("getter-secret");
    expect(JSON.stringify(safe)).not.toContain("getter-visible-secret");
  });

  test("fails closed for hostile proxies and accessor array entries", () => {
    let getterCalls = 0;
    const array: unknown[] = [];
    Object.defineProperty(array, 0, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "array-getter-secret";
      },
    });
    array.length = 1;
    expect(redactToolArgsForDisplay({ array })).toEqual({ array: ["[omitted]"] });
    expect(getterCalls).toBe(0);

    const proxy = new Proxy({}, {
      ownKeys() {
        throw new Error("hostile ownKeys trap");
      },
    });
    expect(redactToolArgsForDisplay(proxy)).toEqual({});
    expect(formatToolPreview({ name: "hostile", args: proxy })).toBe("hostile");
  });

  test("bounds tool names, file commands, and hostile argument keys", () => {
    const long = "x".repeat(2_000);
    expect(formatToolPreview({ name: long, args: {} }).length).toBeLessThanOrEqual(256);
    const filePreview = formatToolPreview({
      name: "file",
      args: { command: long, [long]: "visible" },
    });
    expect(filePreview.length).toBeLessThan(500);
    expect(filePreview).not.toContain(long);
  });

  test("parses transport summaries into redacted objects and never displays malformed input raw", () => {
    expect(parseSerializedToolArgsForDisplay(JSON.stringify({
      operation: "inspect",
      sessionToken: "transport-secret",
    }))).toEqual({ operation: "inspect", sessionToken: "[redacted]" });
    expect(parseSerializedToolArgsForDisplay("sessionToken=transport-secret")).toEqual({});
    expect(parseSerializedToolArgsForDisplay("x".repeat(70_000))).toEqual({});
  });

  test("redacts credential material embedded under legacy generic string fields", () => {
    const opaqueCursor = "Qm7_Na2-Xp9_Lc4-Vr8_Kd1-Zs6_Hf3-Wt5_By0-Gj7_Pe2-Ru9_Cx4";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SignatureAbC123456789";
    const bearer = "Bearer Ab3_Cd4-Ef5_Gh6-Ij7_Kl8-Mn9_Op0-Qr1_St2";
    const safe = redactToolArgsForDisplay({
      cursor: opaqueCursor,
      detail: `authorization: ${bearer}; assertion=${jwt}`,
      prose: "Inspect the next page and keep the current selection.",
      pageCursor: "page:2",
      documentId: opaqueCursor,
      path: `/workspace/${opaqueCursor}/design.svg`,
      sha256: "a".repeat(64),
    });

    expect(JSON.stringify(safe)).not.toContain(jwt);
    expect(JSON.stringify(safe)).not.toContain("Ab3_Cd4-Ef5_Gh6-Ij7_Kl8-Mn9_Op0-Qr1_St2");
    expect(safe).toMatchObject({
      cursor: "[redacted]",
      prose: "Inspect the next page and keep the current selection.",
      pageCursor: "page:2",
      documentId: opaqueCursor,
      path: `/workspace/${opaqueCursor}/design.svg`,
      sha256: "a".repeat(64),
    });
    expect(JSON.stringify(safe)).toContain(opaqueCursor);
    expect(redactCredentialMaterialForDisplay("ordinary-prose-with-hyphens")).toBe(
      "ordinary-prose-with-hyphens",
    );
  });

  test("omits capability fields from card args and results without mutating inputs", () => {
    const opaqueCursor = "Qm7_Na2-Xp9_Lc4-Vr8_Kd1-Zs6_Hf3-Wt5_By0-Gj7_Pe2-Ru9_Cx4";
    const args = {
      sessionToken: "session-secret",
      cursor: opaqueCursor,
      operation: "inspect",
      nested: { access_token: "nested-secret", intent: "next page" },
    };
    const result = {
      total: 4,
      returned: 2,
      omitted: 2,
      completeness: "partial",
      nextCursor: opaqueCursor,
      nested: { sessionToken: "result-secret", cursor: opaqueCursor },
      nodes: [{ name: "Ellipse" }, { name: "Diamond" }],
    };
    const argsBefore = structuredClone(args);
    const resultBefore = structuredClone(result);

    expect(projectToolArgsForCardDisplay(args)).toEqual({
      operation: "inspect",
      nested: { intent: "next page" },
    });
    expect(projectToolResultForDisplay(result)).toEqual({
      total: 4,
      returned: 2,
      omitted: 2,
      completeness: "partial",
      nested: {},
      nodes: [{ name: "Ellipse" }, { name: "Diamond" }],
    });
    expect(args).toEqual(argsBefore);
    expect(result).toEqual(resultBefore);
  });

  test("projects JSON result text precisely and sanitizes credentials in plain text", () => {
    const opaqueCursor = "Rs8_Ob3-Yq0_Md5-Wa9_Ke2-Zt7_Ig4-Xu6_Cn1-Hj8_Pf3-Sv0_Dl5";
    const projected = projectToolResultTextForDisplay(JSON.stringify({
      total: 1,
      nextCursor: opaqueCursor,
      cursorLabel: "Next page",
      tokenBudget: 2048,
      nodes: [{ name: "Pen path" }],
    }));

    expect(projected).not.toContain("nextCursor");
    expect(projected).not.toContain(opaqueCursor);
    expect(projected).toContain('"cursorLabel": "Next page"');
    expect(projected).toContain('"tokenBudget": 2048');
    expect(projected).toContain("Pen path");
    expect(projectToolResultTextForDisplay(
      "request failed with Bearer Ab3_Cd4-Ef5_Gh6-Ij7_Kl8-Mn9_Op0-Qr1_St2",
    )).toBe("request failed with Bearer [redacted]");
    expect(projectToolResultTextForDisplay(
      `{"total":1,"nextCursor":"${opaqueCursor}"`,
    )).toBe("[structured result could not be safely previewed]");
    expect(projectToolResultTextForDisplay("{draft} ordinary brace-prefixed prose")).toBe(
      "{draft} ordinary brace-prefixed prose",
    );
    expect(projectToolResultTextForDisplay("[partial shell output")).toBe(
      "[partial shell output",
    );
    const safeEnvelope = '{"staged":true,"patchId":"turn-1:abc","path":"draft.pdf"}';
    expect(projectToolResultTextForDisplay(safeEnvelope)).toBe(safeEnvelope);
  });
});
