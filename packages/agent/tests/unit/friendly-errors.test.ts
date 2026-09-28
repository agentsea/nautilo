import { describe, expect, test } from "bun:test";
import { GraphRecursionError } from "@langchain/langgraph";
import { StrictShadowEnforcementError } from "@nautilo/lattice-bridge";
import {
  toFriendlyError,
  toFriendlyGraphBudgetError,
  toFriendlyNoProgressError,
  friendlyMessageFor,
  friendlyMessageWithCode,
  codeFor,
  type FriendlyErrorCategory,
  type MdlCode,
} from "../../src/utils/friendly-errors";
import { EmptyTerminalResponseError } from "../../src/graph/empty-terminal-response";
import { DEFAULT_GRAPH_RECURSION_LIMIT } from "../../src/graph/execution-policy";
import { NoProgressError } from "../../src/graph/no-progress";

/**
 * Friendly-error translator.
 *
 * Coverage strategy: assert each user-visible category maps to its
 * canonical sentence given representative inputs (HTTP status, SDK
 * APIError shapes, plain Error messages, primitives, null). Also
 * confirm `detailsForLog` round-trips the upstream provider blob via
 * `formatProviderError` (server
 * log path unchanged) and the user-facing `message` does NOT echo
 * upstream content.
 */
describe("toFriendlyError — category mapping", () => {
  test("uncertain sharing does not recommend a replacement request or expose internal payloads", () => {
    const error = Object.assign(new Error("private token and content"), { name: "OrdinaryContentAccessRetryRequiredError" });
    const friendly = toFriendlyError(error);
    expect(friendly.category).toBe("unknown");
    expect(friendly.code).toBe("MDL007");
    expect(friendly.message).toContain("Check the original operation");
    expect(friendly.message).not.toContain("switch models");
    expect(JSON.stringify(friendly)).not.toContain("private token");
    expect(friendly.detailsForLog).toBe("ordinary_content_access_retry_required");
  });
  const cases: Array<{
    name: string;
    input: unknown;
    expected: FriendlyErrorCategory;
  }> = [
    { name: "HTTP 401 → auth", input: { status: 401 }, expected: "auth" },
    { name: "HTTP 403 → auth", input: { status: 403 }, expected: "auth" },
    {
      name: "invalid api key message → auth",
      input: new Error("Invalid API key provided"),
      expected: "auth",
    },
    { name: "HTTP 429 → rate_limit", input: { status: 429 }, expected: "rate_limit" },
    {
      name: "rate limit message → rate_limit",
      input: new Error("Rate limit exceeded"),
      expected: "rate_limit",
    },
    {
      name: "ETIMEDOUT → timeout",
      input: new Error("ETIMEDOUT"),
      expected: "timeout",
    },
    {
      name: "Provider request timed out → timeout",
      input: new Error("Provider request timed out after 45000ms"),
      expected: "timeout",
    },
    {
      name: "context length exceeded → context_exceeded",
      input: new Error("This model's maximum context length is 8192 tokens"),
      expected: "context_exceeded",
    },
    {
      name: "token limit message → context_exceeded",
      input: new Error("prompt is too long; reduce the length"),
      expected: "context_exceeded",
    },
    { name: "HTTP 400 → bad_request", input: { status: 400 }, expected: "bad_request" },
    { name: "HTTP 422 → bad_request", input: { status: 422 }, expected: "bad_request" },
    {
      name: "ZodError → bad_request",
      input: { name: "ZodError", message: "validation failed" },
      expected: "bad_request",
    },
    {
      name: "HTTP 503 → provider_unavailable",
      input: { status: 503 },
      expected: "provider_unavailable",
    },
    {
      name: "HTTP 500 → provider_unavailable",
      input: { status: 500 },
      expected: "provider_unavailable",
    },
    {
      name: "overloaded → provider_unavailable",
      input: new Error("Anthropic API overloaded"),
      expected: "provider_unavailable",
    },
    {
      name: "ECONNRESET → provider_unavailable",
      input: { code: "ECONNRESET", message: "socket hang up" },
      expected: "provider_unavailable",
    },
    {
      name: "DNS lookup failure → provider_unavailable",
      input: new Error("ENOTFOUND api.openai.com"),
      expected: "provider_unavailable",
    },
    {
      name: "plain Error with no signal → unknown",
      input: new Error("something weird happened"),
      expected: "unknown",
    },
    { name: "null → unknown", input: null, expected: "unknown" },
    { name: "undefined → unknown", input: undefined, expected: "unknown" },
    { name: "primitive number → unknown", input: 42, expected: "unknown" },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const friendly = toFriendlyError(c.input);
      expect(friendly.category).toBe(c.expected);
      expect(friendly.message).toBe(friendlyMessageFor(c.expected));
    });
  }
});

describe("toFriendlyError — sentence shape", () => {
  test("identifies a provider tool-schema integration rejection without blaming the prompt", () => {
    const raw = "tools.23.custom.input_schema.type: Field required";
    const friendly = toFriendlyError({
      status: 400,
      error: { type: "invalid_request_error", message: raw },
    });

    expect(friendly).toMatchObject({
      category: "bad_request",
      code: "MDL004",
      message: "The model provider rejected Nautilo's tool definitions. Ask an administrator to update Nautilo, or switch models in Settings → Models.",
    });
    expect(friendly.message).not.toContain(raw);
    expect(friendly.message).not.toContain("rephrasing");
    expect(friendly.detailsForLog).toContain(raw);
  });

  test("keeps ordinary HTTP 400 guidance for a Human-correctable request", () => {
    const friendly = toFriendlyError({ status: 400, message: "Invalid image format" });
    expect(friendly.message).toBe(friendlyMessageFor("bad_request"));
  });

  test("keeps stale approval identity distinct from a model failure", () => {
    const error = Object.assign(new Error("untrusted detail"), { code: "approval_request_stale" });
    expect(toFriendlyError(error)).toEqual({
      message: "That approval is no longer pending. Refresh this chat to review the current request.",
      category: "bad_request", code: "MDL004", detailsForLog: "approval_request_stale",
    });
  });
  test("explains expired sharing approval without exposing checkpoint content", () => {
    expect(toFriendlyError(new Error("protected_memory_approval_expired"))).toMatchObject({
      category: "timeout",
      code: "MDL001",
      message: "This sharing preview expired before approval. Nothing was shared by this attempt. Ask for a fresh preview.",
      detailsForLog: "protected_memory_approval_expired",
    });
  });

  test("describes a protected resume failure without blaming the model", () => {
    const friendly = toFriendlyError(
      new Error("protected_foreground_resume_failed"),
    );

    expect(friendly).toEqual({
      message: "The protected action could not resume. No completion was confirmed.",
      category: "unknown",
      code: "MDL007",
      detailsForLog: "protected_foreground_resume_failed",
    });
    expect(friendly.message).not.toContain("model");
  });

  test("gives Strict Shadow rejection a specific safe recovery message", () => {
    const rawDetail = "conversation.read.foreground_history user-secret";
    const friendly = toFriendlyError(Object.assign(new Error(rawDetail), {
      code: "strict_shadow_protected_content_required",
    }));

    expect(friendly).toMatchObject({
      category: "unknown",
      code: "MDL007",
      detailsForLog: "strict_shadow_protected_content_required",
    });
    expect(friendly.message).toContain("Encrypted history is not available");
    expect(friendly.message).toContain("Fallback Shadow");
    expect(friendly.message).not.toContain(rawDetail);
  });

  test("gives an empty terminal response a specific recovery message", () => {
    const friendly = toFriendlyError(new EmptyTerminalResponseError());
    expect(friendly).toMatchObject({
      category: "unknown",
      code: "MDL007",
      detailsForLog: "empty_terminal_response",
    });
    expect(friendly.message).toContain("stopped without returning a reply");
  });

  test("every category has a one-line non-empty sentence", () => {
    const cats: FriendlyErrorCategory[] = [
      "timeout",
      "rate_limit",
      "auth",
      "bad_request",
      "context_exceeded",
      "provider_unavailable",
      "unknown",
    ];
    for (const c of cats) {
      const msg = friendlyMessageFor(c);
      expect(msg.length).toBeGreaterThan(0);
      expect(msg.length).toBeLessThan(180);
      expect(msg.includes("\n")).toBe(false);
    }
  });

  test("user-visible message NEVER contains raw upstream JSON-RPC noise", () => {
    // Representative malformed Google JSON-RPC body.
    const upstream = new Error(
      `[GoogleGenerativeAI Error]: Invalid JSON payload received. ` +
        `Unknown name "const" at 'tools[0].function_declarations[13].` +
        `parameters.properties[41].value.any_of[0]': Cannot find field.`,
    );
    const friendly = toFriendlyError(upstream);
    // Whatever category this lands in, the user-facing message must
    // be a clean sentence — never echo `function_declarations`, the
    // bracket paths, or the upstream verb.
    expect(friendly.message.toLowerCase()).not.toContain("function_declarations");
    expect(friendly.message).not.toContain("tools[0]");
    expect(friendly.message).not.toContain("any_of");
    // But the raw blob IS preserved on `detailsForLog` for
    // server-side debugging only (NEVER for room-broadcast WS
    // events — see runtime/job.ts privacy comment).
    expect(friendly.detailsForLog).toContain("function_declarations");
  });
});

describe("toFriendlyError — protected authorization expiry", () => {
  test("uses the existing timeout category without presenting expiry as a model failure", () => {
    const friendly = toFriendlyError(new StrictShadowEnforcementError({
      boundaryId: "conversation.write.runtime_persist",
      family: "message",
      operation: "write",
      actorClass: "agent",
      state: "failed",
      reason: "deadline_expired",
      retryable: false,
      policyRevision: 8,
    }));

    expect(friendly).toEqual({
      message:
        "The encryption authorization expired before this turn finished. Please try again.",
      category: "timeout",
      code: "MDL001",
      detailsForLog: "strict_shadow_deadline_expired",
    });
  });

  test("keeps true integrity failure on the established Strict Shadow classification", () => {
    const friendly = toFriendlyError(new StrictShadowEnforcementError({
      boundaryId: "conversation.write.runtime_persist",
      family: "message",
      operation: "write",
      actorClass: "agent",
      state: "failed",
      reason: "integrity_failure",
      retryable: false,
      policyRevision: 8,
    }));

    expect(friendly.category).toBe("unknown");
    expect(friendly.code).toBe("MDL007");
    expect(friendly.detailsForLog).toBe(
      "strict_shadow_protected_content_required",
    );
  });
});

describe("toFriendlyError — MDL00x code mapping", () => {
  const expectedCodes: Array<{ category: FriendlyErrorCategory; code: MdlCode }> = [
    { category: "timeout", code: "MDL001" },
    { category: "rate_limit", code: "MDL002" },
    { category: "auth", code: "MDL003" },
    { category: "bad_request", code: "MDL004" },
    { category: "context_exceeded", code: "MDL005" },
    { category: "provider_unavailable", code: "MDL006" },
    { category: "unknown", code: "MDL007" },
  ];

  for (const { category, code } of expectedCodes) {
    test(`${category} → ${code}`, () => {
      // codeFor lookup is the canonical mapping.
      expect(codeFor(category)).toBe(code);
    });
  }

  test("toFriendlyError populates `code` matching its category", () => {
    // Drive each category through a representative input shape and
    // confirm the returned FriendlyError carries the paired code.
    const cases: Array<{ input: unknown; expected: MdlCode }> = [
      { input: new Error("ETIMEDOUT"), expected: "MDL001" },
      { input: { status: 429 }, expected: "MDL002" },
      { input: { status: 401 }, expected: "MDL003" },
      { input: { status: 400 }, expected: "MDL004" },
      {
        input: new Error("This model's maximum context length is 8192 tokens"),
        expected: "MDL005",
      },
      { input: { status: 503 }, expected: "MDL006" },
      { input: new Error("something weird"), expected: "MDL007" },
    ];
    for (const c of cases) {
      const friendly = toFriendlyError(c.input);
      expect(friendly.code).toBe(c.expected);
      // Code stays paired with category — drift guard.
      expect(friendly.code).toBe(codeFor(friendly.category));
    }
  });

  test("friendlyMessageWithCode renders bracketed sentence ending in [MDL00x]", () => {
    const friendly = toFriendlyError({ status: 503 });
    const rendered = friendlyMessageWithCode(friendly);
    expect(rendered).toContain(friendly.message);
    expect(rendered.endsWith("[MDL006]")).toBe(true);
    // Bracket-position invariant: code comes after the sentence, with
    // a single space separator. This is what room-broadcast WS events
    // and chat bubbles render verbatim.
    expect(rendered).toBe(`${friendly.message} [MDL006]`);
  });

  test("every category produces a renderable bracketed sentence", () => {
    const cats: FriendlyErrorCategory[] = [
      "timeout",
      "rate_limit",
      "auth",
      "bad_request",
      "context_exceeded",
      "provider_unavailable",
      "unknown",
    ];
    for (const c of cats) {
      // Synthesize a minimal FriendlyError to render via the helper.
      const synthetic = {
        message: friendlyMessageFor(c),
        category: c,
        code: codeFor(c),
        detailsForLog: "",
      };
      const rendered = friendlyMessageWithCode(synthetic);
      // Matches `<sentence> [MDL00x]` with the right code suffix.
      expect(rendered).toMatch(/ \[MDL00[1-7]\]$/);
      expect(rendered.endsWith(`[${codeFor(c)}]`)).toBe(true);
    }
  });
});

describe("toFriendlyError — detailsForLog round-trip", () => {
  test("OpenAI APIError shape: status, type, code, message all present in details", () => {
    const apiError = {
      status: 429,
      headers: new Map([
        ["x-request-id", "req_abc123"],
        ["retry-after", "30"],
      ]),
      error: {
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        message: "Rate limit reached for gpt-5.5 in organization org-…",
      },
    };
    const friendly = toFriendlyError(apiError);
    expect(friendly.category).toBe("rate_limit");
    expect(friendly.detailsForLog).toContain("status=429");
    expect(friendly.detailsForLog).toContain("type=rate_limit_error");
    expect(friendly.detailsForLog).toContain("code=rate_limit_exceeded");
  });

  test("plain Error: detailsForLog is the message", () => {
    const friendly = toFriendlyError(new Error("boom"));
    expect(friendly.detailsForLog).toContain("boom");
  });

  test("null / undefined: detailsForLog is a safe placeholder", () => {
    expect(toFriendlyError(null).detailsForLog).toContain("unknown");
    expect(toFriendlyError(undefined).detailsForLog).toContain("unknown");
  });
});

describe("toFriendlyError — graph-budget (GraphRecursionError) mapping", () => {
  // LangGraph's raw GraphRecursionError must never reach the user as the
  // raw framework text. It maps to a typed internal GraphBudgetOutcome (tested
  // in execution-policy.test.ts) AND a user-safe sentence here. The WS
  // `errorCategory` union in @nautilo/types is closed, so the category stays
  // `unknown` / `MDL007` on the wire; the
  // dedicated sentence is what the user reads, and the raw framework detail
  // (troubleshooting URL + literal limit) rides `detailsForLog` → server.log.
  function makeRecursionError(): GraphRecursionError {
    return new GraphRecursionError(
      'Recursion limit of 100 reached without hitting a stop condition. ' +
        'You can increase the limit by setting the "recursionLimit" config key.',
      { lc_error_code: "GRAPH_RECURSION_LIMIT" },
    );
  }

  test("GraphRecursionError → user-safe sentence (NOT the raw framework text)", () => {
    const friendly = toFriendlyError(makeRecursionError());
    // User-visible message is a clean, action-oriented sentence.
    expect(friendly.message.length).toBeGreaterThan(0);
    expect(friendly.message.includes("\n")).toBe(false);
    // Raw framework detail MUST NOT leak into the user-visible message.
    expect(friendly.message.toLowerCase()).not.toContain("recursionlimit");
    expect(friendly.message).not.toContain("Recursion limit");
    expect(friendly.message).not.toContain("troubleshooting");
    expect(friendly.message).not.toContain("langchain.com");
  });

  test("GraphRecursionError → category `unknown` / `MDL007` (closed WS union untouched)", () => {
    const friendly = toFriendlyError(makeRecursionError());
    expect(friendly.category).toBe("unknown");
    expect(friendly.code).toBe("MDL007");
    // The category/code pair stays consistent with the canonical map.
    expect(friendly.code).toBe(codeFor(friendly.category));
  });

  test("GraphRecursionError → raw framework detail preserved on detailsForLog (server.log only)", () => {
    const friendly = toFriendlyError(makeRecursionError());
    // The raw blob carries the literal limit + the troubleshooting URL so
    // `rg "GRAPH_RECURSION_LIMIT" server.log` bridges to the failure.
    expect(friendly.detailsForLog).toContain("Recursion limit");
    expect(friendly.detailsForLog).toContain("100");
  });

  test("GraphRecursionError → friendlyMessageWithCode renders a bracketed sentence ending in [MDL007]", () => {
    const friendly = toFriendlyError(makeRecursionError());
    const rendered = friendlyMessageWithCode(friendly);
    expect(rendered).toContain(friendly.message);
    expect(rendered.endsWith("[MDL007]")).toBe(true);
    // Bracket-position invariant: code comes after the sentence.
    expect(rendered).toBe(`${friendly.message} [MDL007]`);
  });

  test("rewrapped GraphRecursionError (name marker only) still maps to the graph-budget sentence", () => {
    // A transpiled / rewrapped rethrow may lose the prototype but keep `name`.
    const rewrapped = {
      name: "GraphRecursionError",
      message: 'Recursion limit of 100 reached without hitting a stop condition.',
    };
    const friendly = toFriendlyError(rewrapped);
    expect(friendly.category).toBe("unknown");
    expect(friendly.code).toBe("MDL007");
    expect(friendly.message.toLowerCase()).not.toContain("recursionlimit");
  });

  test("toFriendlyGraphBudgetError builds the graph-budget FriendlyError directly", () => {
    const friendly = toFriendlyGraphBudgetError(DEFAULT_GRAPH_RECURSION_LIMIT);
    expect(friendly.category).toBe("unknown");
    expect(friendly.code).toBe("MDL007");
    expect(friendly.message.length).toBeGreaterThan(0);
    expect(friendly.detailsForLog).toContain("graph_budget_exceeded");
    expect(friendly.detailsForLog).toContain(`recursionLimit=${DEFAULT_GRAPH_RECURSION_LIMIT}`);
  });

  test("toFriendlyGraphBudgetError with a raw error preserves the raw blob on detailsForLog", () => {
    const raw = makeRecursionError();
    const friendly = toFriendlyGraphBudgetError(100, raw);
    expect(friendly.detailsForLog).toContain("Recursion limit");
  });

  test("non-recursion errors still flow through the generic classifier (regression guard)", () => {
    // Ensure the graph-budget short-circuit did not swallow other categories.
    expect(toFriendlyError(new Error("ETIMEDOUT")).category).toBe("timeout");
    expect(toFriendlyError({ status: 429 }).category).toBe("rate_limit");
    expect(toFriendlyError({ status: 401 }).category).toBe("auth");
    expect(toFriendlyError(new Error("something weird")).category).toBe("unknown");
  });
});

describe("toFriendlyError — no-progress mapping", () => {
  function makeNoProgressError(): NoProgressError {
    return new NoProgressError({
      toolName: "file",
      operationDiscriminator: "read",
      normalizedError: "permission denied",
    });
  }

  test("NoProgressError → user-safe sentence (NOT raw tool output / secrets)", () => {
    const friendly = toFriendlyError(makeNoProgressError());
    expect(friendly.message.length).toBeGreaterThan(0);
    expect(friendly.message.includes("\n")).toBe(false);
    // Raw tool output / args / secrets MUST NOT leak into the user-visible message.
    expect(friendly.message.toLowerCase()).not.toContain("permission denied");
    expect(friendly.message).not.toContain("file");
    expect(friendly.message).not.toContain("read");
  });

  test("NoProgressError → category `unknown` / `MDL007` (closed WS union untouched)", () => {
    const friendly = toFriendlyError(makeNoProgressError());
    expect(friendly.category).toBe("unknown");
    expect(friendly.code).toBe("MDL007");
    expect(friendly.code).toBe(codeFor(friendly.category));
  });

  test("NoProgressError → grep-able token without normalized error content", () => {
    const friendly = toFriendlyError(makeNoProgressError());
    expect(friendly.detailsForLog).toContain("no_progress");
    expect(friendly.detailsForLog).toContain("tool=file");
    expect(friendly.detailsForLog).toContain("operation=read");
    expect(friendly.detailsForLog).not.toContain("permission denied");
    expect(friendly.detailsForLog).not.toContain("error=");
  });

  test("NoProgressError → friendlyMessageWithCode renders a bracketed sentence ending in [MDL007]", () => {
    const friendly = toFriendlyError(makeNoProgressError());
    const rendered = friendlyMessageWithCode(friendly);
    expect(rendered).toContain(friendly.message);
    expect(rendered.endsWith("[MDL007]")).toBe(true);
  });

  test("rewrapped NoProgressError (code marker only) still maps to the no-progress sentence", () => {
    const rewrapped = { code: "no_progress", message: "boom" };
    const friendly = toFriendlyError(rewrapped);
    expect(friendly.category).toBe("unknown");
    expect(friendly.code).toBe("MDL007");
    expect(friendly.detailsForLog).toContain("no_progress");
  });

  test("toFriendlyNoProgressError builds the no-progress FriendlyError directly", () => {
    const friendly = toFriendlyNoProgressError({
      kind: "no_progress",
      toolName: "run_shell",
      operationDiscriminator: "",
      normalizedError: "command not found",
    });
    expect(friendly.category).toBe("unknown");
    expect(friendly.code).toBe("MDL007");
    expect(friendly.message.length).toBeGreaterThan(0);
    expect(friendly.detailsForLog).toContain("no_progress");
    expect(friendly.detailsForLog).toContain("tool=run_shell");
    expect(friendly.detailsForLog).not.toContain("command not found");
  });

  test("toFriendlyNoProgressError with no outcome emits a bare no_progress token", () => {
    const friendly = toFriendlyNoProgressError(undefined);
    expect(friendly.detailsForLog).toBe("no_progress");
  });

  test("non-no-progress errors still flow through the generic / graph-budget paths (regression guard)", () => {
    expect(toFriendlyError(new Error("ETIMEDOUT")).category).toBe("timeout");
    expect(toFriendlyError(new GraphRecursionError("Recursion limit of 100 reached", {
      lc_error_code: "GRAPH_RECURSION_LIMIT",
    })).category).toBe("unknown");
  });
});


test("prepared context exhaustion uses the existing context recovery message", () => {
  const error = Object.assign(new Error("Prepared messages exceed the usable context window"), {
    code: "NAUTILO_PREPARED_CONTEXT_EXCEEDED",
  });
  const friendly = toFriendlyError(error);
  expect(friendly.category).toBe("context_exceeded");
  expect(friendly.code).toBe("MDL005");
});
