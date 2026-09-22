import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { invalidateRuntimeConfigCache, setConfigOverrides } from "@nautilo/config";
import { z } from "zod";
import { mergeMessagesPreservingInvariants } from "@nautilo/message-invariants";
import type { NautiloState } from "../../src/agent/state";
import {
  browserDecisionCandidates,
  browserDecisionDriverCall,
  browserDecisionHandoffContent,
  browserDecisionHandoffMessage,
  browserDecisionPlanError,
  browserDecisionPlanSchema,
  currentBrowserDecision,
  settleBrowserDecision,
  type BrowserDecisionObservation,
  type BrowserDecisionPlan,
  type BrowserDecisionState,
} from "../../src/graph/browser-decision";
import { createBrowserDecisionNode } from "../../src/nodes/browser-decision";
import { projectBrowserHandoffForProvider } from "../../src/nodes/pre-model";
import { projectBrowserHistory } from "../../src/tools/browser/browser-history";
import {
  ChoiceRequestError,
  type OpenRouterChoiceInput,
} from "../../src/providers/openrouter-choice";
import {
  configureRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";
import { getUsageContext } from "../../src/usage/usage-context";

const JEV_ID = "openrouter:typesafe/jev-1.13";
const RESULTS_PROGRESS_KEY = JSON.stringify({ kind: "snapshot_contains", text: "Results" });
const TYPE_DESCRIPTION = JSON.stringify({
  kind: "type",
  role: "textbox",
  name: "Search",
  value: "blue mug",
  clear: true,
});

const plan: BrowserDecisionPlan = {
  goal: "Open the exact result and continue through the reviewed controls",
  constraints: ["Do not leave the reviewed origin"],
  allowedOrigins: ["https://shop.example"],
  actions: [
    { kind: "click", role: "button", name: "Open details" },
    { kind: "type", role: "textbox", name: "Search", text: "blue mug", clear: true },
  ],
  progress: [{ kind: "snapshot_contains", text: "Results" }],
  success: [{ kind: "snapshot_contains", text: "Order complete" }],
};

function observation(
  overrides: Partial<BrowserDecisionObservation> = {},
): BrowserDecisionObservation {
  return {
    version: 1,
    snapshot: "Results are ready",
    refs: {
      e1: { role: " button ", name: "Open   details" },
      e2: { role: "textbox", name: "Search" },
    },
    pageUrl: "https://shop.example/results",
    browserSessionId: "browser-session-1",
    observationId: "observation-1",
    ...overrides,
  };
}

function decision(overrides: Partial<BrowserDecisionState> = {}): BrowserDecisionState {
  return {
    turnId: "turn-1",
    modelId: JEV_ID,
    plan,
    phase: "decide",
    observation: observation(),
    pending: null,
    reason: null,
    recovery: {
      interventionLimit: 2,
      consecutiveEvents: 0,
      interventionAt: 2,
      progressSeen: [RESULTS_PROGRESS_KEY],
      assessNextObservation: false,
    },
    ...overrides,
  };
}

function state(overrides: Partial<NautiloState> = {}): NautiloState {
  return {
    turnId: "turn-1",
    userId: "user-1",
    messages: [],
    browserDecision: decision(),
    noProgressPendingCorrection: null,
    noProgressPendingStop: null,
    approvalDenied: false,
    approvedToolCalls: [],
    ...overrides,
  } as unknown as NautiloState;
}

function call(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ToolCall & { id: string } {
  return { id, name, args, type: "tool_call" };
}

function successfulResult(
  toolCall: ToolCall & { id: string },
  content: string,
): ToolMessage {
  return new ToolMessage({
    name: toolCall.name,
    tool_call_id: toolCall.id,
    content,
    additional_kwargs: { nautilo_tool_status: "success" },
  });
}

function failedResult(
  toolCall: ToolCall & { id: string },
  browserFailure?: string,
): ToolMessage {
  return new ToolMessage({
    name: toolCall.name,
    tool_call_id: toolCall.id,
    content: "",
    additional_kwargs: {
      nautilo_tool_status: "error",
      ...(browserFailure === undefined ? {} : { nautilo_browser_failure: browserFailure }),
    },
  });
}

function startingState(toolCall: ToolCall & { id: string }): NautiloState {
  return state({
    browserDecision: null,
    messages: [new AIMessage({ content: "", tool_calls: [toolCall] })],
  });
}

function proposedToolCall(update: Partial<NautiloState>): ToolCall & { id: string } {
  const message = update.messages?.at(-1);
  expect(AIMessage.isInstance(message)).toBe(true);
  const proposed = AIMessage.isInstance(message) ? message.tool_calls?.[0] : undefined;
  expect(proposed?.id).toBeString();
  if (!proposed?.id) throw new Error("expected one proposed tool call");
  return proposed as ToolCall & { id: string };
}

describe("browser decision policy", () => {
  test("goal and named values discover fresh targets without predicting field labels", () => {
    const supplied = "  Café\n#ffd8a8  ";
    const parsed = browserDecisionPlanSchema.parse({ goal: "Set the background", values: { "background color": supplied } });
    expect(parsed.actions).toEqual([{ kind: "click_observed" }]);
    const snapshot = call("values-plan", "browser_snapshot", { decisionPlan: parsed });
    const settled = settleBrowserDecision(startingState(snapshot), [snapshot],
      [successfulResult(snapshot, JSON.stringify(observation()))], [], JEV_ID);
    if (!settled) throw new Error("expected admitted plan");
    const fresh = observation({ refs: { e17: { role: "combobox", name: "Hex code" } } });
    const built = browserDecisionCandidates(settled.plan, fresh, 6);
    expect(built.reason).toBeNull();
    expect(built.candidates[1]?.call).toEqual({ name: "browser_type", args: { ref: "@e17", text: supplied, clear: true } });
    expect(JSON.parse(built.candidates[1]!.description)).toMatchObject({ valueName: "background color", role: "combobox", name: "Hex code" });
    expect((JSON.parse(built.candidates[1]!.description) as { value: string }).value).toBe(supplied);
    expect(built.candidates.map(({ call }) => call?.args["ref"] as unknown)).not.toContain("@e2");
  });

  test("a compact research plan builds fresh read choices and copies its query without reauthoring targets", () => {
    const research = browserDecisionPlanSchema.parse({ goal: "Compare suitable products and report evidence", values: { "search query": "under desk pedal bike" },
      actions: [{ kind: "click_observed" }, { kind: "read_observed" }], allowedOrigins: ["https://shop.example"] });
    for (const [ref, role, name] of [["e23", "searchbox", "Find something"], ["e91", "custom-control", "Keywords"]]) {
      const fresh = observation({ refs: { [ref!]: { role: role!, name: name! } } });
      const built = browserDecisionCandidates(research, fresh, 255);
      expect(built.reason).toBeNull();
      expect(built.candidates.filter(({ call }) => call?.name === "browser_read").map(({ call }) => call?.args)).toEqual([{ ref: `@${ref}` }]);
      expect(built.candidates.filter(({ call }) => call?.name === "browser_type").map(({ call }) => call?.args)).toEqual([{ ref: `@${ref}`, text: "under desk pedal bike", clear: true }]);
      expect(built.candidates.some(({ id }) => id === "needs_input")).toBe(true);
    }
  });

  test("supplied values retain complete coverage, empty text and distinct values on duplicate labels", () => {
    const valuePlan = browserDecisionPlanSchema.parse({ goal: "Fill the form", allowedOrigins: ["https://shop.example"],
      values: { "first name": "Ada", "last name": "Lovelace", "clear note": "" } });
    const fresh = observation({ refs: { e3: { role: "custom-input", name: "Name" }, e9: { role: "textbox", name: "Name" } } });
    const built = browserDecisionCandidates(valuePlan, fresh, 10);
    expect(built.reason).toBeNull();
    expect(built.candidates.filter(({ call }) => call?.name === "browser_type").map(({ call }) => call?.args)).toEqual([
      { ref: "@e3", text: "Ada", clear: true }, { ref: "@e9", text: "Ada", clear: true },
      { ref: "@e3", text: "Lovelace", clear: true }, { ref: "@e9", text: "Lovelace", clear: true },
      { ref: "@e3", text: "", clear: true }, { ref: "@e9", text: "", clear: true },
    ]);
    const overCapacity = browserDecisionCandidates(valuePlan, fresh, 9);
    expect(overCapacity.reason).toBeNull();
    expect(overCapacity.candidates).toHaveLength(13);
  });

  test("supplied-value choices do not duplicate an identical exact typing template", () => {
    const built = browserDecisionCandidates({ ...plan, values: { query: "blue mug" } }, observation(), 20);
    expect(built.reason).toBeNull();
    expect(built.candidates.filter(({ call }) => call?.name === "browser_type" && call.args["ref"] === "@e2")).toHaveLength(1);
  });

  test("equal text for different purposes preserves both semantic choices", () => {
    const built = browserDecisionCandidates({ ...plan, actions: [{ kind: "click_observed" }],
      values: { "sender name": "Alex", "recipient name": "Alex" } },
    observation({ refs: { e7: { role: "textbox", name: "Recipient" } } }), 6);
    expect(built.reason).toBeNull();
    expect(built.candidates.filter(({ call }) => call?.name === "browser_type").map(({ description }) =>
      (JSON.parse(description) as { valueName: string }).valueName)).toEqual(["sender name", "recipient name"]);
  });

  test("normalizes credential-free HTTP(S) URLs to origins for matching", () => {
    const accepted = browserDecisionPlanSchema.parse({
      ...plan,
      allowedOrigins: [
        "http://127.0.0.1:9460/catalogue.html?stage=1",
        "https://shop.example/path#detail",
        "https://shop.example",
        "http://127.0.0.1:9460",
      ],
    });
    expect(browserDecisionCandidates(
      accepted,
      observation({ pageUrl: "http://127.0.0.1:9460/results" }),
      6,
    ).reason).toBeNull();

    const snapshot = call("snapshot-root-origins", "browser_snapshot", {
      decisionPlan: accepted,
    });
    const settled = settleBrowserDecision(
      startingState(snapshot), [snapshot],
      [successfulResult(snapshot, JSON.stringify(observation({
        pageUrl: "http://127.0.0.1:9460/results",
      })))],
      [], JEV_ID,
    );
    expect(settled?.plan.allowedOrigins).toEqual([
      "http://127.0.0.1:9460",
      "https://shop.example",
    ]);
  });

  test("defaults minimal goal-and-actions plans and binds them to the fresh observation origin", () => {
    const unboundPlan = {
      goal: "Search for the exact product",
      actions: [{ kind: "click" as const, role: "button", name: "Open details", ignoredActionField: "discard" }],
      ignoredPlanField: "discard",
    };
    const parsed = browserDecisionPlanSchema.parse(unboundPlan);
    expect(parsed).toEqual({
      goal: "Search for the exact product",
      constraints: [],
      allowedOrigins: [],
      actions: [{ kind: "click", role: "button", name: "Open details" }],
      progress: [],
      success: [],
    });

    for (const [label, decisionPlan] of [
      ["omitted origins", unboundPlan],
      ["empty origins", { ...unboundPlan, constraints: [], allowedOrigins: [] }],
    ] as const) {
      const snapshot = call(`snapshot-${label}`, "browser_snapshot", { decisionPlan });
      const settled = settleBrowserDecision(
        startingState(snapshot),
        [snapshot],
        [successfulResult(snapshot, JSON.stringify(observation({
          pageUrl: "http://127.0.0.1:9460/results",
        })))],
        [],
        JEV_ID,
      );
      expect(settled?.plan.constraints).toEqual([]);
      expect(settled?.plan.allowedOrigins).toEqual(["http://127.0.0.1:9460"]);
      expect(settled?.plan).not.toHaveProperty("ignoredPlanField");
      expect(settled?.plan.actions[0]).not.toHaveProperty("ignoredActionField");
      if (!settled?.observation) throw new Error("expected a settled observation");
      const candidates = browserDecisionCandidates(settled.plan, settled.observation, 6);
      expect(candidates.reason).toBeNull();
      if (candidates.reason !== null) throw new Error("expected a minimal-plan action candidate");
      expect(candidates.candidates[0]?.call).toEqual({ name: "browser_click", args: { ref: "@e1" } });
    }
  });

  test("returns canonical, input-only plan repair guidance without guessing required semantics", () => {
    const rejected = browserDecisionPlanSchema.safeParse({
      allowedOrigins: ["https://user:test1@example.com/?canary=1"],
      ignoredPlanField: "private-planner-value",
    });
    expect(rejected.success).toBe(false);
    if (rejected.success) throw new Error("expected an invalid decision plan");

    const diagnostic: unknown = JSON.parse(browserDecisionPlanError(rejected.error));
    expect(diagnostic).toMatchObject({
      error: "invalid_browser_decision_plan",
      browserRequestSent: false,
    });
    if (diagnostic === null || typeof diagnostic !== "object") throw new Error("expected a diagnostic object");
    const record = diagnostic as Record<string, unknown>;
    expect(record["expectedContract"]).toEqual(z.toJSONSchema(browserDecisionPlanSchema, { io: "input" }));
    const issues = record["issues"];
    if (!Array.isArray(issues)) throw new Error("expected diagnostic issues");
    const issuePaths = issues.map((issue) => {
      if (issue === null || typeof issue !== "object") throw new Error("expected diagnostic issue");
      return JSON.stringify((issue as Record<string, unknown>)["path"]);
    });
    for (const requiredPath of [
      JSON.stringify(["decisionPlan", "goal"]),
      JSON.stringify(["decisionPlan", "allowedOrigins", 0]),
    ]) expect(issuePaths).toContain(requiredPath);
    expect(JSON.stringify(diagnostic)).not.toContain("private-planner-value");
    expect(JSON.stringify(diagnostic)).not.toContain("test1");
    expect(JSON.stringify(diagnostic)).not.toContain("canary");
  });

  test("hands a plan back when its default origin is not HTTP(S)", () => {
    const snapshot = call("snapshot-file-origin", "browser_snapshot", {
      decisionPlan: {
        goal: "Search for the exact product",
        actions: [{ kind: "click", role: "button", name: "Search" }],
        progress: [{ kind: "snapshot_contains", text: "Results" }],
        success: [{ kind: "snapshot_contains", text: "Found" }],
      },
    });
    const settled = settleBrowserDecision(
      startingState(snapshot),
      [snapshot],
      [successfulResult(snapshot, JSON.stringify(observation({ pageUrl: "file:///catalogue.html" })))],
      [],
      JEV_ID,
    );
    expect(settled).toMatchObject({ phase: "handoff", reason: "routine_browser_requires_http_origin" });
  });

  test("rejects credentialed, non-HTTP, and malformed allowed origins", () => {
    for (const allowedOrigin of [
      "https://user:test1@example.com/",
      "ftp://shop.example/",
      ":// malformed origin",
    ]) {
      expect(browserDecisionPlanSchema.safeParse({
        ...plan,
        allowedOrigins: [allowedOrigin],
      }).success, allowedOrigin).toBe(false);
    }
  });

  test("covers every exact normalized role/name action plus observe and defer", () => {
    const built = browserDecisionCandidates(plan, observation(), 6);

    expect(built).toEqual({
      reason: null,
      candidates: [
        {
          id: "action_0",
          description: JSON.stringify(plan.actions[0]),
          call: { name: "browser_click", args: { ref: "@e1" } },
        },
        {
          id: "action_1",
          description: TYPE_DESCRIPTION,
          call: {
            name: "browser_type",
            args: { ref: "@e2", text: "blue mug", clear: true },
          },
        },
        {
          id: "reobserve",
          description: "Observe again because the page is still changing; do not repeat an uncertain action.",
          call: { name: "browser_snapshot", args: {} },
        },
        { id: "completion_ready", description: expect.any(String) as string, call: null },
        { id: "needs_input", description: expect.any(String) as string, call: null },
        { id: "needs_visual_evidence", description: expect.any(String) as string, call: null },
        {
          id: "defer_to_genie",
          description: expect.any(String) as string,
          call: null,
        },
      ],
    });

    expect(browserDecisionCandidates(plan, observation({
      refs: { e1: { role: "button", name: "open details" } },
    }), 6)).toEqual({ candidates: [], reason: "no_planned_target_requires_genie" });
  });

  test("maps the ordinary browser controls with exact arguments and fresh semantic refs", () => {
    const expandedPlan = browserDecisionPlanSchema.parse({
      ...plan,
      actions: [
        { kind: "press", key: "Control+Alt+Shift+K" },
        { kind: "press", key: "Home" },
        { kind: "hover", role: "button", name: "Menu" },
        { kind: "double_click", role: "button", name: "Menu" },
        { kind: "scroll_into_view", role: "button", name: "Menu" },
        { kind: "select", role: "select", name: "Shipping", values: ["express", "pickup"] },
        { kind: "set_checked", role: "checkbox", name: "Subscribe", checked: false },
        { kind: "drag", from: { role: "listitem", name: "Source" }, to: { role: "listitem", name: "Destination" } },
        { kind: "scroll", direction: "left", amount: 137.5 },
        { kind: "back" },
        { kind: "forward" },
        { kind: "reload" },
        { kind: "open", url: "https://shop.example/next" },
      ],
    });
    const refs = {
      e10: { role: "button", name: "Menu" },
      e11: { role: "select", name: "Shipping" },
      e12: { role: "checkbox", name: "Subscribe" },
      e13: { role: "listitem", name: "Source" },
      e14: { role: "listitem", name: "Destination" },
    };
    const built = browserDecisionCandidates(expandedPlan, observation({ refs }), 255);
    expect(built.reason).toBeNull();
    if (built.reason !== null) throw new Error("expected expanded browser candidates");
    expect(built.candidates.slice(0, -5).map(({ call }) => call)).toEqual([
      { name: "browser_press", args: { key: "Control+Alt+Shift+K" } },
      { name: "browser_press", args: { key: "Home" } },
      { name: "browser_hover", args: { ref: "@e10" } },
      { name: "browser_double_click", args: { ref: "@e10" } },
      { name: "browser_scroll_into_view", args: { ref: "@e10" } },
      { name: "browser_select", args: { ref: "@e11", values: ["express", "pickup"] } },
      { name: "browser_set_checked", args: { ref: "@e12", checked: false } },
      { name: "browser_drag", args: { from: "@e13", to: "@e14" } },
      { name: "browser_scroll", args: { direction: "left", amount: 137.5 } },
      { name: "browser_back", args: {} },
      { name: "browser_forward", args: {} },
      { name: "browser_reload", args: {} },
      { name: "browser_open", args: { url: "https://shop.example/next" } },
    ]);
    expect(built.candidates.slice(0, 2).map(({ description }) => description)).toEqual([
      JSON.stringify({ kind: "press", key: "Control+Alt+Shift+K" }),
      JSON.stringify({ kind: "press", key: "Home" }),
    ]);
    expect(built.candidates[5]?.description).toBe(JSON.stringify({
      kind: "select", role: "select", name: "Shipping", values: ["express", "pickup"],
    }));
    expect(built.candidates[7]?.description).toBe(JSON.stringify({
      kind: "drag",
      from: { role: "listitem", name: "Source" },
      to: { role: "listitem", name: "Destination" },
    }));
    expect(built.candidates.slice(-5).map(({ id }) => id)).toEqual(["reobserve", "completion_ready", "needs_input", "needs_visual_evidence", "defer_to_genie"]);

    const remapped = browserDecisionCandidates(expandedPlan, observation({ refs: {
      e90: refs.e10, e91: refs.e11, e92: refs.e12, e93: refs.e13, e94: refs.e14,
    }, observationId: "observation-2" }), 255);
    expect(remapped.reason).toBeNull();
    if (remapped.reason !== null) throw new Error("expected remapped browser candidates");
    expect(remapped.candidates.slice(2, 8).map(({ call }) => call)).toEqual([
      { name: "browser_hover", args: { ref: "@e90" } },
      { name: "browser_double_click", args: { ref: "@e90" } },
      { name: "browser_scroll_into_view", args: { ref: "@e90" } },
      { name: "browser_select", args: { ref: "@e91", values: ["express", "pickup"] } },
      { name: "browser_set_checked", args: { ref: "@e92", checked: false } },
      { name: "browser_drag", args: { from: "@e93", to: "@e94" } },
    ]);
  });

  test("hands an ambiguous drag back without proposing either endpoint", () => {
    const dragPlan = browserDecisionPlanSchema.parse({ ...plan, actions: [{ kind: "drag",
      from: { role: "listitem", name: "Source" }, to: { role: "listitem", name: "Destination" } }] });
    expect(browserDecisionCandidates(dragPlan, observation({ refs: {
      e20: { role: "listitem", name: "Source" },
      e21: { role: "listitem", name: "Source" },
      e22: { role: "listitem", name: "Destination" },
    } }), 255)).toEqual({ candidates: [], reason: "ambiguous_target_requires_genie" });
  });

  test("rejects a known navigation outside the plan's reviewed origins before proposing it", () => {
    const navigationPlan = browserDecisionPlanSchema.parse({
      ...plan,
      actions: [{ kind: "open", url: "https://unreviewed.example/path" }],
    });
    expect(browserDecisionCandidates(navigationPlan, observation(), 255)).toEqual({
      candidates: [], reason: "navigation_outside_planned_origins",
    });
  });

  test.each([false, true])("discovers native dropdown choices in reusable and ordered actions (ordered=%s)", (ordered) => {
    const observed = observation({ refs: {
      e30: { role: "combobox", name: "Window" },
      e31: { role: "option", name: "Later" },
      e32: { role: "combobox", name: "Delivery" },
      e33: { role: "option", name: "Later" },
      e34: { role: "button", name: "Continue" },
    }, snapshot: [
      '- combobox "Window" [expanded=false, ref=e30]: Earlier',
      '  - MenuListPopup',
      '    - group "Times"',
      '      - option "Later" [ref=e31]',
      '- combobox "Delivery" [ref=e32]',
      '  - MenuListPopup',
      '    - option "Later" [selected, ref=e33]',
      '- button "Continue" [ref=e34]',
    ].join("\n") });
    const observedPlan = browserDecisionPlanSchema.parse({ ...plan, actions: [{ kind: "click_observed" }],
      ...(ordered ? { sequences: [{ name: "Choose the requested window", steps: [{ kind: "click_observed" }] }] } : {}) });
    const built = browserDecisionCandidates(observedPlan, observed, 255);
    expect(built.reason).toBeNull();
    const selections = built.candidates.filter((candidate) => candidate.call?.name === "browser_select");
    expect(selections.map((candidate) => candidate.call?.args)).toEqual([
      { ref: "@e30", values: ["Later"] }, { ref: "@e32", values: ["Later"] },
    ]);
    expect(selections[0]?.description).toContain('"name":"Window"');
    expect(selections[1]?.description).toContain('"name":"Delivery"');
    expect(built.candidates.some((candidate) => candidate.call?.name === "browser_click" && candidate.call.args["ref"] === "@e31")).toBe(false);
    expect(built.candidates.some((candidate) => candidate.call?.name === "browser_click" && candidate.call.args["ref"] === "@e34")).toBe(true);
    if (ordered) expect(selections[0]?.sequence).toEqual({ index: 0, step: 0 });
    expect(browserDecisionDriverCall(selections[0]!.call!, { kind: "connected_web", operationId: "operation-1", controlEpoch: 3 })).toEqual({
      name: "control_connected_web_operation", args: { operationId: "operation-1", expectedControlEpoch: 3,
        command: { kind: "select", ref: "@e30", values: ["Later"] } },
    });
  });

  test.each([
    ['- combobox "Custom" [ref=e1]', '  - option "Choice" [ref=e2]'],
    ['- combobox "Custom" [ref=e1]', '  - MenuListPopup', '- option "Choice" [ref=e2]'],
    ['- combobox "Wrong owner name" [ref=e1]', '  - MenuListPopup', '    - option "Choice" [ref=e2]'],
    ['- combobox "Custom" [ref=e1]', '  - MenuListPopup', '    - option "Wrong option name" [ref=e2]'],
    ['- combobox "Custom" [ref=e1]', '  - MenuListPopup', '    - option "Choice" [ref=e2]', '    - option "Choice" [ref=e3]'],
    ['- combobox "Custom" [ref=e1]', '  - MenuListPopup', '    - option "Choice" [ref=e2]', '    - option "Choice" [ref=e2]'],
  ])("retains click discovery without unique native option binding: %j", (...lines) => {
    const built = browserDecisionCandidates({ ...plan, actions: [{ kind: "click_observed" }] }, observation({
      snapshot: lines.join("\n"), refs: { e1: { role: "combobox", name: "Custom" },
        e2: { role: "option", name: "Choice" }, e3: { role: "option", name: "Choice" } },
    }), 255);
    expect(built.candidates.some((candidate) => candidate.call?.name === "browser_select")).toBe(false);
    expect(built.candidates.some((candidate) => candidate.call?.name === "browser_click" && candidate.call.args["ref"] === "@e2")).toBe(true);
  });

  test("quoted option names cannot inject a different ref and select labels remain exact", () => {
    const label = 'Choice "quoted" [ref=e99]';
    const built = browserDecisionCandidates({ ...plan, actions: [{ kind: "click_observed" }] }, observation({
      snapshot: `- combobox "Picker" [ref=e1]\n  - MenuListPopup\n    - option ${JSON.stringify(label)} [ref=e2]`,
      refs: { e1: { role: "combobox", name: "Picker" }, e2: { role: "option", name: label } },
    }), 255);
    expect(built.candidates.find((candidate) => candidate.call?.name === "browser_select")?.call?.args).toEqual({ ref: "@e1", values: [label] });
  });

  test("recovery instructs inspection before same-browser redelegation and preserves ordinary fallback", () => {
    const instruction = browserDecisionHandoffContent("browser_outcome_unknown");
    expect(instruction).toContain("Do not blindly replay an uncertain action");
    expect(instruction).toContain("corrected decisionPlan");
    expect(instruction).toContain("same browser tool");
    expect(instruction).toContain("omit completed steps");
    expect(instruction).toContain("If delegation is unavailable");
  });

  test("offers every fresh observed target without a role allowlist, preserving each observed ref and cap fence", () => {
    const observedPlan: BrowserDecisionPlan = { ...plan, actions: [{ kind: "click_observed" }] };
    const dynamic = observation({ refs: {
      e7: { role: "link", name: "New result introduced after planning" },
      e8: { role: "treeitem", name: "Unlisted control role" },
    } });
    const candidates = browserDecisionCandidates(observedPlan, dynamic, 6);
    expect(candidates.reason).toBeNull();
    if (candidates.reason !== null) throw new Error("expected dynamic observed candidates");
    expect(candidates.candidates.slice(0, 2).map((candidate) => candidate.call)).toEqual([
      { name: "browser_click", args: { ref: "@e7" } },
      { name: "browser_click", args: { ref: "@e8" } },
    ]);

    const duplicateLabels = browserDecisionCandidates(observedPlan, observation({ refs: {
      e7: { role: "button", name: "Inherited duplicate label" },
      e8: { role: "button", name: "Inherited duplicate label" },
    } }), 255);
    expect(duplicateLabels.reason).toBeNull();
    if (duplicateLabels.reason !== null) throw new Error("expected distinct observed duplicate-label candidates");
    expect(duplicateLabels.candidates.slice(0, 2)).toEqual([
      {
        id: "action_0",
        description: JSON.stringify({ kind: "click", role: "button", name: "Inherited duplicate label", targetRef: "@e7" }),
        call: { name: "browser_click", args: { ref: "@e7" } },
      },
      {
        id: "action_1",
        description: JSON.stringify({ kind: "click", role: "button", name: "Inherited duplicate label", targetRef: "@e8" }),
        call: { name: "browser_click", args: { ref: "@e8" } },
      },
    ]);

    const overCapacity = browserDecisionCandidates(observedPlan, observation({ refs: {
      e7: { role: "link", name: "First dynamic result" },
      e8: { role: "treeitem", name: "Second dynamic result" },
      e9: { role: "tab", name: "Third dynamic result" },
    } }), 6);
    expect(overCapacity.reason).toBeNull();
    expect(overCapacity.candidates).toHaveLength(8);
  });

  test("fails closed on an ambiguous exact target", () => {
    expect(browserDecisionCandidates(plan, observation({
      refs: {
        e1: { role: "button", name: "Open details" },
        e9: { role: " button ", name: "Open   details" },
      },
    }), 255)).toEqual({ candidates: [], reason: "ambiguous_target_requires_genie" });
  });

  test("distinguishes reusable exact typing choices for the same field by their supplied text", () => {
    const texts = ["Jev alpha", "Jev beta", "Jev gamma"];
    const repeatedEntryPlan = browserDecisionPlanSchema.parse({ ...plan,
      actions: [
        ...texts.map((text) => ({ kind: "type", role: "textbox", name: "Search", text, clear: true })),
        { kind: "press", key: "Enter" },
      ],
    });
    for (const refId of ["e2", "e17"]) {
      const built = browserDecisionCandidates(repeatedEntryPlan, observation({
        refs: { [refId]: { role: "textbox", name: "Search" } },
      }), 255);
      expect(built.reason).toBeNull();
      const typing = built.candidates.filter(({ call }) => call?.name === "browser_type");
      expect(typing.map(({ description }) => (JSON.parse(description) as { value: string }).value)).toEqual(texts);
      expect(typing.map(({ call }) => call?.args)).toEqual(texts.map(text => ({ ref: `@${refId}`, text, clear: true })));
      expect(built.candidates.some(({ call }) => call?.name === "browser_press" && call.args["key"] === "Enter")).toBe(true);
    }
  });

  test("named typing values expose their content as well as purpose for repeated entries", () => {
    const values = { first: "Jev alpha", second: "Jev beta", third: "Jev gamma" };
    const built = browserDecisionCandidates({ ...plan, actions: [{ kind: "click_observed" }], values },
      observation({ refs: { e2: { role: "textbox", name: "New item" } } }), 255);
    expect(built.reason).toBeNull();
    const typing = built.candidates.filter(({ call }) => call?.name === "browser_type");
    expect(typing.map(({ description }) => JSON.parse(description) as unknown)).toEqual(
      Object.entries(values).map(([valueName, value]) => ({ kind: "type", role: "textbox", name: "New item",
        targetRef: "@e2", valueName, value, clear: true })),
    );
  });

  test("preserves the complete candidate set instead of truncating it to the model cap", () => {
    const full = browserDecisionCandidates(plan, observation(), 6);
    expect(full.reason).toBeNull();
    if (full.reason !== null) throw new Error("expected full candidate set");
    expect(full.candidates).toHaveLength(7);

    const overCapacity = browserDecisionCandidates(plan, observation(), 6);
    expect(overCapacity.reason).toBeNull();
    expect(overCapacity.candidates).toEqual(full.candidates);
  });

  test("hands novel targets and origin changes back while completion evidence remains advisory", () => {
    expect(browserDecisionCandidates(plan, observation({ refs: {
      e7: { role: "link", name: "A newly introduced choice" },
    } }), 255)).toEqual({ candidates: [], reason: "no_planned_target_requires_genie" });

    const matchedEvidence = browserDecisionCandidates(plan, observation({
      snapshot: "Results\nOrder complete",
    }), 255);
    expect(matchedEvidence.reason).toBeNull();
    if (matchedEvidence.reason !== null) throw new Error("expected advisory completion evidence");
    expect(matchedEvidence.candidates.map(({ id }) => id)).toEqual([
      "action_0", "action_1", "reobserve", "completion_ready", "needs_input", "needs_visual_evidence", "defer_to_genie",
    ]);

    expect(browserDecisionCandidates(plan, observation({
      pageUrl: "https://checkout.example/order",
    }), 255)).toEqual({ candidates: [], reason: "page_left_planned_origins" });

    const noDeclaredCompletion = browserDecisionCandidates({ ...plan, success: [] }, observation(), 255);
    expect(noDeclaredCompletion.reason).toBeNull();
    if (noDeclaredCompletion.reason !== null) throw new Error("expected Genie verification defer candidate");
    const defer = noDeclaredCompletion.candidates.find(({ id }) => id === "completion_ready");
    expect(defer?.id).toBe("completion_ready");
    expect(defer?.description).toContain("independent verification");
    expect(defer?.call).toBeNull();
  });

  test("only returns a decision bound to the current turn", () => {
    const matchingDecision = decision();
    const matching = state({ browserDecision: matchingDecision });
    expect(currentBrowserDecision(matching)).toBe(matchingDecision);
    expect(currentBrowserDecision(state({ turnId: "turn-2" }))).toBeNull();
    expect(currentBrowserDecision(state({ turnId: "" }))).toBeNull();
  });

  test("builds image-space clicks and scrolling from a visual observation", () => {
    const visualPlan = browserDecisionPlanSchema.parse({ goal: "Choose Apple", allowedOrigins: ["https://shop.example"],
      actions: [{ kind: "click_observed" }] });
    const visualObservation = observation({
      refs: {},
      snapshot: '- visual viewport [image_width=800, image_height=600]\n  - visible text "Apple" [visual_ref=v1]',
      visual: {
        viewport: { imageWidth: 800, imageHeight: 600, cssWidth: 400, cssHeight: 300, dpr: 2 },
        targets: [{ visualRef: "v1", role: "visible text", name: "Apple", interaction: "unknown",
          x: 150, y: 225, context: "in the first row" }],
      },
    });
    const built = browserDecisionCandidates(visualPlan, visualObservation, 255);
    expect(built.reason).toBeNull();
    if (built.reason !== null) throw new Error("expected visual candidates");
    expect(built.candidates.find(({ id }) => id === "visual_v1")?.call)
      .toEqual({ name: "browser_mouse", args: { x: 150, y: 225, space: "image" } });
    expect(built.candidates.find(({ id }) => id === "scroll_up")?.call)
      .toEqual({ name: "browser_scroll", args: { direction: "up" } });
    expect(built.candidates.find(({ id }) => id === "scroll_down")?.call)
      .toEqual({ name: "browser_scroll", args: { direction: "down" } });
    expect(built.candidates.find(({ id }) => id === "reobserve")?.call)
      .toEqual({ name: "browser_screenshot", args: {} });
  });
});

describe("browser decision settlement", () => {
  test("starts a visual episode from multimodal screenshot text", () => {
    const screenshot = call("visual-start", "browser_screenshot", {
      decisionPlan: { goal: "Choose Apple", actions: [{ kind: "click_observed" }] },
    });
    const visual = observation({ refs: {}, visual: {
      viewport: { imageWidth: 800, imageHeight: 600, cssWidth: 400, cssHeight: 300, dpr: 2 },
      targets: [{ visualRef: "v1", role: "visible text", name: "Apple", interaction: "unknown",
        x: 150, y: 225, context: "first row" }],
    } });
    const result = successfulResult(screenshot, "unused");
    result.content = [
      { type: "text", text: JSON.stringify({ observation: visual }) },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
    ] as never;
    expect(settleBrowserDecision(startingState(screenshot), [screenshot], [result], [], JEV_ID))
      .toMatchObject({ phase: "decide", observation: visual });
  });

  test("ordinary snapshot, click, type, and press results remain outside the optional decision loop", () => {
    const ordinaryCalls = [
      call("ordinary-snapshot", "browser_snapshot", {}),
      call("ordinary-click", "browser_click", { ref: "@e1" }),
      call("ordinary-type", "browser_type", { ref: "@e2", text: "exact text", clear: true }),
      call("ordinary-press", "browser_press", { key: "Enter" }),
    ];
    for (const ordinaryCall of ordinaryCalls) {
      const ordinaryState = state({
        browserDecision: null,
        messages: [new AIMessage({ content: "", tool_calls: [ordinaryCall] })],
      });
      expect(settleBrowserDecision(
        ordinaryState,
        [ordinaryCall],
        [successfulResult(ordinaryCall, ordinaryCall.name === "browser_snapshot"
          ? JSON.stringify(observation()) : "{}")],
        [],
        JEV_ID,
      )).toBeNull();
    }
  });

  test("matching completion evidence on the starting page does not stop the decision loop", () => {
    const snapshot = call("already-done", "browser_snapshot", {
      decisionPlan: { ...plan, success: [{ kind: "snapshot_contains", text: "Results" }] },
    });
    const settled = settleBrowserDecision(startingState(snapshot), [snapshot],
      [successfulResult(snapshot, JSON.stringify(observation()))], [], JEV_ID);
    expect(settled).toMatchObject({ phase: "decide", reason: null, observation: observation() });
  });

  test("starts only from one admitted successful snapshot and binds its fresh observation", () => {
    const snapshot = call("snapshot-1", "browser_snapshot", { decisionPlan: plan });
    const result = successfulResult(snapshot, JSON.stringify(observation()));

    expect(settleBrowserDecision(
      startingState(snapshot), [snapshot], [result], [], JEV_ID,
    )).toEqual(decision());

    expect(settleBrowserDecision(
      startingState(snapshot), [snapshot, call("extra", "browser_click", { ref: "@e1" })],
      [result], [], JEV_ID,
    )).toBeNull();
    expect(settleBrowserDecision(
      startingState(snapshot), [snapshot], [result], [snapshot], JEV_ID,
    )).toBeNull();
    expect(settleBrowserDecision(
      state({ browserDecision: null, messages: [] }), [snapshot], [result], [], JEV_ID,
    )).toBeNull();
    const batchSource = state({
      browserDecision: null,
      messages: [new AIMessage({
        content: "",
        tool_calls: [snapshot, call("batched", "browser_click", { ref: "@e1" })],
      })],
    });
    expect(settleBrowserDecision(
      batchSource, [snapshot], [result], [], JEV_ID,
    )).toBeNull();
  });

  test("starts from an unambiguously misplaced top-level plan without changing the canonical tool call", () => {
    const rawArgs = { ...plan };
    const snapshot = call("snapshot-top-level-plan", "browser_snapshot", rawArgs);
    const source = startingState(snapshot);
    const settled = settleBrowserDecision(
      source, [snapshot],
      [successfulResult(snapshot, JSON.stringify(observation()))], [], JEV_ID,
    );

    expect(settled).toEqual(decision());
    expect(snapshot.args).toEqual(rawArgs);
    expect(snapshot.args).not.toHaveProperty("decisionPlan");
    const canonical = source.messages[0];
    expect(AIMessage.isInstance(canonical) ? canonical.tool_calls?.[0]?.args : null).toEqual(rawArgs);
  });

  test("malformed, legacy, and unsuccessful initial snapshots fail closed", () => {
    const snapshot = call("snapshot-1", "browser_snapshot", { decisionPlan: plan });
    for (const content of [
      "not-json",
      JSON.stringify({ ...observation(), version: undefined }),
      JSON.stringify({ snapshot: "legacy", refs: {}, url: "https://shop.example" }),
    ]) {
      expect(settleBrowserDecision(
        startingState(snapshot), [snapshot], [successfulResult(snapshot, content)], [], JEV_ID,
      )).toMatchObject({ phase: "handoff", reason: "fresh_bound_observation_unavailable" });
    }

    const failed = new ToolMessage({
      name: snapshot.name,
      tool_call_id: snapshot.id,
      content: JSON.stringify(observation()),
      additional_kwargs: { nautilo_tool_status: "error" },
    });
    expect(settleBrowserDecision(
      startingState(snapshot), [snapshot], [failed], [], JEV_ID,
    )).toMatchObject({ phase: "handoff", reason: "tool_failure_requires_genie_inspection" });
  });

  test("continues only the exact pending id, name, and arguments", () => {
    const pendingCall = call("click-1", "browser_click", { ref: "@e1" });
    const waiting = decision({
      phase: "waiting",
      pending: {
        call: pendingCall,
        browserSessionId: "browser-session-1",
        observationId: "observation-1",
      },
    });
    const base = state({ browserDecision: waiting });
    const result = successfulResult(pendingCall, JSON.stringify({ clicked: true }));

    expect(settleBrowserDecision(base, [pendingCall], [result], [], JEV_ID)).toEqual({
      ...waiting,
      phase: "observe",
      pending: null,
      reason: null,
      lastAction: { toolCallId: "click-1", description: "browser_click", beforeObservationId: "observation-1", execution: "executed" },
      recovery: { ...waiting.recovery!, assessNextObservation: true, pendingTransition: expect.stringMatching(/^[a-f0-9]{64}$/) as string },
    });

    for (const changed of [
      call("click-other", "browser_click", { ref: "@e1" }),
      call("click-1", "browser_type", { ref: "@e1" }),
      call("click-1", "browser_click", { ref: "@e2" }),
    ]) {
      expect(settleBrowserDecision(
        base, [changed], [successfulResult(changed, "{}")], [], JEV_ID,
      )).toMatchObject({ phase: "handoff", reason: "ordinary_genie_control", pending: null });
    }
  });

  test("requires a continued snapshot to remain in its bound browser session", () => {
    const snapshot = call("snapshot-2", "browser_snapshot", {});
    const waiting = decision({
      phase: "waiting",
      pending: {
        call: snapshot,
        browserSessionId: "browser-session-1",
        observationId: null,
      },
    });
    const changedSession = observation({
      browserSessionId: "browser-session-2",
      observationId: "observation-2",
    });

    expect(settleBrowserDecision(
      state({ browserDecision: waiting }), [snapshot],
      [successfulResult(snapshot, JSON.stringify(changedSession))], [], JEV_ID,
    )).toMatchObject({ phase: "handoff", reason: "fresh_bound_observation_unavailable" });
  });

  test("recovers from the first typed stale observation and intervenes on the second", () => {
    const click = call("click-stale", "browser_click", { ref: "@e1" });
    const waiting = decision({
      phase: "waiting",
      pending: {
        call: click,
        browserSessionId: "browser-session-1",
        observationId: "observation-1",
      },
    });
    const first = settleBrowserDecision(
      state({ browserDecision: waiting }), [click],
      [failedResult(click, "browser_observation_stale")], [], JEV_ID,
    );
    expect(first).toMatchObject({
      phase: "observe",
      reason: null,
      recovery: { consecutiveEvents: 1, interventionAt: 2, assessNextObservation: false },
    });
    if (!first) throw new Error("expected stale recovery");

    const snapshot = call("snapshot-stale", "browser_snapshot", {});
    const secondWaiting: BrowserDecisionState = {
      ...first,
      phase: "waiting",
      pending: {
        call: snapshot,
        browserSessionId: "browser-session-1",
        observationId: null,
      },
    };
    const second = settleBrowserDecision(
      state({ browserDecision: secondWaiting }), [snapshot],
      [failedResult(snapshot, "browser_observation_stale")], [], JEV_ID,
    );
    expect(second).toMatchObject({
      phase: "handoff",
      pending: null,
      recovery: { consecutiveEvents: 2, interventionAt: 2 },
    });
    expect(second?.reason).toBe(
      "browser_decision_intervention_required cause=browser_observation_stale count=2 limit=2",
    );
  });

  test("counts one no-progress event only after an action and its fresh snapshot", () => {
    const snapshot = call("snapshot-after-click", "browser_snapshot", {});
    const waiting = decision({
      phase: "waiting",
      pending: {
        call: snapshot,
        browserSessionId: "browser-session-1",
        observationId: null,
      },
      recovery: {
        ...decision().recovery!,
        assessNextObservation: true,
      },
    });

    expect(settleBrowserDecision(
      state({ browserDecision: waiting }), [snapshot],
      [successfulResult(snapshot, JSON.stringify(observation({ observationId: "observation-2" })))],
      [], JEV_ID,
    )).toMatchObject({
      phase: "decide",
      recovery: { consecutiveEvents: 1, assessNextObservation: false },
    });
  });

  test("without declared milestones, UUID-only observations consume budget while material changes preserve prior errors", () => {
    const noMilestonePlan: BrowserDecisionPlan = { ...plan, progress: [], success: [] };
    const snapshot = call("snapshot-no-milestone", "browser_snapshot", {});
    const waiting = decision({
      plan: noMilestonePlan,
      phase: "waiting",
      pending: { call: snapshot, browserSessionId: "browser-session-1", observationId: null },
      recovery: {
        interventionLimit: 2,
        consecutiveEvents: 0,
        interventionAt: 2,
        progressSeen: [],
        assessNextObservation: true,
      },
    });
    const uuidOnly = settleBrowserDecision(
      state({ browserDecision: waiting }), [snapshot],
      [successfulResult(snapshot, JSON.stringify(observation({ observationId: "observation-2" })))],
      [], JEV_ID,
    );
    expect(uuidOnly).toMatchObject({ phase: "decide", recovery: { consecutiveEvents: 1, assessNextObservation: false } });

    const changed = settleBrowserDecision(
      state({ browserDecision: { ...uuidOnly!, phase: "waiting", pending: {
        call: snapshot,
        browserSessionId: "browser-session-1",
        observationId: null,
      }, recovery: { ...uuidOnly!.recovery!, assessNextObservation: true } } }),
      [snapshot],
      [successfulResult(snapshot, JSON.stringify(observation({ snapshot: "Results rendered with a different product list", observationId: "observation-3" })))],
      [], JEV_ID,
    );
    expect(changed).toMatchObject({ phase: "decide", recovery: { consecutiveEvents: 1, assessNextObservation: false } });
  });

  test("changed intermediate states continue toward a pending milestone without consuming or clearing prior errors", () => {
    const sliderPlan: BrowserDecisionPlan = {
      ...plan,
      progress: [{ kind: "snapshot_contains", text: "Level 7" }],
      success: [],
    };
    const snapshot = call("snapshot-slider-progress", "browser_snapshot", {});
    let current = decision({
      plan: sliderPlan,
      observation: observation({ snapshot: "Slider Level 0" }),
      recovery: {
        interventionLimit: 3,
        consecutiveEvents: 1,
        interventionAt: 3,
        progressSeen: [],
        assessNextObservation: true,
      },
    });

    for (const level of [1, 2, 3]) {
      const waiting: BrowserDecisionState = {
        ...current,
        phase: "waiting",
        pending: { call: snapshot, browserSessionId: "browser-session-1", observationId: null },
        recovery: { ...current.recovery!, assessNextObservation: true },
      };
      const next = settleBrowserDecision(
        state({ browserDecision: waiting }), [snapshot],
        [successfulResult(snapshot, JSON.stringify(observation({
          snapshot: `Slider Level ${level}`,
          observationId: `observation-${level + 1}`,
        })))], [], JEV_ID,
      );
      expect(next).toMatchObject({
        phase: "decide",
        reason: null,
        recovery: { consecutiveEvents: 1, interventionAt: 3, progressSeen: [], assessNextObservation: false },
      });
      if (!next) throw new Error("expected changed slider evidence to continue");
      current = next;
    }
  });

  test("unchanged evidence still escalates twice while a declared milestone remains pending", () => {
    const sliderPlan: BrowserDecisionPlan = {
      ...plan,
      progress: [{ kind: "snapshot_contains", text: "Level 7" }],
      success: [],
    };
    const snapshot = call("snapshot-slider-stalled", "browser_snapshot", {});
    let current = decision({
      plan: sliderPlan,
      observation: observation({ snapshot: "Slider Level 3" }),
      recovery: {
        interventionLimit: 2,
        consecutiveEvents: 0,
        interventionAt: 2,
        progressSeen: [],
        assessNextObservation: true,
      },
    });

    for (const observationId of ["observation-2", "observation-3"]) {
      const waiting: BrowserDecisionState = {
        ...current,
        phase: "waiting",
        pending: { call: snapshot, browserSessionId: "browser-session-1", observationId: null },
        recovery: { ...current.recovery!, assessNextObservation: true },
      };
      const next = settleBrowserDecision(
        state({ browserDecision: waiting }), [snapshot],
        [successfulResult(snapshot, JSON.stringify(observation({
          snapshot: "Slider Level 3",
          observationId,
        })))], [], JEV_ID,
      );
      if (!next) throw new Error("expected stalled slider evidence to settle");
      current = next;
    }

    expect(current).toMatchObject({
      phase: "handoff",
      reason: "browser_decision_intervention_required cause=no_verified_progress count=2 limit=2",
      recovery: { consecutiveEvents: 2, interventionAt: 2, progressSeen: [] },
    });
  });

  test("a newly verified progress milestone alone clears the recovery streak", () => {
    const milestonePlan: BrowserDecisionPlan = {
      ...plan,
      progress: [
        ...plan.progress,
        { kind: "snapshot_contains", text: "Details loaded" },
      ],
    };
    const snapshot = call("snapshot-progress", "browser_snapshot", {});
    const waiting = decision({
      plan: milestonePlan,
      phase: "waiting",
      pending: {
        call: snapshot,
        browserSessionId: "browser-session-1",
        observationId: null,
      },
      recovery: {
        interventionLimit: 2,
        consecutiveEvents: 1,
        interventionAt: 2,
        progressSeen: [RESULTS_PROGRESS_KEY],
        assessNextObservation: true,
      },
    });
    const progressed = settleBrowserDecision(
      state({ browserDecision: waiting }), [snapshot],
      [successfulResult(snapshot, JSON.stringify(observation({
        snapshot: "Results\nDetails loaded",
        observationId: "observation-2",
      })))], [], JEV_ID,
    );

    expect(progressed).toMatchObject({
      phase: "decide",
      recovery: {
        consecutiveEvents: 0,
        interventionAt: 2,
        assessNextObservation: false,
      },
    });
    expect(progressed?.recovery?.progressSeen).toContain(
      JSON.stringify({ kind: "snapshot_contains", text: "Details loaded" }),
    );
  });

  test("same plan and material evidence cannot restart a handed-off episode", () => {
    const handedOff = decision({
      phase: "handoff",
      reason: "browser_decision_intervention_required cause=no_verified_progress count=2 limit=2",
      recovery: {
        ...decision().recovery!,
        consecutiveEvents: 2,
      },
    });
    const snapshot = call("snapshot-restart", "browser_snapshot", { decisionPlan: plan });
    const uuidOnlyChange = observation({ observationId: "observation-new-uuid" });
    const restart = state({
      browserDecision: handedOff,
      messages: [new AIMessage({ content: "", tool_calls: [snapshot] })],
    });

    const refused = settleBrowserDecision(
      restart, [snapshot], [successfulResult(snapshot, JSON.stringify(uuidOnlyChange))], [], JEV_ID,
    );
    expect(refused).toMatchObject({
      phase: "handoff",
      observation: handedOff.observation,
      recovery: { consecutiveEvents: 2, interventionAt: 2 },
    });
    expect(refused?.reason).toBe(
      "browser_decision_restart_requires_revised_plan_or_evidence count=2 limit=2",
    );
  });

  test("ordinary multi-tool batches retain recovery history before a refused restart", () => {
    const handedOff = decision({
      phase: "handoff",
      reason: "browser_decision_intervention_required cause=no_verified_progress count=2 limit=2",
      recovery: { ...decision().recovery!, consecutiveEvents: 2 },
    });
    const ordinary = call("ordinary-batch", "read_webpage", { url: "https://shop.example" });
    const extra = call("ordinary-extra", "browser_click", { ref: "@e1" });
    const retained = settleBrowserDecision(
      state({ browserDecision: handedOff }), [ordinary, extra],
      [successfulResult(ordinary, "{}")], [extra], JEV_ID,
    );
    expect(retained).toMatchObject({
      phase: "handoff",
      reason: "ordinary_genie_control",
      recovery: { consecutiveEvents: 2, interventionAt: 2 },
    });
    if (!retained) throw new Error("expected recovery history to remain checkpointed");

    const snapshot = call("snapshot-after-batch", "browser_snapshot", { decisionPlan: plan });
    const refused = settleBrowserDecision(
      state({
        browserDecision: retained,
        messages: [new AIMessage({ content: "", tool_calls: [snapshot] })],
      }),
      [snapshot], [successfulResult(snapshot, JSON.stringify(observation()))], [], JEV_ID,
    );
    expect(refused).toMatchObject({
      phase: "handoff",
      reason: "browser_decision_restart_requires_revised_plan_or_evidence count=2 limit=2",
      recovery: { consecutiveEvents: 2 },
    });
  });

  test("revised material evidence starts a new episode without erasing the streak", () => {
    const handedOff = decision({
      phase: "handoff",
      reason: "browser_decision_intervention_required cause=no_verified_progress count=2 limit=2",
      recovery: {
        ...decision().recovery!,
        consecutiveEvents: 2,
      },
    });
    const snapshot = call("snapshot-revised", "browser_snapshot", { decisionPlan: plan });
    const revisedEvidence = observation({
      snapshot: "Results changed materially",
      observationId: "observation-2",
    });
    const resumed = settleBrowserDecision(
      state({
        browserDecision: handedOff,
        messages: [new AIMessage({ content: "", tool_calls: [snapshot] })],
      }),
      [snapshot], [successfulResult(snapshot, JSON.stringify(revisedEvidence))], [], JEV_ID,
    );

    expect(resumed).toMatchObject({
      phase: "decide",
      observation: revisedEvidence,
      recovery: {
        interventionLimit: 2,
        consecutiveEvents: 2,
        interventionAt: 4,
        assessNextObservation: false,
      },
    });
  });

  test("revised plans baseline newly true predicates and preserve the absolute count", () => {
    const handedOff = decision({
      phase: "handoff",
      reason: "browser_decision_intervention_required cause=no_verified_progress count=2 limit=2",
      recovery: { ...decision().recovery!, consecutiveEvents: 2 },
    });
    const revisedPlan: BrowserDecisionPlan = {
      ...plan,
      goal: "Continue with the revised reviewed plan",
      progress: [...plan.progress, { kind: "snapshot_contains", text: "ready" }],
    };
    const snapshot = call("snapshot-revised-plan", "browser_snapshot", {
      decisionPlan: revisedPlan,
    });
    const resumed = settleBrowserDecision(
      state({
        browserDecision: handedOff,
        messages: [new AIMessage({ content: "", tool_calls: [snapshot] })],
      }),
      [snapshot], [successfulResult(snapshot, JSON.stringify(observation()))], [], JEV_ID,
    );

    expect(resumed).toMatchObject({
      phase: "decide",
      plan: revisedPlan,
      recovery: { consecutiveEvents: 2, interventionAt: 4 },
    });
    expect(resumed?.recovery?.progressSeen).toContain(
      JSON.stringify({ kind: "snapshot_contains", text: "ready" }),
    );
  });

  test("persists the initial policy limit across live configuration changes", () => {
    const snapshot = call("snapshot-policy", "browser_snapshot", { decisionPlan: plan });
    try {
      setConfigOverrides({ nautilo_browser_decision_intervention_limit: 3 });
      const started = settleBrowserDecision(
        startingState(snapshot), [snapshot],
        [successfulResult(snapshot, JSON.stringify(observation()))], [], JEV_ID,
      );
      expect(started?.recovery).toMatchObject({ interventionLimit: 3, interventionAt: 3 });
      if (!started) throw new Error("expected a started decision episode");

      setConfigOverrides({ nautilo_browser_decision_intervention_limit: 9 });
      const click = call("click-policy", "browser_click", { ref: "@e1" });
      const waiting: BrowserDecisionState = {
        ...started,
        phase: "waiting",
        pending: {
          call: click,
          browserSessionId: "browser-session-1",
          observationId: "observation-1",
        },
      };
      expect(settleBrowserDecision(
        state({ browserDecision: waiting }), [click],
        [failedResult(click, "browser_observation_stale")], [], JEV_ID,
      )).toMatchObject({
        recovery: { interventionLimit: 3, interventionAt: 3, consecutiveEvents: 1 },
      });
    } finally {
      setConfigOverrides({});
    }
  });

  test("cancelled, authority-lost, uncertain, invalid, and unknown failures hand off immediately", () => {
    const click = call("click-failure", "browser_click", { ref: "@e1" });
    const waiting = decision({
      phase: "waiting",
      pending: {
        call: click,
        browserSessionId: "browser-session-1",
        observationId: "observation-1",
      },
    });
    const cases: Array<[string | undefined, string]> = [
      ["browser_cancelled", "browser_cancelled"],
      ["browser_authority_lost", "browser_authority_lost"],
      ["browser_outcome_unknown", "browser_outcome_unknown"],
      ["browser_observation_invalid", "browser_observation_invalid"],
      ["not_a_known_code", "tool_failure_requires_genie_inspection"],
      [undefined, "tool_failure_requires_genie_inspection"],
    ];
    for (const [failure, reason] of cases) {
      expect(settleBrowserDecision(
        state({ browserDecision: waiting }), [click], [failedResult(click, failure)], [], JEV_ID,
      )).toMatchObject({
        phase: "handoff",
        reason,
        recovery: { consecutiveEvents: 0 },
      });
    }
  });

  test("ordinary Genie tool calls interrupt an existing decision run", () => {
    const pendingCall = call("click-1", "browser_click", { ref: "@e1" });
    const waiting = decision({
      phase: "waiting",
      pending: {
        call: pendingCall,
        browserSessionId: "browser-session-1",
        observationId: "observation-1",
      },
    });
    const ordinary = call("ordinary-1", "read_webpage", { url: "https://shop.example" });

    expect(settleBrowserDecision(
      state({ browserDecision: waiting }), [ordinary],
      [successfulResult(ordinary, "{}")], [], JEV_ID,
    )).toMatchObject({ phase: "handoff", reason: "ordinary_genie_control", pending: null });
  });
});

describe("sustained browser recovery", () => {
  test("visual handoff respects the connected driver's authority and available controls", () => {
    const content = browserDecisionHandoffContent("needs_visual_evidence", {
      kind: "connected_web", operationId: "operation-1", controlEpoch: 3,
    });
    expect(content).toContain("same operation and control epoch");
    expect(content).toContain("no screenshot or coordinate command");
    expect(content).toContain("do not switch to the unrelated embedded browser");
    expect(content).not.toContain("Inspect a screenshot");
  });

  function round(previous: BrowserDecisionState, kind: string, args: Record<string, unknown>, next: BrowserDecisionObservation): BrowserDecisionState {
    const route = (id: string, name: string, values: Record<string, unknown>) => previous.target
      ? call(id, "control_connected_web_operation", { operationId: previous.target.operationId,
        expectedControlEpoch: previous.target.controlEpoch, command: { kind: name.slice("browser_".length), ...values } })
      : call(id, name, values);
    const action = route("action", `browser_${kind}`, args);
    const waiting = { ...previous, phase: "waiting" as const, pending: { call: action,
      browserSessionId: previous.observation!.browserSessionId, observationId: previous.observation!.observationId } };
    const acted = settleBrowserDecision(state({ browserDecision: waiting }), [action],
      [successfulResult(action, JSON.stringify({ ok: true }))], [], JEV_ID)!;
    const snapshot = route("snapshot", "browser_snapshot", {});
    const observing = { ...acted, phase: "waiting" as const, pending: { call: snapshot,
      browserSessionId: next.browserSessionId, observationId: null } };
    return settleBrowserDecision(state({ browserDecision: observing }), [snapshot],
      [successfulResult(snapshot, JSON.stringify(previous.target ? { ok: true, observation: next } : next))], [], JEV_ID)!;
  }

  for (const target of [undefined, { kind: "connected_web" as const, operationId: "operation-1", controlEpoch: 3 }]) {
    const driver = target ? "connected" : "embedded";
    test(`${driver}: distinct actions with unchanged text continue; repeated ineffective transitions intervene`, () => {
      let current = decision({ ...(target ? { target } : {}), plan: { ...plan, progress: [] } });
      current = round(current, "click", { ref: "@e1" }, observation({ observationId: "fresh-1" }));
      current = round(current, "click", { ref: "@e2" }, observation({ observationId: "fresh-2" }));
      expect(current).toMatchObject({ phase: "decide", recovery: { consecutiveEvents: 0 } });
      current = round(current, "click", { ref: "@e1" }, observation({ observationId: "fresh-3" }));
      expect(current).toMatchObject({ phase: "decide", recovery: { consecutiveEvents: 1 } });
      current = round(current, "click", { ref: "@e1" }, observation({ observationId: "fresh-4" }));
      expect(current).toMatchObject({ phase: "handoff", recovery: { consecutiveEvents: 2 } });
      expect(current.reason).toContain("no_verified_progress");
    });

    test(`${driver}: detects alternating state cycles, and verified progress resets transition evidence`, () => {
      const first = observation({ snapshot: "First page" });
      const second = observation({ snapshot: "Second page" });
      let current = decision({ ...(target ? { target } : {}), observation: first, plan: { ...plan, progress: [{ kind: "snapshot_contains", text: "Milestone" }] } });
      current = round(current, "click", { ref: "@e1" }, second);
      current = round(current, "back", {}, first);
      expect(current.recovery?.consecutiveEvents).toBe(0);
      current = round(current, "click", { ref: "@e1" }, second);
      expect(current.recovery?.consecutiveEvents).toBe(1);
      const cycle = round(current, "back", {}, first);
      expect(cycle.phase).toBe("handoff");
      const progressed = round(current, "click", { ref: "@e2" }, observation({ snapshot: "Milestone" }));
      expect(progressed).toMatchObject({ phase: "decide", recovery: { consecutiveEvents: 0, transitionsSeen: [] } });
    });
  }
});

describe("browser decision node", () => {
  let priorOpenRouterKey: string | undefined;

  beforeEach(() => {
    priorOpenRouterKey = process.env["OPENROUTER_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "or-test";
    configureRuntimeModelCatalog({ catalogPointerUrl: null });
  });

  afterEach(() => {
    resetRuntimeModelCatalog();
    setConfigOverrides({});
    if (priorOpenRouterKey === undefined) delete process.env["OPENROUTER_API_KEY"];
    else process.env["OPENROUTER_API_KEY"] = priorOpenRouterKey;
    invalidateRuntimeConfigCache();
  });

  test("selects a visual target and re-observes with a screenshot after the action", async () => {
    const visualObservation = observation({ refs: {}, visual: {
      viewport: { imageWidth: 800, imageHeight: 600, cssWidth: 400, cssHeight: 300, dpr: 2 },
      targets: [{ visualRef: "v1", role: "visible text", name: "Apple", interaction: "unknown",
        x: 150, y: 225, context: "first row" }],
    } });
    const visualDecision = decision({
      plan: browserDecisionPlanSchema.parse({ goal: "Choose Apple", allowedOrigins: ["https://shop.example"] }),
      observation: visualObservation,
    });
    const node = createBrowserDecisionNode({ fullEncryptionOnlyForState: () => false, choose: async (input) => {
      expect(input.instructions).toContain("visual_ref targets execute through browser_mouse");
      return { selectedId: "visual_v1", requestedModelId: JEV_ID, resolvedModelId: JEV_ID,
        usage: { inputTokens: 5, outputTokens: 1, actualCostUsd: 0 } };
    } });
    const selected = await node(state({ browserDecision: visualDecision }), { signal: new AbortController().signal });
    const mouse = proposedToolCall(selected);
    expect(mouse).toMatchObject({ name: "browser_mouse", args: { x: 150, y: 225, space: "image" } });
    expect(selected.browserDecision?.pending?.observationId).toBe("observation-1");
    const afterMouse = settleBrowserDecision(
      state({ browserDecision: selected.browserDecision as BrowserDecisionState }),
      [mouse], [successfulResult(mouse, "clicked")], [], JEV_ID,
    );
    expect(afterMouse).toMatchObject({ phase: "observe", lastAction: { execution: "executed" } });
    const reobserve = await node(state({ browserDecision: afterMouse }), { signal: new AbortController().signal });
    expect(proposedToolCall(reobserve)).toMatchObject({ name: "browser_screenshot", args: {} });
    expect(reobserve.browserDecision?.pending?.observationId).toBeNull();
  });

  for (const connected of [false, true]) {
    test(`ordered repeated entries resolve fresh refs, observe effects and skip continuation choices (${connected ? "connected" : "embedded"})`, async () => {
      const target = connected ? { kind: "connected_web" as const, operationId: "operation-1", controlEpoch: 7 } : undefined;
      const entryTarget = { role: "textbox", name: "New entry" };
      const entries = ["First exact value", "Second different value", "Third value"];
      const groupedPlan = browserDecisionPlanSchema.parse({ ...plan, progress: [], success: [], actions: [{ kind: "click_observed" }],
        sequences: entries.map((value) => ({ name: `Add ${value}`, steps: [
          { kind: "type", ...entryTarget, text: value, clear: true }, { kind: "press", key: "Enter" },
        ] })),
      });
      let choices = 0;
      const node = createBrowserDecisionNode({ fullEncryptionOnlyForState: () => false, choose: async (input) => {
        choices++;
        expect(z.json().safeParse(input.state).success).toBe(true);
        expect(input.choices.filter((choice) => choice.id.startsWith("sequence_"))).toHaveLength(1);
        return { selectedId: input.choices.find((choice) => choice.id.startsWith("sequence_"))!.id,
          requestedModelId: JEV_ID, resolvedModelId: JEV_ID, usage: { inputTokens: 10, outputTokens: 0, actualCostUsd: 0 } };
      } });
      let refNumber = 1;
      let visibleItems: string[] = [];
      let inputValue = "";
      const fresh = () => observation({ observationId: `obs-${refNumber}`, refs: { [`e${refNumber}`]: entryTarget },
        snapshot: [`- textbox "New entry" [ref=e${refNumber}]: ${inputValue}`, ...visibleItems.map((item) => `- text: ${item}`)].join("\n") });
      let current = state({ browserDecision: decision({ plan: groupedPlan, observation: fresh(), ...(target ? { target } : {}) }) });
      for (let index = 0; index < entries.length; index++) {
        for (const kind of ["type", "press"]) {
          const update = await node(current, { signal: new AbortController().signal });
          const proposed = proposedToolCall(update);
          const args = connected ? proposed.args["command"] as Record<string, unknown> : proposed.args;
          expect(proposed.name).toBe(connected ? "control_connected_web_operation" : `browser_${kind}`);
          expect(args["ref"]).toBe(`@e${refNumber}`);
          if (connected) expect(proposed.args).toMatchObject({ operationId: "operation-1", expectedControlEpoch: 7 });
          if (kind === "type") {
            expect(args["text"]).toBe(entries[index]);
            inputValue = String(args["text"]);
          } else {
            expect(args["key"]).toBe("Enter");
            visibleItems = [...visibleItems, inputValue]; inputValue = "";
          }
          expect(choices).toBe(index + 1);
          current = { ...current, ...update, messages: mergeMessagesPreservingInvariants(current.messages, update.messages ?? []) };
          const result = successfulResult(proposed, JSON.stringify({ ok: true }));
          const acted = settleBrowserDecision(current, [proposed], [result], [], JEV_ID)!;
          expect(acted.lastAction?.execution).toBe("executed");
          expect(acted.lastAction?.effect).toBeUndefined();
          current = { ...current, browserDecision: acted, messages: [...current.messages, result] };
          const observe = await node(current, { signal: new AbortController().signal });
          const observeCall = proposedToolCall(observe);
          expect(choices).toBe(index + 1);
          refNumber++;
          const after = fresh();
          const observed = successfulResult(observeCall, JSON.stringify(connected ? { ok: true, observation: after } : after));
          current = { ...current, ...observe, messages: mergeMessagesPreservingInvariants(current.messages, observe.messages ?? []) };
          const settled = settleBrowserDecision(current, [observeCall], [observed], [], JEV_ID)!;
          expect(settled.lastAction?.afterObservationId).toBe(after.observationId);
          if (kind === "type") {
            expect(settled.lastAction?.effect?.added).toContain(`- textbox "New entry": ${entries[index]}`);
            expect(settled.lastAction?.effect?.added).not.toContain(`- text: ${entries[index]}`);
          } else expect(settled.lastAction?.effect?.added).toContain(`- text: ${entries[index]}`);
          current = { ...current, browserDecision: settled, messages: [...current.messages, observed] };
        }
      }
      expect(visibleItems).toEqual(entries);
      expect(choices).toBe(3);
      expect(current.browserDecision?.sequence).toEqual({ index: 3, step: null });
    });
  }

  for (const connected of [false, true]) {
    test(`ordered input requires fresh target evidence; stale observations never become action effects (${connected ? "connected" : "embedded"})`, () => {
      const target = connected ? { kind: "connected_web" as const, operationId: "operation-1", controlEpoch: 7 } : undefined;
      const grouped = browserDecisionPlanSchema.parse({ goal: "Enter a value, then submit", sequences: [{ name: "Enter and submit", steps: [
        { kind: "type", role: "textbox", name: "Search", text: "exact value", clear: true }, { kind: "press", key: "Enter" },
      ] }] });
      const snapshotCall = call("fresh-check", connected ? "control_connected_web_operation" : "browser_snapshot", connected
        ? { operationId: "operation-1", expectedControlEpoch: 7, command: { kind: "snapshot" } } : {});
      const inspect = (snapshot: string, execution: "executed" | "not_executed_stale" = "executed") => {
        const before = decision({ plan: grouped, ...(target ? { target } : {}), phase: "waiting", sequence: { index: 0, step: 0 },
          pending: { call: snapshotCall, browserSessionId: "browser-session-1", observationId: null },
          lastAction: { toolCallId: "typed", description: "Enter exact value", beforeObservationId: "observation-1", execution } });
        const after = observation({ observationId: "fresh-observation", refs: { e9: { role: "textbox", name: "Search" } }, snapshot });
        const result = successfulResult(snapshotCall, JSON.stringify(connected ? { ok: true, observation: after } : after));
        return settleBrowserDecision(state({ browserDecision: before }), [snapshotCall], [result], [], JEV_ID)!;
      };
      for (const snapshot of ['- textbox "Search" [ref=e9]', '- textbox "Search" [ref=e9]: wrong\n- text: exact value', '- textbox "Search" [ref=e9]: exact value extra']) {
        const stopped = inspect(snapshot);
        expect(stopped.phase).toBe("handoff");
        expect(stopped.reason).toContain("sequence_input_effect_unverified");
        expect(stopped.sequence).toEqual({ index: 0, step: 0 });
        expect(stopped.lastAction?.execution).toBe("executed");
      }
      const verified = inspect('- textbox "Search" [required, ref=e9]: exact value');
      expect(verified.phase).toBe("decide");
      expect(verified.sequence).toEqual({ index: 0, step: 1 });
      const stale = inspect('- textbox "Search" [ref=e9]: changed externally', "not_executed_stale");
      expect(stale.lastAction?.afterObservationId).toBe("fresh-observation");
      expect(stale.lastAction?.effect).toBeUndefined();
      expect(stale.sequence).toEqual({ index: 0, step: 0 });
    });
  }

  test("ordered input does not invent submission and preserves an uncertain failing substep", async () => {
    const typed = { kind: "type" as const, role: "textbox", name: "Search", text: "draft text", clear: true };
    const grouped = { ...plan, sequences: [{ name: "Write without submitting", steps: [typed] }] };
    const built = browserDecisionCandidates(grouped, observation(), 255);
    expect(built.candidates.filter((candidate) => candidate.sequence).map((candidate) => candidate.call?.name)).toEqual(["browser_type"]);
    const press = call("uncertain-submit", "browser_press", { key: "Enter", ref: "@e2" });
    const waiting = decision({ sequence: { index: 0, step: 1 }, phase: "waiting", pending: {
      call: press, browserSessionId: "browser-session-1", observationId: "observation-1",
    }, plan: { ...plan, sequences: [{ name: "Write and submit", steps: [typed, { kind: "press", key: "Enter" }] }] } });
    const error = failedResult(press, "browser_outcome_unknown");
    error.content = "Keyboard dispatch timed out after input began";
    const stopped = settleBrowserDecision(state({ browserDecision: waiting }), [press], [error], [], JEV_ID)!;
    expect(stopped).toMatchObject({ phase: "handoff", sequence: { index: 0, step: 1 },
      lastAction: { execution: "uncertain", error: "Keyboard dispatch timed out after input began" } });
    expect(browserDecisionHandoffContent(stopped.reason!, stopped.target, stopped)).toContain("Keyboard dispatch timed out after input began");
    const stale = settleBrowserDecision(state({ browserDecision: waiting }), [press], [failedResult(press, "browser_observation_stale")], [], JEV_ID)!;
    expect(stale).toMatchObject({ phase: "observe", sequence: { index: 0, step: 1 }, lastAction: { execution: "not_executed_stale" } });
  });

  test("ready ordered work excludes overlapping reusable values and retains explicit handoff choices", () => {
    const grouped = browserDecisionPlanSchema.parse({ ...plan, values: { first: "first", second: "second" }, sequences: [
      { name: "Enter first", steps: [{ kind: "type", role: "textbox", name: "Search", text: "first", clear: true }, { kind: "press", key: "Enter" }] },
      { name: "Enter second", steps: [{ kind: "type", role: "textbox", name: "Search", text: "second", clear: true }] },
    ] });
    const built = browserDecisionCandidates(grouped, observation(), 255);
    expect(built.reason).toBeNull();
    const actions = built.candidates.filter((candidate) => candidate.call && candidate.id !== "reobserve");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.call?.args).toMatchObject({ text: "first" });
    expect(actions[0]?.sequence).toEqual({ index: 0, step: 0 });
    for (const id of ["reobserve", "defer_to_genie", "needs_visual_evidence"]) expect(built.candidates.some((candidate) => candidate.id === id)).toBe(true);
  });

  test("malformed ordered steps return a field-specific contract for repair before browser execution", () => {
    const parsed = browserDecisionPlanSchema.safeParse({ goal: "Add an entry", sequences: [{ name: "Add", steps: [
      { kind: "type", role: "textbox", name: "Entry", clear: true },
    ] }] });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected invalid plan");
    const error = JSON.parse(browserDecisionPlanError(parsed.error)) as { browserRequestSent: boolean; issues: unknown[]; expectedContract: { properties: Record<string, unknown> } };
    expect(error.browserRequestSent).toBe(false);
    expect(error.issues).toContainEqual({ path: ["decisionPlan", "sequences", 0, "steps", 0, "text"], code: "invalid_type" });
    expect(error.expectedContract.properties["sequences"]).toBeDefined();
  });

  test("a later group cannot be offered first and a missing future field does not hide current discovery", () => {
    const grouped = { ...plan, sequences: [{ name: "Fill the next page", steps: [
      { kind: "type" as const, role: "textbox", name: "Future field", text: "exact", clear: true },
    ] }, { name: "Later group", steps: [{ kind: "reload" as const }] }] };
    const ready = browserDecisionCandidates(grouped, observation(), 255);
    expect(ready.reason).toBeNull();
    expect(ready.candidates.some((candidate) => candidate.call?.name === "browser_click")).toBe(true);
    expect(ready.candidates.some((candidate) => candidate.sequence)).toBe(false);
    expect(browserDecisionCandidates(grouped, observation(), 255, { index: 0, step: 0 }).reason).toBe("no_planned_target_requires_genie");
  });

  test.each(["completion_ready", "needs_input", "needs_visual_evidence"])("returns explicit %s without any browser mutation", async (selectedId) => {
    const snapshot = call("snapshot-handoff", "browser_snapshot", { decisionPlan: plan });
    const messages = [new AIMessage({ content: "", tool_calls: [snapshot] }), successfulResult(snapshot, JSON.stringify(observation()))];
    const node = createBrowserDecisionNode({ fullEncryptionOnlyForState: () => false,
      choose: async (input) => {
        expect(input.choices.some(({ id }) => id === selectedId)).toBe(true);
        return { selectedId, requestedModelId: JEV_ID, resolvedModelId: JEV_ID,
          usage: { inputTokens: 1, outputTokens: 1, actualCostUsd: 0 } };
      },
    });
    const update = await node(state({ messages }), { signal: new AbortController().signal });
    expect(update.browserDecision).toMatchObject({ phase: "handoff", reason: selectedId, pending: null });
    expect(SystemMessage.isInstance(update.messages?.at(-1))).toBe(true);
    const projected = projectBrowserHandoffForProvider(update.messages!, state({ messages: update.messages!, browserDecision: update.browserDecision ?? null }));
    expect(projected.messages.at(-1)?.content).toContain(selectedId === "completion_ready" ? "Independently verify" : selectedId === "needs_input" ? "browser_decision_input_required" : "Inspect a screenshot");
  });

  test("uses the accounted Choice seam and proposes rather than approves the selected call", async () => {
    const controller = new AbortController();
    let received: OpenRouterChoiceInput | undefined;
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async (input) => {
        received = input;
        return {
          selectedId: "action_0",
          requestedModelId: JEV_ID,
          resolvedModelId: "typesafe/jev-1.13-20260917",
          usage: { inputTokens: 80, outputTokens: 4, actualCostUsd: 0.00000336 },
        };
      },
    });

    const update = await node(state(), { signal: controller.signal });
    expect(received).toMatchObject({
      modelId: JEV_ID,
      tenantContext: { ownerId: "user-1" },
      signal: controller.signal,
      state: {
        goal: plan.goal,
        constraints: plan.constraints,
        snapshot: "Results are ready",
        completionEvidence: [{ kind: "snapshot_contains", text: "Order complete", matches: false }],
      },
      choices: [
        { id: "action_0", description: JSON.stringify(plan.actions[0]) },
        { id: "action_1", description: TYPE_DESCRIPTION },
        { id: "reobserve" },
        { id: "completion_ready" },
        { id: "needs_input" },
        { id: "needs_visual_evidence" },
        { id: "defer_to_genie" },
      ],
    });
    const transmittedRequest = JSON.stringify(received);
    expect(transmittedRequest).toContain("blue mug");
    expect(transmittedRequest).not.toContain("shop.example");
    expect(transmittedRequest).not.toContain("allowedOrigins");
    expect(transmittedRequest).not.toContain("pageUrl");
    expect(transmittedRequest).not.toContain("refs");
    expect(transmittedRequest).not.toContain("browserSessionId");
    expect(transmittedRequest).not.toContain("observationId");
    expect(transmittedRequest).toContain("Order complete");
    expect(update.browserDecision).toMatchObject({
      phase: "waiting",
      pending: { call: { name: "browser_click", args: { ref: "@e1" } } },
    });
    expect(proposedToolCall(update)).toMatchObject({
      name: "browser_click",
      args: { ref: "@e1" },
    });
    const receipt = AIMessage.isInstance(update.messages?.at(-1))
      ? update.messages.at(-1)?.additional_kwargs["nautilo_browser_decision"] : null;
    expect(receipt).toMatchObject({ choiceCalls: 1, screeningRounds: 0 });
    expect(Object.hasOwn(update, "approvedToolCalls")).toBe(false);
  });

  test("projects a routine handoff onto its exact provider-only tool receipt without mutating canonical history", async () => {
    const snapshot = call("snapshot-projectable-handoff", "browser_snapshot", { decisionPlan: plan });
    const snapshotResult = successfulResult(snapshot, JSON.stringify(observation()));
    const canonicalMessages = [
      new SystemMessage("stable leading authority"),
      new AIMessage({ content: "", tool_calls: [snapshot] }),
      snapshotResult,
    ];
    const handedOff = decision({ phase: "handoff", reason: "decision_model_unavailable" });
    const sourceState = state({ messages: canonicalMessages, browserDecision: handedOff });

    const projected = projectBrowserHandoffForProvider(canonicalMessages, sourceState);
    expect(projected.projected).toBe(true);
    expect(projected.messages[0]?.content).toBe("stable leading authority");
    expect(snapshotResult.content).toBe(JSON.stringify(observation()));
    expect(canonicalMessages[2]).toBe(snapshotResult);
    const providerReceipt = projected.messages[2];
    expect(ToolMessage.isInstance(providerReceipt)).toBe(true);
    if (!ToolMessage.isInstance(providerReceipt) || typeof providerReceipt.content !== "string") {
      throw new Error("expected projected browser tool receipt");
    }
    expect(providerReceipt.content).toContain(JSON.stringify(observation()));
    expect(providerReceipt.content).toContain("decision_model_unavailable");
    expect(providerReceipt.content).toContain("[Runtime browser supervision]");
    expect(providerReceipt.additional_kwargs["nautilo_browser_supervision"]).toBe("decision_model_unavailable");
    expect(providerReceipt.tool_call_id).toBe(snapshot.id);

    expect(projectBrowserHandoffForProvider(canonicalMessages, state({
      turnId: "new-turn",
      messages: canonicalMessages,
      browserDecision: handedOff,
    }))).toEqual({ messages: canonicalMessages, projected: false });
    expect(projectBrowserHandoffForProvider(canonicalMessages, state({
      messages: canonicalMessages,
      browserDecision: null,
    }))).toEqual({ messages: canonicalMessages, projected: false });

    const windowed = [new SystemMessage("stable leading authority"), new HumanMessage("continue")];
    const fallback = projectBrowserHandoffForProvider(windowed, state({
      messages: canonicalMessages,
      browserDecision: handedOff,
    }));
    expect(fallback.projected).toBe(false);
    expect(fallback.messages[0]?.content).toBe("stable leading authority");
    expect(fallback.messages.at(-1)?.content).toContain("decision_model_unavailable");
    expect(windowed).toHaveLength(2);
    const deduplicated = projectBrowserHandoffForProvider(fallback.messages, state({
      messages: canonicalMessages,
      browserDecision: handedOff,
    }));
    expect(deduplicated.messages).toBe(fallback.messages);

    const visualCall = call("visual-browser-result", "browser_screenshot", {});
    const nonTextTail = [
      ...canonicalMessages,
      new AIMessage({ content: "", tool_calls: [visualCall] }),
      new ToolMessage({
        name: visualCall.name,
        tool_call_id: visualCall.id,
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,fixture" } }],
      }),
    ];
    const nonTextFallback = projectBrowserHandoffForProvider(nonTextTail, state({
      messages: nonTextTail,
      browserDecision: handedOff,
    }));
    expect(SystemMessage.isInstance(nonTextFallback.messages.at(-1))).toBe(true);
    expect(nonTextFallback.messages.at(-1)?.content).toContain("decision_model_unavailable");

    const ordinary = decision({ phase: "handoff", reason: "ordinary_genie_control" });
    expect(projectBrowserHandoffForProvider(windowed, state({
      messages: canonicalMessages,
      browserDecision: ordinary,
    }))).toEqual({ messages: windowed, projected: false });
  });

  test("records projectable handoffs without sending a late System message to the provider", async () => {
    const snapshot = call("snapshot-projectable-node", "browser_snapshot", { decisionPlan: plan });
    const messages = [
      new AIMessage({ content: "", tool_calls: [snapshot] }),
      successfulResult(snapshot, JSON.stringify(observation())),
    ];
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async () => ({
        selectedId: "defer_to_genie",
        requestedModelId: JEV_ID,
        resolvedModelId: "typesafe/jev-1.13-20260917",
        usage: { inputTokens: 20, outputTokens: 2, actualCostUsd: null },
      }),
    });
    const update = await node(state({ messages }), { signal: new AbortController().signal });

    expect(update.browserDecision).toMatchObject({ phase: "handoff", reason: "jev_requested_genie" });
    expect(SystemMessage.isInstance(update.messages?.at(-1))).toBe(true);
    if (!update.browserDecision) throw new Error("expected projectable handoff state");
    const projected = projectBrowserHandoffForProvider(update.messages!, state({
      messages: update.messages!,
      browserDecision: update.browserDecision,
    }));
    expect(projected.projected).toBe(true);
    expect(projected.messages[1]?.content).toContain("jev_requested_genie");
    expect(projected.messages.some(SystemMessage.isInstance)).toBe(false);
  });

  test.each(["browser_snapshot", "control_connected_web_operation"])(
    "%s retains completed delegation after verification, compaction and control-state replacement", (toolName) => {
      const snapshot = call("completed-segment", toolName, toolName === "browser_snapshot" ? {} : { command: { kind: "snapshot" } });
      const receipt = successfulResult(snapshot, JSON.stringify(toolName === "browser_snapshot"
        ? observation() : { ok: true, observation: observation() }));
      const history = [new AIMessage({ content: "", tool_calls: [snapshot] }), receipt];
      const completed = decision({ phase: "handoff", reason: "completion_ready", sequence: { index: 1, step: null },
        lastAction: { toolCallId: "saved", description: "Save the requested draft", beforeObservationId: "before-save", execution: "executed" } });
      const event = browserDecisionHandoffMessage(history, completed);
      const verify = call("verify", "browser_read_page", {});
      const verification = successfulResult(verify, "Saved draft verified");
      const after = [...history, event, new AIMessage({ content: "", tool_calls: [verify] }), verification];
      const ordinary = settleBrowserDecision(state({ messages: after, browserDecision: completed }), [verify], [verification], [], JEV_ID);
      expect(ordinary?.reason).toBe("ordinary_genie_control");
      for (let index = 2; index <= 3; index++) {
        const observe = call(`verify-${index}`, toolName, snapshot.args);
        const observed = observation({ observationId: `verified-${index}`, snapshot: `Fresh verification ${index}` });
        after.push(new AIMessage({ content: "", tool_calls: [observe] }), successfulResult(observe,
          JSON.stringify(toolName === "browser_snapshot" ? observed : { ok: true, observation: observed })));
      }
      const compacted = projectBrowserHistory(after).messages;
      expect(compacted[1]?.content).toContain("Older browser evidence omitted");
      for (const browserDecision of [ordinary, null]) {
        const projected = projectBrowserHandoffForProvider(compacted, state({ messages: after, browserDecision }));
        expect(projected.projected).toBe(true);
        expect(projected.messages[1]?.content).toContain('"handoffReason":"completion_ready"');
        expect(projected.messages[1]?.content).toContain(JEV_ID);
        expect(projected.messages[1]?.content).toContain("Save the requested draft");
        expect(projected.messages.at(-1)?.content).toBe(after.at(-1)?.content);
        expect(projected.messages.some(SystemMessage.isInstance)).toBe(false);
        expect(projected.messages.filter((message) => typeof message.content === "string"
          && message.content.includes("[Runtime browser supervision]"))).toHaveLength(1);
      }
      expect(receipt.content).not.toContain("supervision");
      expect(after).toContain(event);
      // Missing or ambiguous anchors retain the event instead of attaching it to a different operation.
      for (const ambiguous of [after.filter((message) => message !== receipt), [...after, receipt]]) {
        const projected = projectBrowserHandoffForProvider(ambiguous, state({ browserDecision: ordinary }));
        expect(projected.messages).toContain(event);
        expect(projected.projected).toBe(false);
      }
    },
  );

  test("runs an arbitrary press template through Choice and records its selected proposal", async () => {
    const exactKey = "Control+Alt+Shift+K";
    const pressPlan = browserDecisionPlanSchema.parse({ ...plan, actions: [{ kind: "press", key: exactKey }] });
    const controller = new AbortController();
    let received: OpenRouterChoiceInput | undefined;
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async (input) => {
        received = input;
        return { selectedId: "action_0", requestedModelId: JEV_ID,
          resolvedModelId: "typesafe/jev-1.13-20260917",
          usage: { inputTokens: 12, outputTokens: 2, actualCostUsd: 0.000001 } };
      },
    });
    const update = await node(state({ browserDecision: decision({ plan: pressPlan }) }), { signal: controller.signal });

    expect(received?.choices).toEqual([
      { id: "action_0", description: JSON.stringify({ kind: "press", key: exactKey }) },
      { id: "reobserve", description: expect.any(String) as string },
      { id: "completion_ready", description: expect.any(String) as string },
      { id: "needs_input", description: expect.any(String) as string },
      { id: "needs_visual_evidence", description: expect.any(String) as string },
      { id: "defer_to_genie", description: expect.any(String) as string },
    ]);
    expect(proposedToolCall(update)).toMatchObject({ name: "browser_press", args: { key: exactKey } });
    expect(update.browserDecision).toMatchObject({
      phase: "waiting",
      pending: { call: { name: "browser_press", args: { key: exactKey } }, observationId: "observation-1" },
    });
    const receipt = AIMessage.isInstance(update.messages?.at(-1))
      ? update.messages.at(-1)?.additional_kwargs["nautilo_browser_decision"] : null;
    expect(receipt).toMatchObject({ selectedId: "action_0", choiceCalls: 1, screeningRounds: 0 });
  });

  test.each([
    {
      label: "autocomplete query match still permits selecting its suggestion",
      plan: { ...plan, actions: [{ kind: "click", role: "option", name: "Blue mug" }],
        success: [{ kind: "snapshot_contains", text: "blue mug" }] } satisfies BrowserDecisionPlan,
      observation: observation({ snapshot: "Search: blue mug\nSuggestions available",
        refs: { e7: { role: "option", name: "Blue mug" } } }),
      expected: { name: "browser_click", args: { ref: "@e7" } },
      evidence: { kind: "snapshot_contains", text: "blue mug", matches: true },
    },
    {
      label: "prefilled text match still permits saving the form",
      plan: { ...plan, actions: [{ kind: "click", role: "button", name: "Save" }],
        success: [{ kind: "snapshot_contains", text: "Ada" }] } satisfies BrowserDecisionPlan,
      observation: observation({ snapshot: "Name Ada\nChanges not saved",
        refs: { e8: { role: "button", name: "Save" } } }),
      expected: { name: "browser_click", args: { ref: "@e8" } },
      evidence: { kind: "snapshot_contains", text: "Ada", matches: true },
    },
    {
      label: "matching starting URL still permits pending work",
      plan: { ...plan, actions: [{ kind: "click", role: "button", name: "Continue" }],
        success: [{ kind: "url_equals", url: "https://shop.example/results" }] } satisfies BrowserDecisionPlan,
      observation: observation({ snapshot: "Setup is still pending",
        refs: { e9: { role: "button", name: "Continue" } } }),
      expected: { name: "browser_click", args: { ref: "@e9" } },
      evidence: { kind: "url_equals", url: "https://shop.example/results", matches: true },
    },
  ])("passes literal completion evidence while preserving the selected tool binding: $label", async (fixture) => {
    const controller = new AbortController();
    let received: OpenRouterChoiceInput | undefined;
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async (input) => {
        received = input;
        return { selectedId: "action_0", requestedModelId: JEV_ID,
          resolvedModelId: "typesafe/jev-1.13-20260917",
          usage: { inputTokens: 20, outputTokens: 2, actualCostUsd: null } };
      },
    });
    const update = await node(state({ browserDecision: decision({
      plan: fixture.plan,
      observation: fixture.observation,
    }) }), { signal: controller.signal });

    expect((received?.state as Record<string, unknown>)["completionEvidence"]).toEqual([fixture.evidence]);
    expect(proposedToolCall(update)).toMatchObject(fixture.expected);
    expect(update.browserDecision).toMatchObject({
      phase: "waiting",
      pending: { call: fixture.expected, observationId: fixture.observation.observationId },
    });
  });

  test.each([
    {
      label: "matched evidence with an otherwise completed goal",
      success: [{ kind: "snapshot_contains", text: "Order complete" }] as BrowserDecisionPlan["success"],
      snapshot: "Results\nOrder complete",
      matches: true,
    },
    {
      label: "unmatched evidence when the full fresh state otherwise supports handback",
      success: [{ kind: "snapshot_contains", text: "Receipt ready" }] as BrowserDecisionPlan["success"],
      snapshot: "Order complete",
      matches: false,
    },
  ])("allows Choice to defer without proposing an effect: $label", async (fixture) => {
    const controller = new AbortController();
    let received: OpenRouterChoiceInput | undefined;
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async (input) => {
        received = input;
        return { selectedId: "defer_to_genie", requestedModelId: JEV_ID,
          resolvedModelId: "typesafe/jev-1.13-20260917",
          usage: { inputTokens: 20, outputTokens: 2, actualCostUsd: null } };
      },
    });
    const completionPlan = { ...plan, success: fixture.success };
    const update = await node(state({ browserDecision: decision({
      plan: completionPlan,
      observation: observation({ snapshot: fixture.snapshot }),
    }) }), { signal: controller.signal });

    expect((received?.state as Record<string, unknown>)["completionEvidence"]).toEqual([
      { ...fixture.success[0], matches: fixture.matches },
    ]);
    expect(update.browserDecision).toMatchObject({ phase: "handoff", reason: "jev_requested_genie", pending: null });
    expect(update.messages?.some((message) => AIMessage.isInstance(message) && message.tool_calls?.length)).toBe(false);
  });

  test("screens every oversized action and executes only the final nominated original call", async () => {
    const refs = Object.fromEntries(Array.from({ length: 86 }, (_, index) => [
      `e${index + 1}`,
      { role: index === 0 ? "textbox" : "generic", name: `Target ${index + 1}` },
    ]));
    const capacityPlan: BrowserDecisionPlan = {
      ...plan,
      actions: [{ kind: "click_observed" }],
      values: { first: "one", second: "two", third: "three", fourth: "four" },
    };
    const capacityObservation = observation({ refs });
    const requests: OpenRouterChoiceInput[] = [];
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async (input) => {
        requests.push(input);
        const ids = new Set(input.choices.map(({ id }) => id));
        const selectedId = ids.has("action_172") ? "action_172"
          : ids.has("action_344") ? "action_344"
          : (() => { throw new Error("unexpected tournament choices"); })();
        return {
          selectedId,
          requestedModelId: JEV_ID,
          resolvedModelId: "typesafe/jev-1.13",
          usage: { inputTokens: 10, outputTokens: 2, actualCostUsd: 0.0001 },
        };
      },
    });

    const update = await node(state({ browserDecision: decision({
      plan: capacityPlan,
      observation: capacityObservation,
    }) }), { signal: new AbortController().signal });
    expect(requests).toHaveLength(3);
    for (const value of Object.values(capacityPlan.values ?? {})) {
      expect(JSON.stringify(requests)).not.toContain(JSON.stringify(value));
    }
    expect(requests.slice(0, 2).map(({ choices }) => choices.length).sort((a, b) => a - b)).toEqual([177, 255]);
    expect(requests.slice(0, 2).every(({ choices }) => choices.at(-1)?.id === "none_in_group")).toBe(true);
    expect(new Set(requests.slice(0, 2).flatMap(({ choices }) => choices.slice(0, -1).map(({ id }) => id))).size).toBe(430);
    expect(requests[2]?.choices.map(({ id }) => id)).toEqual([
      "action_172", "action_344", "reobserve", "completion_ready", "needs_input", "needs_visual_evidence", "defer_to_genie",
    ]);
    expect(update.browserDecision).toMatchObject({ phase: "waiting" });
    expect(proposedToolCall(update)).toMatchObject({
      name: "browser_type",
      args: { ref: "@e1", text: "two", clear: true },
    });
    expect(update.messages?.filter((message) => AIMessage.isInstance(message) && message.tool_calls?.length)).toHaveLength(1);
    const message = update.messages?.at(-1);
    expect(AIMessage.isInstance(message)).toBe(true);
    if (!AIMessage.isInstance(message)) throw new Error("expected one final browser proposal");
    const receipt = message.additional_kwargs["nautilo_browser_decision"] as Record<string, unknown>;
    expect(receipt).toMatchObject({
      selectedId: "action_172",
      choiceCalls: 3,
      screeningRounds: 1,
      usage: { inputTokens: 30, outputTokens: 6 },
    });
    expect((receipt["usage"] as Record<string, number>)["actualCostUsd"]).toBeCloseTo(0.0003);
  });

  test("a screening provider failure recovers without proposing any action", async () => {
    const refs = Object.fromEntries(Array.from({ length: 86 }, (_, index) => [
      `e${index + 1}`,
      { role: "generic", name: `Target ${index + 1}` },
    ]));
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async (input) => {
        if (input.choices.some(({ id }) => id === "action_0")) {
          throw new ChoiceRequestError("provider_error", 503, true);
        }
        return {
          selectedId: "none_in_group",
          requestedModelId: JEV_ID,
          resolvedModelId: "typesafe/jev-1.13",
          usage: { inputTokens: 1, outputTokens: 1, actualCostUsd: null },
        };
      },
    });
    const update = await node(state({ browserDecision: decision({
      plan: { ...plan, actions: [{ kind: "click_observed" }], values: {
        first: "one", second: "two", third: "three", fourth: "four",
      } },
      observation: observation({ refs }),
    }) }), { signal: new AbortController().signal });

    expect(update.browserDecision).toMatchObject({
      phase: "observe",
      reason: null,
      recovery: { consecutiveEvents: 1 },
    });
    expect(update.messages).toBeUndefined();
  });

  test("attributes Choice usage to the initiating user, room, agent, and turn without leaking scope", async () => {
    for (const [subagentDepth, callType] of [[0, "chat"], [1, "subagent"]] as const) {
      let captured = getUsageContext();
      const node = createBrowserDecisionNode({
        fullEncryptionOnlyForState: () => false,
        choose: async () => {
          await Promise.resolve();
          captured = getUsageContext();
          return {
            selectedId: "action_0",
            requestedModelId: JEV_ID,
            resolvedModelId: "typesafe/jev-1.13-20260917",
            usage: { inputTokens: 20, outputTokens: 2, actualCostUsd: null },
          };
        },
      });
      const turnId = `turn-usage-${subagentDepth}`;
      await node(state({
        turnId,
        userId: "user-usage",
        roomId: "room-usage",
        agentId: "agent-usage",
        subagentDepth,
        browserDecision: decision({ turnId }),
      }), { signal: new AbortController().signal });

      expect(captured).toEqual({
        callType,
        userId: "user-usage",
        roomId: "room-usage",
        metadata: { agentId: "agent-usage", turnId },
      });
      expect(getUsageContext()).toBeUndefined();
    }
  });

  test("successful reads automatically reach the next Choice as exact source evidence", async () => {
    const planned = call("research-plan", "browser_snapshot", { decisionPlan: plan });
    const read = call("read-product", "browser_read", { ref: "@e7" });
    const messages = [new AIMessage({ content: "", tool_calls: [planned] }),
      new AIMessage({ content: "", tool_calls: [read], additional_kwargs: { nautilo_browser_decision: {
        operation: "choice", action: JSON.stringify({ kind: "read", name: "Product evidence", targetRef: "@e7" }),
      } } }), successfulResult(read, "Price EUR 87.65; rating 4.3 from 210 ratings.")];
    const node = createBrowserDecisionNode({ fullEncryptionOnlyForState: () => false,
      choose: async (input) => {
        expect(input.state).toMatchObject({ recentActions: [{ status: "success", evidence: "Price EUR 87.65; rating 4.3 from 210 ratings." }] });
        return { selectedId: "completion_ready", requestedModelId: JEV_ID, resolvedModelId: JEV_ID,
          usage: { inputTokens: 1, outputTokens: 1, actualCostUsd: 0 } };
      },
    });
    const update = await node(state({ messages }), { signal: new AbortController().signal });
    expect(update.browserDecision).toMatchObject({ phase: "handoff", reason: "completion_ready" });
  });

  test("cycles click to newly discovered typing target without a generative-model step", async () => {
    const controller = new AbortController();
    let choiceCalls = 0;
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async () => {
        const selectedId = choiceCalls++ === 0 ? "action_0" : "action_1";
        return {
          selectedId,
          requestedModelId: JEV_ID,
          resolvedModelId: "typesafe/jev-1.13-20260917",
          usage: { inputTokens: 50, outputTokens: 3, actualCostUsd: null },
        };
      },
    });

    const initial = state({ browserDecision: decision({ plan: browserDecisionPlanSchema.parse({
      goal: "Search the catalogue", values: { "search query": "blue mug" }, allowedOrigins: ["https://shop.example"],
    }) }) });
    const firstUpdate = await node(initial, { signal: controller.signal });
    const firstCall = proposedToolCall(firstUpdate);
    if (!firstUpdate.browserDecision) throw new Error("expected a pending browser decision");
    expect(firstCall.name).toBe("browser_click");
    expect(choiceCalls).toBe(1);

    const afterClick = settleBrowserDecision(
      state({ browserDecision: firstUpdate.browserDecision }), [firstCall],
      [successfulResult(firstCall, "{}")], [], JEV_ID,
    );
    expect(afterClick).toMatchObject({ phase: "observe" });
    if (!afterClick) throw new Error("expected browser observation phase");

    const observeUpdate = await node(
      state({ browserDecision: afterClick }), { signal: controller.signal },
    );
    const snapshotCall = proposedToolCall(observeUpdate);
    if (!observeUpdate.browserDecision) throw new Error("expected a pending browser snapshot");
    expect(snapshotCall).toMatchObject({ name: "browser_snapshot", args: {} });
    expect(choiceCalls).toBe(1);
    expect(Object.hasOwn(observeUpdate, "approvedToolCalls")).toBe(false);

    const fresh = observation({ observationId: "observation-2", refs: { e17: { role: "searchbox", name: "Catalogue keywords" } } });
    const afterSnapshot = settleBrowserDecision(
      state({ browserDecision: observeUpdate.browserDecision }), [snapshotCall],
      [successfulResult(snapshotCall, JSON.stringify(fresh))], [], JEV_ID,
    );
    expect(afterSnapshot).toMatchObject({ phase: "decide", observation: fresh });

    const secondUpdate = await node(
      state({ browserDecision: afterSnapshot }), { signal: controller.signal },
    );
    expect(proposedToolCall(secondUpdate)).toMatchObject({
      name: "browser_type",
      args: { ref: "@e17", text: "blue mug", clear: true },
    });
    expect(choiceCalls).toBe(2);
  });

  test("carries only confirmed semantic actions from the current decision episode into the next Choice", async () => {
    const controller = new AbortController();
    const choiceInputs: OpenRouterChoiceInput[] = [];
    let choiceCalls = 0;
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async (input) => {
        choiceInputs.push(input);
        return {
          selectedId: choiceCalls++ === 0 ? "action_1" : "action_0",
          requestedModelId: JEV_ID,
          resolvedModelId: "typesafe/jev-1.13-20260917",
          usage: { inputTokens: 20, outputTokens: 2, actualCostUsd: null },
        };
      },
    });
    const priorCall = call("prior-action", "browser_click", { ref: "@e9" });
    const priorReceipt = new AIMessage({
      content: "",
      tool_calls: [priorCall],
      additional_kwargs: { nautilo_browser_decision: {
        operation: "choice",
        action: "prior episode action must be excluded",
      } },
    });
    const plannedSnapshot = call("planned-snapshot", "browser_snapshot", { ...plan });
    const planReceipt = new AIMessage({ content: "", tool_calls: [plannedSnapshot] });
    const initialMessages = [priorReceipt, successfulResult(priorCall, "{}"), planReceipt];

    const firstUpdate = await node(
      state({ messages: initialMessages }),
      { signal: controller.signal },
    );
    const firstCall = proposedToolCall(firstUpdate);
    expect(firstCall).toMatchObject({ name: "browser_type", args: { ref: "@e2", text: "blue mug", clear: true } });
    const firstReceipt = firstUpdate.messages?.at(-1);
    expect(AIMessage.isInstance(firstReceipt)).toBe(true);
    const firstAction = AIMessage.isInstance(firstReceipt)
      ? firstReceipt.additional_kwargs["nautilo_browser_decision"] as Record<string, unknown>
      : null;
    expect(firstAction?.["action"]).toBe(TYPE_DESCRIPTION);
    expect(JSON.stringify(firstAction)).toContain("blue mug");
    if (!firstUpdate.browserDecision) throw new Error("expected a pending first action");

    const wrongNameResult = new ToolMessage({
      name: "browser_click",
      tool_call_id: firstCall.id,
      content: "",
      additional_kwargs: { nautilo_tool_status: "error" },
    });
    const confirmedFirstResult = successfulResult(firstCall, "{}");
    const afterFirstAction = settleBrowserDecision(
      state({ browserDecision: firstUpdate.browserDecision }),
      [firstCall], [confirmedFirstResult], [], JEV_ID,
    );
    if (!afterFirstAction) throw new Error("expected observation phase after confirmed action");
    const observeUpdate = await node(state({
      browserDecision: afterFirstAction,
      messages: [...(firstUpdate.messages ?? []), wrongNameResult, confirmedFirstResult],
    }), { signal: controller.signal });
    const snapshotCall = proposedToolCall(observeUpdate);
    if (!observeUpdate.browserDecision) throw new Error("expected a pending snapshot");
    const snapshotResult = successfulResult(snapshotCall, JSON.stringify(observation({ observationId: "observation-2" })));
    const afterSnapshot = settleBrowserDecision(
      state({ browserDecision: observeUpdate.browserDecision }),
      [snapshotCall], [snapshotResult], [], JEV_ID,
    );
    if (!afterSnapshot) throw new Error("expected a fresh decision observation");

    const unconfirmedCall = call("unconfirmed-action", "browser_click", { ref: "@e8" });
    const unconfirmedReceipt = new AIMessage({
      content: "",
      tool_calls: [unconfirmedCall],
      additional_kwargs: { nautilo_browser_decision: {
        operation: "choice",
        action: "unconfirmed action must be excluded",
      } },
    });
    await node(state({
      browserDecision: afterSnapshot,
      messages: [...(observeUpdate.messages ?? []), snapshotResult, unconfirmedReceipt],
    }), { signal: controller.signal });

    expect(choiceInputs).toHaveLength(2);
    const secondState = choiceInputs[1]?.state as Record<string, unknown>;
    expect(secondState["recentActions"]).toEqual([{ action: TYPE_DESCRIPTION, status: "success" }]);
    const serializedSecondChoice = JSON.stringify(choiceInputs[1]);
    expect(serializedSecondChoice).toContain("blue mug");
    expect(serializedSecondChoice).not.toContain("prior episode action");
    expect(serializedSecondChoice).not.toContain("unconfirmed action");

    const noBoundaryCall = call("no-boundary-action", "browser_click", { ref: "@e7" });
    const noBoundaryReceipt = new AIMessage({
      content: "",
      tool_calls: [noBoundaryCall],
      additional_kwargs: { nautilo_browser_decision: {
        operation: "choice",
        action: "history without a visible plan boundary must be excluded",
      } },
    });
    await node(state({ messages: [noBoundaryReceipt, successfulResult(noBoundaryCall, "{}")] }), { signal: controller.signal });
    expect(choiceInputs).toHaveLength(3);
    const noBoundaryState = choiceInputs[2]?.state as Record<string, unknown>;
    expect(noBoundaryState).not.toHaveProperty("recentActions");

    const pendingCall = call("pending-action", "browser_click", { ref: "@e6" });
    const pendingReceipt = new AIMessage({
      content: "",
      tool_calls: [pendingCall],
      additional_kwargs: { nautilo_browser_decision: {
        operation: "choice",
        action: "matched nonterminal status has no status field",
      } },
    });
    const pendingResult = new ToolMessage({
      name: pendingCall.name,
      tool_call_id: pendingCall.id,
      content: "",
      additional_kwargs: { nautilo_tool_status: "pending" },
    });
    await node(state({ messages: [planReceipt, pendingReceipt, pendingResult] }), { signal: controller.signal });
    expect(choiceInputs).toHaveLength(4);
    const pendingState = choiceInputs[3]?.state as Record<string, unknown>;
    expect(pendingState["recentActions"]).toEqual([
      { action: "matched nonterminal status has no status field" },
    ]);
  });

  test("marks a stale type as never executed and can propose its exact value at the fresh ref", async () => {
    const controller = new AbortController();
    const choiceInputs: OpenRouterChoiceInput[] = [];
    let choiceCalls = 0;
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async (input) => {
        choiceInputs.push(input);
        return {
          selectedId: choiceCalls++ === 0 ? "action_1" : "action_0",
          requestedModelId: JEV_ID,
          resolvedModelId: "typesafe/jev-1.13-20260917",
          usage: { inputTokens: 20, outputTokens: 2, actualCostUsd: null },
        };
      },
    });
    const plannedSnapshot = call("planned-stale-snapshot", "browser_snapshot", { decisionPlan: plan });
    const planReceipt = new AIMessage({ content: "", tool_calls: [plannedSnapshot] });

    const firstUpdate = await node(state({ messages: [planReceipt] }), { signal: controller.signal });
    const staleCall = proposedToolCall(firstUpdate);
    expect(staleCall).toMatchObject({
      name: "browser_type",
      args: { ref: "@e2", text: "blue mug", clear: true },
    });
    if (!firstUpdate.browserDecision) throw new Error("expected a pending stale action");
    const staleResult = failedResult(staleCall, "browser_observation_stale");
    staleResult.content = JSON.stringify({ error: "The dialog changed before input; fresh observation required", browserRequestSent: false });
    const afterStale = settleBrowserDecision(
      state({ browserDecision: firstUpdate.browserDecision }),
      [staleCall], [staleResult], [], JEV_ID,
    );
    expect(afterStale).toMatchObject({ phase: "observe", recovery: { consecutiveEvents: 1 } });
    if (!afterStale) throw new Error("expected stale recovery");

    const observeUpdate = await node(state({
      browserDecision: afterStale,
      messages: [...(firstUpdate.messages ?? []), staleResult],
    }), { signal: controller.signal });
    const snapshotCall = proposedToolCall(observeUpdate);
    expect(snapshotCall).toMatchObject({ name: "browser_snapshot", args: {} });
    if (!observeUpdate.browserDecision) throw new Error("expected a pending recovery snapshot");
    const fresh = observation({
      observationId: "observation-shifted",
      refs: { e17: { role: "textbox", name: "Search" } },
    });
    const snapshotResult = successfulResult(snapshotCall, JSON.stringify(fresh));
    const afterSnapshot = settleBrowserDecision(
      state({ browserDecision: observeUpdate.browserDecision }),
      [snapshotCall], [snapshotResult], [], JEV_ID,
    );
    expect(afterSnapshot).toMatchObject({ phase: "decide", observation: fresh });

    const retryUpdate = await node(state({
      browserDecision: afterSnapshot,
      messages: [...(observeUpdate.messages ?? []), snapshotResult],
    }), { signal: controller.signal });
    expect(choiceInputs).toHaveLength(2);
    expect((choiceInputs[1]?.state as Record<string, unknown>)["recentActions"]).toEqual([
      { action: TYPE_DESCRIPTION, status: "not_executed_stale", evidence: staleResult.content },
    ]);
    expect(proposedToolCall(retryUpdate)).toMatchObject({
      name: "browser_type",
      args: { ref: "@e17", text: "blue mug", clear: true },
    });
  });

  test("privacy-policy absence, full-encryption policy, and cancellation make zero Choice calls", async () => {
    const cases: Array<{
      node: ReturnType<typeof createBrowserDecisionNode>;
      signal: AbortSignal;
      reason: string;
    }> = [];
    let choiceCalls = 0;
    const choose = async () => {
      choiceCalls += 1;
      throw new Error("must not call Choice");
    };
    cases.push({
      node: createBrowserDecisionNode({ choose }),
      signal: new AbortController().signal,
      reason: "decision_provider_egress_unavailable",
    });
    cases.push({
      node: createBrowserDecisionNode({ fullEncryptionOnlyForState: () => true, choose }),
      signal: new AbortController().signal,
      reason: "decision_provider_egress_unavailable",
    });
    const aborted = new AbortController();
    aborted.abort();
    cases.push({
      node: createBrowserDecisionNode({ fullEncryptionOnlyForState: () => false, choose }),
      signal: aborted.signal,
      reason: "run_signal_unavailable_or_cancelled",
    });

    for (const fixture of cases) {
      expect(await fixture.node(state(), { signal: fixture.signal })).toMatchObject({
        browserDecision: { phase: "handoff", reason: fixture.reason },
      });
    }
    expect(choiceCalls).toBe(0);
  });

  test("recoverable Choice failures refresh observation without retrying the provider inline", async () => {
    let choiceCalls = 0;
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async () => {
        choiceCalls += 1;
        throw new ChoiceRequestError("network_error", null, true);
      },
    });
    const signal = new AbortController().signal;

    const recovered = await node(state(), { signal });
    expect(recovered.browserDecision).toMatchObject({
      phase: "observe",
      recovery: { consecutiveEvents: 1, assessNextObservation: false },
    });
    expect(choiceCalls).toBe(1);
    expect(recovered.messages).toBeUndefined();

    const refresh = await node(state({ browserDecision: recovered.browserDecision ?? null }), { signal });
    expect(proposedToolCall(refresh)).toMatchObject({ name: "browser_snapshot", args: {} });
    expect(choiceCalls).toBe(1);
  });

  test("two Choice failures separated by a fresh observation reach intervention", async () => {
    let choiceCalls = 0;
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async () => {
        choiceCalls += 1;
        throw new ChoiceRequestError("network_error", null, true);
      },
    });
    const signal = new AbortController().signal;

    const firstFailure = await node(state(), { signal });
    expect(firstFailure.browserDecision).toMatchObject({
      phase: "observe",
      recovery: { consecutiveEvents: 1, interventionAt: 2 },
    });

    const reobserve = await node(
      state({ browserDecision: firstFailure.browserDecision ?? null }), { signal },
    );
    const snapshot = proposedToolCall(reobserve);
    expect(snapshot).toMatchObject({ name: "browser_snapshot", args: {} });
    if (!reobserve.browserDecision) throw new Error("expected a fresh-observation proposal");

    const fresh = settleBrowserDecision(
      state({ browserDecision: reobserve.browserDecision }), [snapshot],
      [successfulResult(snapshot, JSON.stringify(observation({ observationId: "observation-2" })))],
      [], JEV_ID,
    );
    expect(fresh).toMatchObject({
      phase: "decide",
      recovery: { consecutiveEvents: 1, assessNextObservation: false },
    });

    const secondFailure = await node(state({ browserDecision: fresh }), { signal });
    expect(secondFailure.browserDecision).toMatchObject({
      phase: "handoff",
      recovery: { consecutiveEvents: 2, interventionAt: 2 },
    });
    expect(secondFailure.browserDecision?.reason).toBe(
      "browser_decision_intervention_required cause=choice_network_error count=2 limit=2",
    );
    expect(choiceCalls).toBe(2);
  });

  test("verified progress after a restarted episode resets count and threshold", async () => {
    const handedOff = decision({
      phase: "handoff",
      reason: "browser_decision_intervention_required cause=no_verified_progress count=2 limit=2",
      recovery: { ...decision().recovery!, consecutiveEvents: 2 },
    });
    const revisedPlan: BrowserDecisionPlan = {
      ...plan,
      goal: "Continue from revised evidence until details load",
      progress: [...plan.progress, { kind: "snapshot_contains", text: "Details loaded" }],
    };
    const restartSnapshot = call("snapshot-restarted-episode", "browser_snapshot", {
      decisionPlan: revisedPlan,
    });
    const restarted = settleBrowserDecision(
      state({
        browserDecision: handedOff,
        messages: [new AIMessage({ content: "", tool_calls: [restartSnapshot] })],
      }),
      [restartSnapshot],
      [successfulResult(restartSnapshot, JSON.stringify(observation({
        snapshot: "Results changed materially",
        observationId: "observation-restart",
      })))],
      [], JEV_ID,
    );
    expect(restarted).toMatchObject({
      phase: "decide",
      recovery: { consecutiveEvents: 2, interventionAt: 4 },
    });

    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async () => ({
        selectedId: "action_0",
        requestedModelId: JEV_ID,
        resolvedModelId: "typesafe/jev-1.13-20260917",
        usage: { inputTokens: 20, outputTokens: 2, actualCostUsd: null },
      }),
    });
    const signal = new AbortController().signal;
    const actionUpdate = await node(state({ browserDecision: restarted }), { signal });
    const action = proposedToolCall(actionUpdate);
    if (!actionUpdate.browserDecision) throw new Error("expected a restarted action proposal");

    const afterAction = settleBrowserDecision(
      state({ browserDecision: actionUpdate.browserDecision }), [action],
      [successfulResult(action, "{}")], [], JEV_ID,
    );
    expect(afterAction).toMatchObject({
      phase: "observe",
      recovery: { consecutiveEvents: 2, interventionAt: 4, assessNextObservation: true },
    });

    const observeUpdate = await node(state({ browserDecision: afterAction }), { signal });
    const progressSnapshot = proposedToolCall(observeUpdate);
    if (!observeUpdate.browserDecision) throw new Error("expected post-action observation");
    const progressed = settleBrowserDecision(
      state({ browserDecision: observeUpdate.browserDecision }), [progressSnapshot],
      [successfulResult(progressSnapshot, JSON.stringify(observation({
        snapshot: "Results changed materially\nDetails loaded",
        observationId: "observation-progress",
      })))],
      [], JEV_ID,
    );

    expect(progressed).toMatchObject({
      phase: "decide",
      recovery: {
        consecutiveEvents: 0,
        interventionAt: 2,
        assessNextObservation: false,
      },
    });
  });

  test("invalid responses and retryable provider failures recover; non-retryable failures hand off", async () => {
    for (const error of [
      new ChoiceRequestError("invalid_response"),
      new ChoiceRequestError("provider_error", 503, true),
    ]) {
      const node = createBrowserDecisionNode({
        fullEncryptionOnlyForState: () => false,
        choose: async () => { throw error; },
      });
      expect(await node(state(), { signal: new AbortController().signal })).toMatchObject({
        browserDecision: { phase: "observe", recovery: { consecutiveEvents: 1 } },
      });
    }

    const denied = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async () => { throw new ChoiceRequestError("provider_error", 400, false); },
    });
    expect(await denied(state(), { signal: new AbortController().signal })).toMatchObject({
      browserDecision: { phase: "handoff", reason: "choice_provider_error http_status=400" },
    });
  });

  test("an explicit Jev reobserve assesses the next snapshot for progress", async () => {
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async () => ({
        selectedId: "reobserve",
        requestedModelId: JEV_ID,
        resolvedModelId: "typesafe/jev-1.13-20260917",
        usage: { inputTokens: 20, outputTokens: 2, actualCostUsd: null },
      }),
    });
    const update = await node(state(), { signal: new AbortController().signal });
    const snapshot = proposedToolCall(update);
    expect(update.browserDecision).toMatchObject({
      phase: "waiting",
      recovery: { assessNextObservation: true, consecutiveEvents: 0 },
    });
    if (!update.browserDecision) throw new Error("expected reobserve proposal");

    expect(settleBrowserDecision(
      state({ browserDecision: update.browserDecision }), [snapshot],
      [successfulResult(snapshot, JSON.stringify(observation({ observationId: "observation-2" })))],
      [], JEV_ID,
    )).toMatchObject({
      phase: "decide",
      recovery: { assessNextObservation: false, consecutiveEvents: 1 },
    });
  });

  test("approval denial hands off without a Choice or browser proposal", async () => {
    let choiceCalls = 0;
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async () => {
        choiceCalls += 1;
        throw new Error("must not call Choice");
      },
    });
    const update = await node(
      state({ approvalDenied: true }), { signal: new AbortController().signal },
    );
    expect(update.browserDecision).toMatchObject({
      phase: "handoff",
      reason: "existing_run_intervention",
      recovery: { consecutiveEvents: 0 },
    });
    expect(choiceCalls).toBe(0);
    expect(update.messages?.some((message) =>
      AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) > 0)).toBe(false);
  });

  test("an out-of-set choice recovers while an explicit defer returns control", async () => {
    for (const selectedId of ["not-in-the-set", "defer_to_genie"]) {
      const node = createBrowserDecisionNode({
        fullEncryptionOnlyForState: () => false,
        choose: async () => ({
          selectedId,
          requestedModelId: JEV_ID,
          resolvedModelId: "typesafe/jev-1.13-20260917",
          usage: { inputTokens: 20, outputTokens: 2, actualCostUsd: null },
        }),
      });
      const update = await node(state(), { signal: new AbortController().signal });
      expect(update.browserDecision).toMatchObject({
        phase: selectedId === "defer_to_genie" ? "handoff" : "observe",
        reason: selectedId === "defer_to_genie" ? "jev_requested_genie" : null,
        pending: null,
        recovery: {
          consecutiveEvents: selectedId === "defer_to_genie" ? 0 : 1,
        },
      });
      expect(update.messages?.some((message) =>
        AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) > 0) ?? false).toBe(false);
    }
  });

  test("live credential revocation invalidates the episode before Choice", async () => {
    let choiceCalls = 0;
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async () => {
        choiceCalls += 1;
        throw new Error("must not call Choice");
      },
    });
    const signal = new AbortController().signal;

    delete process.env["OPENROUTER_API_KEY"];
    const unavailable = await node(state(), { signal });
    expect(unavailable).toMatchObject({
      browserDecision: { phase: "handoff", reason: "decision_model_unavailable" },
    });
    const unavailableHandoff = unavailable.messages?.at(-1);
    expect(SystemMessage.isInstance(unavailableHandoff)).toBe(true);
    if (!SystemMessage.isInstance(unavailableHandoff) || typeof unavailableHandoff.content !== "string") {
      throw new Error("expected text supervisor handoff");
    }
    expect(unavailableHandoff.content).toContain("decision_model_unavailable");
    expect(unavailableHandoff.content).toContain("verify outcomes");
    expect(unavailable.messages?.some((message) =>
      AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) > 0)).toBe(false);
    expect(choiceCalls).toBe(0);
  });
});
