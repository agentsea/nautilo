import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { processHistory } from "../../src/utils/history-manager";
import { projectBrowserHistory, readBrowserHistory } from "../../src/tools/browser/browser-history";
import { projectOpenAIMultimodalToolResults } from "../../src/nodes/pre-model";
import { isImageContentBlock } from "../../src/utils/message-modalities";

function observation(session: string, ordinal: number, snapshot = `snapshot-${ordinal}`) {
  return JSON.stringify({
    version: 1,
    snapshot,
    refs: { e1: { role: "button", name: `Action ${ordinal}` } },
    pageUrl: `https://example.test/page/${ordinal}`,
    browserSessionId: session,
    observationId: `observation-${session}-${ordinal}`,
  });
}

function snapshot(callId: string, session: string, ordinal: number, content = observation(session, ordinal)) {
  return new ToolMessage({
    id: `message-${callId}`,
    name: "browser_snapshot",
    tool_call_id: callId,
    content,
    status: "success",
    additional_kwargs: { nautilo_tool_status: "success", authority: "retained" },
    response_metadata: { source: "relay" },
  });
}

function compacted(message: BaseMessage): Record<string, unknown> | null {
  if (!ToolMessage.isInstance(message) || typeof message.content !== "string") return null;
  try {
    const parsed = JSON.parse(message.content) as Record<string, unknown>;
    return parsed["notice"] ? parsed : null;
  } catch { return null; }
}

describe("browser history provider projection", () => {
  test("sends only the latest browser screenshot image to Genie while retaining canonical results", () => {
    const screenshot = (id: string) => new ToolMessage({
      name: "browser_screenshot", tool_call_id: id, status: "success",
      content: [
        { type: "text", text: `Visual state for ${id}: ${"tile ".repeat(1_000)}` },
        { type: "image_url", image_url: { url: `data:image/png;base64,${id}` } },
      ],
    });
    const first = screenshot("first");
    const second = screenshot("second");
    const latest = screenshot("latest");
    const call = (id: string) => new AIMessage({
      content: "", tool_calls: [{ id, name: "browser_screenshot", args: {} }],
    });
    const messages = [new HumanMessage("Play the board"), call("first"), first,
      call("second"), second, call("latest"), latest];

    const processed = processHistory(messages, {
      validationEnabled: true, pruningEnabled: true, tokenBudgetFraction: 0.9,
      windowKeepRecent: 100, modelId: "openai:gpt-5.6-sol",
    });
    const providerMessages = projectOpenAIMultimodalToolResults(processed.messages, "openai:gpt-5.6-sol");
    const images = providerMessages.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter(isImageContentBlock) : []);
    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,latest" } });
    expect((processed.messages[2] as ToolMessage).content).toContain("screenshotOmitted");
    expect((processed.messages[4] as ToolMessage).content).toContain("screenshotOmitted");
    expect(JSON.stringify(providerMessages)).not.toContain("Visual state for first");
    expect(JSON.stringify(providerMessages)).not.toContain("Visual state for second");
    expect(processed.canonicalMessages?.[2]).toBe(first);
    expect(processed.canonicalMessages?.[4]).toBe(second);
    expect(processed.canonicalMessages?.[6]).toBe(latest);
    expect(first.content).toEqual(screenshot("first").content);
  });

  test("keeps only the final image block when a screenshot contains several", () => {
    const result = new ToolMessage({ name: "browser_screenshot", tool_call_id: "multi", status: "success",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,older" } },
        { type: "text", text: "Current state" },
        { type: "image_url", image_url: { url: "data:image/png;base64,newer" } }] });
    const projected = projectBrowserHistory([result]);
    expect((projected.messages[0] as ToolMessage).content).toEqual([
      { type: "text", text: "Current state" },
      { type: "image_url", image_url: { url: "data:image/png;base64,newer" } },
    ]);
    expect(projected.originals.get("multi")).toBe(result);
  });

  test("does not present an older ordinary image after a newer delegated screenshot observation", () => {
    const ordinary = new ToolMessage({
      name: "browser_screenshot", tool_call_id: "ordinary", status: "success",
      content: [
        { type: "text", text: "Older ordinary screenshot" },
        { type: "image_url", image_url: { url: "data:image/png;base64,stale-before-delegation" } },
      ],
    });
    const delegated = new ToolMessage({
      name: "browser_screenshot", tool_call_id: "delegated", status: "success",
      content: observation("session", 2),
    });
    const messages = [
      new AIMessage({ content: "", tool_calls: [{ id: "ordinary", name: "browser_screenshot", args: {} }] }),
      ordinary,
      new AIMessage({ content: "", tool_calls: [{ id: "delegated", name: "browser_screenshot",
        args: { decisionPlan: { goal: "Choose the requested item" } } }] }),
      delegated,
    ];

    const projected = projectBrowserHistory(messages).messages;
    expect(JSON.stringify(projected)).not.toContain("data:image/png;base64,stale-before-delegation");
    expect((projected[1] as ToolMessage).content).toContain("screenshotOmitted");
    expect((projected[3] as ToolMessage).content).toContain("delegatedObservationOmitted");
    expect(JSON.stringify(projected)).not.toContain("snapshot-2");
    expect(readBrowserHistory(messages, "delegated")).toBeNull();
  });

  test.each(["browser_screenshot", "browser_snapshot"])(
    "omits %s observations captured inside Jev while preserving ordinary captures and action receipts", (toolName) => {
      const begin = new AIMessage({ content: "", tool_calls: [{ id: "delegation", name: toolName,
        args: { decisionPlan: { goal: "Complete the routine browser task" } } }] });
      const first = new ToolMessage({ name: toolName, tool_call_id: "delegation", status: "success",
        content: observation("session", 1, "first-internal-state".repeat(1_000)) });
      const chosenAction = new AIMessage({ content: "", tool_calls: [{ id: "browser-choice:action", name: "browser_press", args: { key: "Right" } }],
        additional_kwargs: { nautilo_browser_decision: { operation: "choice" } } });
      const actionReceipt = new ToolMessage({ name: "browser_press", tool_call_id: "browser-choice:action", status: "success", content: "pressed" });
      const chosenObservation = new AIMessage({ content: "", tool_calls: [{ id: "browser-choice:observe", name: toolName, args: {} }],
        additional_kwargs: { nautilo_browser_decision: { operation: "reobserve" } } });
      const second = new ToolMessage({ name: toolName, tool_call_id: "browser-choice:observe", status: "success",
        content: observation("session", 2, "second-internal-state".repeat(1_000)) });
      const outside = new AIMessage({ content: "", tool_calls: [{ id: "outside", name: toolName, args: {} }] });
      const ordinary = new ToolMessage({ name: toolName, tool_call_id: "outside", status: "success",
        content: observation("session", 3, "ordinary-verification-state") });
      const messages = [new HumanMessage("Do the task"), begin, first, chosenAction, actionReceipt,
        chosenObservation, second, outside, ordinary];

      const processed = processHistory(messages, {
        validationEnabled: true, pruningEnabled: true, tokenBudgetFraction: 0.9,
        windowKeepRecent: 100, modelId: "openai:gpt-5.6-sol",
      });
      const providerText = JSON.stringify(processed.messages);
      expect(providerText).not.toContain("first-internal-state");
      expect(providerText).not.toContain("second-internal-state");
      expect(providerText).toContain("ordinary-verification-state");
      expect((processed.messages[2] as ToolMessage).content).toContain("delegatedObservationOmitted");
      expect((processed.messages[6] as ToolMessage).content).toContain("delegatedObservationOmitted");
      expect(processed.messages[4]).toBe(actionReceipt);
      expect(processed.canonicalMessages?.[2]).toBe(first);
      expect(processed.canonicalMessages?.[6]).toBe(second);
      expect(readBrowserHistory(messages, "delegation")).toBeNull();
      expect(readBrowserHistory(messages, "browser-choice:observe")).toBeNull();
      if (toolName === "browser_snapshot") expect(readBrowserHistory(messages, "outside")).not.toBeNull();
    },
  );

  test("removes only an internal connected-browser observation while retaining its execution receipt and errors", () => {
    const internalCall = new AIMessage({ content: "", tool_calls: [{ id: "browser-choice:connected",
      name: "control_connected_web_operation", args: { command: { kind: "snapshot" } } }],
      additional_kwargs: { nautilo_browser_decision: { operation: "reobserve" } } });
    const internal = new ToolMessage({ name: "control_connected_web_operation",
      tool_call_id: "browser-choice:connected", status: "success",
      content: JSON.stringify({ ok: true, execution: "executed", observation: JSON.parse(observation("connected", 1, "internal-connected-state")) as unknown }) });
    const error = new ToolMessage({ name: "browser_snapshot", tool_call_id: "browser-choice:error", status: "error",
      content: "Browser disconnected before capture" });
    const projected = projectBrowserHistory([internalCall, internal, error]);
    expect(JSON.stringify(projected.messages)).not.toContain("internal-connected-state");
    expect(JSON.parse((projected.messages[1] as ToolMessage).content as string)).toMatchObject({
      ok: true, execution: "executed", delegatedObservationOmitted: true,
    });
    expect(projected.messages[2]).toBe(error);
    expect(projected.originals.get("browser-choice:connected")).toBe(internal);
  });

  test("a long delegated visual loop does not grow Genie's provider history with its captures", () => {
    const messages: BaseMessage[] = [new HumanMessage("Complete the routine task")];
    for (let index = 0; index < 60; index++) {
      const id = `browser-choice:observation-${index}`;
      messages.push(new AIMessage({ content: "", tool_calls: [{ id, name: "browser_screenshot", args: {} }],
        additional_kwargs: { nautilo_browser_decision: { operation: "reobserve" } } }));
      messages.push(new ToolMessage({ name: "browser_screenshot", tool_call_id: id, status: "success",
        content: observation("long-loop", index, `internal-visual-state-${index} `.repeat(1_500)) }));
    }
    const outside = snapshot("ordinary-verification", "long-loop", 60);
    messages.push(new AIMessage({ content: "", tool_calls: [{ id: "ordinary-verification", name: "browser_snapshot", args: {} }] }), outside);
    const processed = processHistory(messages, {
      validationEnabled: true, pruningEnabled: true, tokenBudgetFraction: 0.9,
      windowKeepRecent: 100, modelId: "openai:gpt-5.6-sol",
    });
    const providerText = JSON.stringify(processed.messages);
    expect(providerText.length).toBeLessThan(JSON.stringify(messages).length / 10);
    expect(providerText).not.toContain("internal-visual-state-");
    expect(providerText).toContain("snapshot-60");
    expect(processed.canonicalMessages?.at(-3)?.content).toContain("internal-visual-state-59");
    expect(processed.canonicalMessages?.at(-1)).toBe(outside);
  });

  test("a trusted in-loop marker hides the observation even when its proposing call is outside the window", () => {
    const internal = new ToolMessage({ name: "browser_snapshot", tool_call_id: "initial-delegation",
      content: observation("session", 1, "marked-internal-state"), status: "success",
      additional_kwargs: { nautilo_browser_decision_observation: true } });
    const projected = projectBrowserHistory([internal]);
    expect((projected.messages[0] as ToolMessage).content).toContain("delegatedObservationOmitted");
    expect(JSON.stringify(projected.messages)).not.toContain("marked-internal-state");
    expect(projected.originals.get("initial-delegation")).toBe(internal);
  });

  test("retains baseline/current per session and compacts older snapshots deterministically", () => {
    const oldA = snapshot("a-1", "session-a", 1, observation("session-a", 1, "x".repeat(10_000)));
    const baselineA = snapshot("a-2", "session-a", 2);
    const currentA = snapshot("a-3", "session-a", 3);
    const oldB = snapshot("b-1", "session-b", 1);
    const baselineB = snapshot("b-2", "session-b", 2);
    const currentB = snapshot("b-3", "session-b", 3);
    const messages = [oldA, baselineA, currentA, oldB, baselineB, currentB];

    const first = projectBrowserHistory(messages);
    const second = projectBrowserHistory(messages);
    expect(compacted(first.messages[0]!)).toMatchObject({
      historical: true, sourceToolCallId: "a-1", browserSessionId: "session-a",
    });
    expect(compacted(first.messages[3]!)).toMatchObject({
      historical: true, sourceToolCallId: "b-1", browserSessionId: "session-b",
    });
    expect(first.messages.slice(1, 3)).toEqual([baselineA, currentA]);
    expect(first.messages.slice(4, 6)).toEqual([baselineB, currentB]);
    expect((first.messages[0] as ToolMessage).content).toBe((second.messages[0] as ToolMessage).content);
    expect(first.originals.get("a-1")).toBe(oldA);
    expect(messages[0]).toBe(oldA);
  });

  test("leaves actions, errors, authority messages, duplicates and malformed snapshots unchanged", () => {
    const action = new ToolMessage({ name: "browser_click", tool_call_id: "click-1", content: "clicked", status: "success" });
    const error = new ToolMessage({ name: "browser_snapshot", tool_call_id: "error-1", content: observation("s", 1), status: "error" });
    const malformed = snapshot("malformed", "s", 2, "not-json");
    const duplicateA = snapshot("duplicate", "s", 3);
    const duplicateB = snapshot("duplicate", "s", 4);
    const authority = new SystemMessage("Browser authority changed; inspect before acting.");
    const messages = [action, error, malformed, duplicateA, duplicateB, authority];

    expect(projectBrowserHistory(messages).messages).toEqual(messages);
    expect(projectBrowserHistory(messages).originals.size).toBe(0);
  });

  test("processHistory budgets projected bytes but restores exact canonical snapshot objects", () => {
    const old = snapshot("old", "session", 1, observation("session", 1, "large".repeat(20_000)));
    const baseline = snapshot("baseline", "session", 2);
    const current = snapshot("current", "session", 3);
    const call = (id: string) => new AIMessage({
      content: "",
      tool_calls: [{ id, name: "browser_snapshot", args: {} }],
    });
    const messages = [
      new HumanMessage("browse"),
      call("old"), old,
      call("baseline"), baseline,
      call("current"), current,
    ];
    const processed = processHistory(messages, {
      validationEnabled: true,
      pruningEnabled: true,
      maxMessageTokens: 900_000,
    });

    expect(compacted(processed.messages[2]!)).toMatchObject({ sourceToolCallId: "old" });
    expect(processed.canonicalMessages?.[2]).toBe(old);
    expect(processed.canonicalMessages?.[4]).toBe(baseline);
    expect(processed.canonicalMessages?.[6]).toBe(current);
    expect(old.content).toContain("largelarge");
  });
});

describe("exact browser history retrieval", () => {
  test("reads one successful retained live snapshot from current messages only", () => {
    const source = snapshot("source", "session", 1);
    const result = readBrowserHistory([source], "source");
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toMatchObject({
      version: 1,
      historical: true,
      sourceToolCallId: "source",
      warning: expect.stringContaining("refs are stale") as unknown,
      observation: { browserSessionId: "session", observationId: "observation-session-1" },
    });
  });

  test("rejects unavailable, duplicate, error, malformed and recursive historical results", () => {
    const live = snapshot("source", "session", 1);
    const duplicate = snapshot("source", "session", 2);
    const error = new ToolMessage({ name: "browser_snapshot", tool_call_id: "error", content: observation("session", 3), status: "error" });
    const malformed = snapshot("malformed", "session", 4, "{}");
    const recursive = new ToolMessage({
      name: "browser_snapshot",
      tool_call_id: "history-result",
      content: readBrowserHistory([live], "source")!,
      status: "success",
    });

    expect(readBrowserHistory([live], "missing")).toBeNull();
    expect(readBrowserHistory([live, duplicate], "source")).toBeNull();
    expect(readBrowserHistory([error], "error")).toBeNull();
    expect(readBrowserHistory([malformed], "malformed")).toBeNull();
    expect(readBrowserHistory([recursive], "history-result")).toBeNull();
  });

  test("keeps an explicit retrieval until a newer live observation then compacts it", () => {
    const source = snapshot("source", "session", 1);
    const historyCall = new AIMessage({
      content: "",
      tool_calls: [{ id: "history-call", name: "browser_snapshot", args: { historyToolCallId: "source" } }],
    });
    const historyResult = new ToolMessage({
      name: "browser_snapshot",
      tool_call_id: "history-call",
      content: readBrowserHistory([source], "source")!,
      status: "success",
      additional_kwargs: { nautilo_tool_status: "success" },
    });

    const immediate = projectBrowserHistory([source, historyCall, historyResult]);
    expect(immediate.messages[2]).toBe(historyResult);

    const afterLive = projectBrowserHistory([
      source,
      historyCall,
      historyResult,
      snapshot("baseline", "session", 2),
      snapshot("current", "session", 3),
    ]);
    expect(compacted(afterLive.messages[2]!)).toMatchObject({
      historical: true,
      sourceToolCallId: "source",
    });
    expect(afterLive.originals.get("history-call")).toBe(historyResult);
  });
});

function readPage(callId: string, content: string) {
  return new ToolMessage({ name: "browser_read_page", tool_call_id: callId, status: "success",
    content: JSON.stringify({ finalUrl: `https://example.test/${callId}`, title: callId, content,
      blocks: [{ kind: "paragraph", text: content }], failure: "none", totalCharacters: content.length,
      remainingCharacters: 17, eof: false, truncated: true, diagnostics: ["partial"],
      continuation: { reference: "opaque", offsetCharacters: content.length } }) });
}

test("older page reads retain source and completeness metadata with exact conversation retrieval", () => {
  const old = readPage("first-product", "Exact price $123.45. ".repeat(500));
  const current = readPage("second-product", "Exact price $234.56.");
  const targeted = new ToolMessage({ name: "browser_read_page", tool_call_id: "find", status: "success",
    content: JSON.stringify({ operation: "find", matches: [{ text: "$123.45", offset: 12 }] }) });
  const failed = new ToolMessage({ name: "browser_read_page", tool_call_id: "failed", status: "success",
    content: JSON.stringify({ ...JSON.parse(old.content as string), failure: "evaluation-error" }) });
  const projected = projectBrowserHistory([old, targeted, failed, current]);
  expect(compacted(projected.messages[0]!)).toMatchObject({ finalUrl: "https://example.test/first-product",
    title: "first-product", remainingCharacters: 17, eof: false, truncated: true, diagnostics: ["partial"],
    retrieve: { tool: "browser_snapshot", args: { historyToolCallId: "first-product" } } });
  expect((projected.messages[0] as ToolMessage).content.length).toBeLessThan((old.content as string).length);
  expect(projected.messages.slice(1)).toEqual([targeted, failed, current]);
  expect(projected.originals.get("first-product")).toBe(old);
  expect((JSON.parse(readBrowserHistory([old, current], "first-product")!) as { result: unknown }).result).toEqual(JSON.parse(old.content as string));
  expect(readBrowserHistory([old, old], "first-product")).toBeNull();
});

test("navigation snapshots project stale refs without losing the exact execution receipt", () => {
  const navigation = { execution: "executed", result: "Opened requested URL" };
  const opened = new ToolMessage({ name: "browser_open", tool_call_id: "open", status: "success",
    content: JSON.stringify({ navigation, observation: JSON.parse(observation("session", 0)) as unknown }) });
  const messages = [opened, snapshot("baseline", "session", 1), snapshot("current", "session", 2)];
  expect(compacted(projectBrowserHistory(messages).messages[0]!)).toMatchObject({ navigation,
    retrieve: { tool: "browser_snapshot", args: { historyToolCallId: "open" } } });
  expect((JSON.parse(readBrowserHistory(messages, "open")!) as { observation: { observationId: string } }).observation.observationId).toBe("observation-session-0");
});
