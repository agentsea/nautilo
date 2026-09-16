/**
 * D421 Phase 3 (3.1 / 3.2) — unit tests for the safe Conductor observability
 * helpers.
 *
 * Two privacy invariants under test:
 *   1. {@link sanitizeRoutingTrace} reduces a routing trace to counts/booleans/
 *      enums — raw user content, transcript snippets, the raw search query,
 *      raw Floor Manager / provider error text, and any future redirect tool
 *      reason cannot survive into the always-on `[conductor]` log line.
 *   2. {@link classifyRedirectDecision} maps ONLY a controlled redirect
 *      outcome code to a requester-private receipt outcome + reason code +
 *      server-authored display reason. It cannot accept any caller-derived
 *      text; Phase 4 attaches a validated handle separately via
 *      `selectedHandles`.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyRedirectDecision,
  sanitizeRoutingTrace,
  type RedirectOutcomeCode,
} from "../../src/messaging/conductor-observability";
import type { ConductorDecisionReasonCode } from "@nautilo/types";

describe("sanitizeRoutingTrace (D421 Phase 3 — always-on log safety)", () => {
  test("keeps counts/booleans/enums and drops raw query, error, snippets, display names, ids", () => {
    const sanitized = sanitizeRoutingTrace([
      {
        step: "filters",
        detail: { candidates: 3, coldVolunteer: 1 },
      },
      {
        step: "explicit",
        detail: { source: "mention", count: 1 },
      },
      {
        step: "human-mention",
        detail: { count: 1, handle: "casey" },
      },
      {
        step: "human-vocative",
        detail: { matched: "Casey", count: 1 },
      },
      {
        step: "direct-address",
        detail: { matches: 0 },
      },
      {
        step: "active-focus",
        detail: { active: 1 },
      },
      {
        step: "history",
        detail: {
          structural: true,
          intent: "who-talking-about",
          messageId: 101,
          query: "who was I talking to about the secret roadmap?",
          hits: 2,
          rawHits: 3,
          owner: true,
        },
      },
      {
        step: "history-baseline",
        detail: {
          query: "the user's literal message content",
          hits: 1,
          rawHits: 2,
          owner: false,
        },
      },
      {
        step: "routing-packet",
        detail: {
          presence: 2,
          replyTargets: 1,
          tempo: 4,
          recentCounterparts: 3,
          failed: false,
        },
      },
      {
        step: "routing-packet",
        detail: {
          failed: true,
          error: "db unavailable: connection reset by peer (query was 'secret roadmap')",
        },
      },
      {
        step: "addressivity",
        detail: {
          score: 0.82,
          threshold: 0.5,
          signals: { relationalRecency: 1, vocative: 0 },
          bought: true,
        },
      },
      {
        step: "coalesced-burst",
        detail: {
          count: 2,
          coveredMessageIds: [101, 102, 103],
        },
      },
    ]);

    const blob = JSON.stringify(sanitized);

    // Raw user content / query / error / snippets must not survive.
    expect(blob).not.toContain("secret roadmap");
    expect(blob).not.toContain("the user's literal message content");
    expect(blob).not.toContain("db unavailable");
    expect(blob).not.toContain("connection reset");
    expect(blob).not.toContain("Casey");
    // Both scalar and array-carried message ids are dropped.
    expect(blob).not.toContain("101");
    expect(blob).not.toContain("messageId");
    expect(blob).not.toContain("coveredMessageIds");

    // Counts/booleans/enums ARE diagnosable.
    expect(sanitized[0]!.detail).toEqual({ candidates: 3, coldVolunteer: 1 });
    expect(sanitized[1]!.detail).toEqual({ source: "mention", count: 1 });
    // Human mention trace carries only a count; the handle is dropped.
    expect(sanitized[2]!.detail).toEqual({ count: 1 });
    // Display name dropped; count kept.
    expect(sanitized[3]!.detail).toEqual({ count: 1 });
    expect(sanitized[4]!.detail).toEqual({ matches: 0 });
    expect(sanitized[5]!.detail).toEqual({ active: 1 });
    // history: query dropped, intent enum + counts + booleans kept.
    expect(sanitized[6]!.detail).toEqual({
      structural: true,
      intent: "who-talking-about",
      hits: 2,
      rawHits: 3,
      owner: true,
    });
    // history-baseline: query dropped, counts/booleans kept.
    expect(sanitized[7]!.detail).toEqual({ hits: 1, rawHits: 2, owner: false });
    // routing-packet success: all counts + boolean kept.
    expect(sanitized[8]!.detail).toEqual({
      presence: 2,
      replyTargets: 1,
      tempo: 4,
      recentCounterparts: 3,
      failed: false,
    });
    // routing-packet failure: only `failed: true` survives — no error text.
    expect(sanitized[9]!.detail).toEqual({ failed: true });
    // addressivity: numeric score/threshold + known signal keys + booleans
    // kept; unknown signal key `vocative` drops.
    expect(sanitized[10]!.detail).toEqual({
      score: 0.82,
      threshold: 0.5,
      signals: { relationalRecency: 1 },
      bought: true,
    });
    // coalesced-burst: count kept, id array dropped.
    expect(sanitized[11]!.detail).toEqual({ count: 2 });
  });

  test("drops a raw Floor Manager reason string and a future redirect tool reason", () => {
    const sanitized = sanitizeRoutingTrace([
      {
        step: "floor-manager",
        detail: {
          invoked: true,
          coldVolunteer: 2,
          fmReason: "I think Jeannie should answer because the user mentioned her Q3 deadline",
        },
      },
      {
        step: "redirect",
        detail: {
          code: "accepted",
          reason: "user asked to hand off to the assistant who knows about the merger",
          targetHandle: "jeannie-bot",
        },
      },
    ]);
    const blob = JSON.stringify(sanitized);
    expect(blob).not.toContain("Jeannie");
    expect(blob).not.toContain("Q3");
    expect(blob).not.toContain("deadline");
    expect(blob).not.toContain("merger");
    expect(blob).not.toContain("jeannie-bot");
    // Controlled booleans/counts survive.
    expect(sanitized[0]!.detail).toEqual({ invoked: true, coldVolunteer: 2 });
    // Redirect keeps only its controlled code; raw reason + handle drop.
    expect(sanitized[1]!.detail).toEqual({ code: "accepted" });
  });

  test("preserves known structural step names", () => {
    const sanitized = sanitizeRoutingTrace([
      { step: "routing-packet", detail: { recentCounterparts: 1 } },
    ]);
    expect(sanitized[0]!.step).toBe("routing-packet");
  });

  test("drops unknown steps entirely, including user-derived step names", () => {
    const sanitized = sanitizeRoutingTrace([
      { step: "user said: secret merger", detail: { count: 1 } },
      { step: "future-unknown-step", detail: { candidates: 2 } },
      { step: "filters", detail: { candidates: 3 } },
    ]);
    expect(sanitized).toEqual([
      { step: "filters", detail: { candidates: 3 } },
    ]);
  });

  test("controlled redirect code survives only on the allowlisted redirect step", () => {
    const sanitized = sanitizeRoutingTrace([
      {
        step: "redirect",
        detail: {
          code: "visible_output",
          targetHandle: "@jeannie-bot",
          reason: "raw redirect tool reason",
          messageId: 404,
        },
      },
      {
        step: "history",
        detail: { code: "accepted", hits: 1 },
      },
    ]);
    expect(sanitized).toEqual([
      { step: "redirect", detail: { code: "visible_output" } },
      { step: "history", detail: { hits: 1 } },
    ]);
  });

  test("a trace with an unrecognized enum string drops only that string", () => {
    const sanitized = sanitizeRoutingTrace([
      {
        step: "explicit",
        detail: { source: "some-new-future-source", count: 1 },
      },
    ]);
    expect(sanitized[0]!.detail).toEqual({ count: 1 });
  });
});

describe("classifyRedirectDecision (D421 Phase 3 — redirect receipt classifier)", () => {
  const ALL_CODES: RedirectOutcomeCode[] = [
    "accepted",
    "explicit_selection",
    "visible_output",
    "duplicate",
    "unknown_target",
    "ineligible_target",
    "self_target",
    "enqueue_failed",
  ];

  test("covers every controlled redirect code with a stable reason code + non-empty display reason", () => {
    const seen = new Set<ConductorDecisionReasonCode>();
    for (const code of ALL_CODES) {
      const out = classifyRedirectDecision(code);
      expect(out.displayReason.length).toBeGreaterThan(0);
      // No raw reason argument exists; the display reason is server-authored
      // and never echoes a model/tool reason.
      expect(out.displayReason).not.toContain("reason");
      seen.add(out.reasonCode);
    }
    // Eight distinct wire codes for eight controlled inputs.
    expect(seen.size).toBe(ALL_CODES.length);
  });

  test("accepted → wake / redirected with generic server-authored display", () => {
    const out = classifyRedirectDecision("accepted");
    expect(out.outcome).toBe("wake");
    expect(out.reasonCode).toBe("redirected");
    expect(out.displayReason).toBe("Redirected to another assistant.");
  });

  test("rejections map to silent with the controlled rejected reason codes", () => {
    expect(classifyRedirectDecision("explicit_selection")).toEqual({
      outcome: "silent",
      reasonCode: "redirect_rejected_explicitly_selected",
      displayReason: "Redirect skipped — you explicitly selected this assistant.",
    });
    expect(classifyRedirectDecision("visible_output")).toEqual({
      outcome: "silent",
      reasonCode: "redirect_rejected_visible_output",
      displayReason: "Redirect skipped — this assistant had already started replying.",
    });
    expect(classifyRedirectDecision("duplicate")).toEqual({
      outcome: "silent",
      reasonCode: "redirect_rejected_duplicate",
      displayReason: "Redirect skipped — this turn was already redirected.",
    });
    expect(classifyRedirectDecision("unknown_target")).toEqual({
      outcome: "silent",
      reasonCode: "redirect_rejected_no_target",
      displayReason: "Redirect skipped — that assistant wasn't found in this room.",
    });
    expect(classifyRedirectDecision("ineligible_target")).toEqual({
      outcome: "silent",
      reasonCode: "redirect_rejected_ineligible_target",
      displayReason: "Redirect skipped — that assistant isn't eligible to take over here.",
    });
    expect(classifyRedirectDecision("self_target")).toEqual({
      outcome: "silent",
      reasonCode: "redirect_rejected_same_source",
      displayReason: "Redirect skipped — an assistant can't redirect to itself.",
    });
  });

  test("enqueue_failed maps to the error outcome (not a new outcome variant)", () => {
    const out = classifyRedirectDecision("enqueue_failed");
    expect(out.outcome).toBe("error");
    expect(out.reasonCode).toBe("redirect_rejected_enqueue_failed");
    expect(out.displayReason.length).toBeGreaterThan(0);
  });

  test("only uses the existing wake|silent|ask_user|error outcome vocabulary", () => {
    const outcomes = new Set(
      ALL_CODES.map((code) => classifyRedirectDecision(code).outcome),
    );
    for (const o of outcomes) {
      expect(["wake", "silent", "ask_user", "error"]).toContain(o);
    }
  });

  test("cannot accept caller-derived text; all display reasons are static", () => {
    const out = classifyRedirectDecision("accepted");
    expect(out.displayReason).toBe("Redirected to another assistant.");
    // The rejected display reasons are static server-authored sentences.
    const rej = classifyRedirectDecision("visible_output");
    expect(rej.displayReason).toBe("Redirect skipped — this assistant had already started replying.");
  });
});
