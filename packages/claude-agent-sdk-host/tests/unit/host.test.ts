import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RelayClaudeFact } from "@nautilo/relay";
import { parseRelayClaudeExecutionCommand } from "@nautilo/relay";
import {
  ClaudeAgentSdkHost,
  CLAUDE_AGENT_SDK_COMPATIBLE_CLAUDE_CODE_VERSION,
  CLAUDE_AGENT_SDK_VERSION,
  REQUIRED_CLAUDE_RUNTIME_FEATURES,
  type ClaudeAgentSdk,
  type ClaudeExecutionObservation,
  type ClaudeInteraction,
  type ClaudeInteractionDecision,
} from "../../src/index";

const reviewedFeatures = Object.freeze({
  accountInfo: true,
  supportedModels: true,
  interrupt: true,
  modelRefusalFallback: false,
  modelRefusalNoFallback: false,
  servingModelIdentity: false,
  switchModelsOnFlag: true,
});

test("the reviewed runtime ledger mirrors the pinned official Agent SDK metadata", async () => {
  const sdkEntry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const metadata: unknown = await Bun.file(join(dirname(sdkEntry), "package.json")).json();
  expect(metadata).toMatchObject({
    version: CLAUDE_AGENT_SDK_VERSION,
    claudeCodeVersion: CLAUDE_AGENT_SDK_COMPATIBLE_CLAUDE_CODE_VERSION,
  });
  expect(REQUIRED_CLAUDE_RUNTIME_FEATURES).toEqual(["accountInfo", "supportedModels", "interrupt", "switchModelsOnFlag"]);
});

describe("Claude Agent SDK host execution adapter", () => {
  test("content whitespace does not relax identifiers or permit malformed content", async () => {
    let queries = 0;
    const host = createHost({ query: () => { queries += 1; return fakeQuery([]); } });
    for (const invalid of ["bad\u0000text", "bad\u001btext", "bad\u007ftext", "bad\ud800text"]) {
      const launch = await host.launch({ ...request(), prompt: invalid });
      expect(launch.available).toBe(false);
    }
    for (const key of ["model", "workingDirectory"] as const) {
      expect((await host.launch({ ...request(), [key]: "bad\nidentifier" })).available).toBe(false);
    }
    expect(queries).toBe(0);
  });

  test("preserves whitespace in question presentation fields and selected labels", async () => {
    let canUseTool: ((name: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
    const handle = await createHost({
      query: (parameters) => { canUseTool = parameters.options?.canUseTool as never; return fakeQuery([]); },
      interactionAuthority: async (interaction) => {
        if (interaction.kind !== "question") throw new Error("expected question");
        expect(interaction.questions[0]?.header).toBe("Pick\tone");
        expect(interaction.questions[0]?.options[0]).toEqual({ label: "First\noption", description: "First\r\ndescription" });
        return { kind: "answers", answers: { "Which?": "First\noption" } };
      },
    }).launch(request());
    try {
      const response = await canUseTool!("AskUserQuestion", { questions: [{
        question: "Which?", header: "Pick\tone", multiSelect: false,
        options: [{ label: "First\noption", description: "First\r\ndescription" }, { label: "Second", description: "Second" }],
      }] }, callbackOptions());
      expect(response).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which?": "First\noption" } } });
    } finally { handle.close(); }
  });

  // Content round trips independently of strict identifier validation.
  for (const [label, content, admitted] of [
    ["single-line Unicode", "Inspect café 日本語", true],
    ["LF", "Inspect\nThen test", true],
    ["CR", "Inspect\rThen test", true],
    ["TAB", "Inspect\tThen test", true],
  ] as const) {
    test(`preserves relay/host prompt content: ${label}`, async () => {
      const parsed = parseRelayClaudeExecutionCommand({
        type: "relay:claude-execution-command",
        scope: { relayId: "relay", relaySessionId: "session", desktopSessionId: "desktop", pairingGenerationRef: "pair", selectedProtocolVersion: 18, capabilityRevision: 0 },
        executionRef: "run", action: { kind: "start", prompt: content, model: "claude-fable-5" },
      });
      expect(parsed).not.toBeNull();
      let parameters: Parameters<ClaudeAgentSdk["query"]>[0] | undefined;
      const host = createHost({ query: (input) => { parameters = input; return fakeQuery([]); } });
      const handle = await host.launch({ ...request(), prompt: content });
      try {
        expect(handle.available).toBe(admitted);
        expect(parameters !== undefined).toBe(admitted);
        if (admitted) expect(await submittedMessage(parameters)).toMatchObject({ message: { content } });
      } finally { handle.close(); }
    });

    test(`preserves streamInput content: ${label}`, async () => {
      const delivered: unknown[] = [];
      const handle = await createHost({ query: () => fakeQuery([], {
        streamInput: async (input) => { for await (const value of input) delivered.push(value); },
      }) }).launch(request());
      try {
        expect(await handle.steer(content)).toEqual({ outcome: admitted ? "accepted" : "rejected" });
        expect(delivered).toHaveLength(admitted ? 1 : 0);
        if (admitted) expect(delivered[0]).toMatchObject({ message: { content } });
      } finally { handle.close(); }
    });

    for (const field of ["question", "answer"] as const) {
      test(`preserves ${field} content: ${label}`, async () => {
        let authorityCalls = 0;
        let canUseTool: ((name: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
        const questionText = field === "question" ? content : "Which approach?";
        const answerText = field === "answer" ? content : "First";
        const handle = await createHost({
          interactionAuthority: async () => {
            authorityCalls += 1;
            return { kind: "answers", answers: { [questionText]: answerText } };
          },
          query: (parameters) => { canUseTool = parameters.options?.canUseTool as never; return fakeQuery([]); },
        }).launch(request());
        try {
          const response = await canUseTool!("AskUserQuestion", { questions: [question(questionText, false)] }, callbackOptions());
          expect(authorityCalls).toBe(field === "question" && !admitted ? 0 : 1);
          expect(response["behavior"]).toBe(admitted ? "allow" : "deny");
          if (admitted) expect(response).toMatchObject({ updatedInput: { answers: { [questionText]: answerText } } });
        } finally { handle.close(); }
      });
    }
  }

  test("accepts observed alias/init variation, preserves setup before init, and submits one fresh ephemeral prompt", async () => {
    let parameters: Parameters<ClaudeAgentSdk["query"]>[0] | undefined;
    const host = createHost({
      query: (input) => {
        parameters = input;
        return fakeQuery([
          hook("hook_started"),
          init("claude-sonnet-alias"),
          assistantTool("Read"),
          partial("final answer"),
          success("final answer"),
        ]);
      },
    });

    const handle = await host.launch({ prompt: "Inspect this", workingDirectory: "/workspace", model: "claude-fable-5" });
    expect(handle.available).toBe(true);
    expect(parameters?.options).toMatchObject({
      cwd: "/workspace",
      model: "claude-fable-5",
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      persistSession: false,
      includePartialMessages: true,
      settings: { switchModelsOnFlag: false },
      disallowedTools: ["Task"],
    });
    expect(await submittedMessage(parameters)).toMatchObject({
      message: { role: "user", content: "Inspect this" },
      parent_tool_use_id: null,
    });
    expect(await collect(handle.observations)).toEqual([
      { kind: "activity", activity: "hook", state: "started" },
      { kind: "initialized", model: "claude-sonnet-alias", claudeCodeVersion: "2.1.235" },
      { kind: "activity", activity: "tool", state: "requested", toolName: "Read" },
      { kind: "output_delta", text: "final answer" },
      { kind: "result", outcome: "succeeded" },
      { kind: "settled", settlement: "eof", afterResult: true },
    ]);
  });

  test("forwards ordered root text deltas and rejects a delta after the authoritative result", async () => {
    let parameters: Parameters<ClaudeAgentSdk["query"]>[0] | undefined;
    const host = createHost({
      query: (input) => {
        parameters = input;
        return fakeQuery([
          init("claude-alias"),
          partial("Hello\n"),
          partial("world"),
          success("Hello\nworld"),
          partial("late private text"),
        ]);
      },
    });
    const handle = await host.launch(request());
    expect(parameters?.options?.includePartialMessages).toBe(true);
    expect(await collect(handle.observations)).toEqual([
      { kind: "initialized", model: "claude-alias", claudeCodeVersion: "2.1.235" },
      { kind: "output_delta", text: "Hello\n" },
      { kind: "output_delta", text: "world" },
      { kind: "result", outcome: "succeeded" },
      { kind: "settled", settlement: "rejected", afterResult: true },
    ]);
  });

  test("delivers one active steer only after streamInput resolves while observations continue", async () => {
    const steerEntered = deferred<void>();
    const releaseSteer = deferred<void>();
    const releaseObservation = deferred<void>();
    const releaseResult = deferred<void>();
    let delivered: unknown;
    async function* stream(): AsyncGenerator<SDKMessage> {
      yield init("claude-alias");
      await releaseObservation.promise;
      yield partial("redirected");
      await releaseResult.promise;
      yield success("redirected");
    }
    const handle = await createHost({
      query: () => fakeQuery(stream(), {
        streamInput: async (input) => {
          delivered = (await input[Symbol.asyncIterator]().next()).value;
          steerEntered.resolve();
          await releaseSteer.promise;
        },
      }),
    }).launch(request());
    const observations = handle.observations[Symbol.asyncIterator]();
    expect((await observations.next()).value).toEqual({ kind: "initialized", model: "claude-alias", claudeCodeVersion: "2.1.235" });
    const steering = handle.steer("Change direction");
    await steerEntered.promise;
    expect(delivered).toMatchObject({ type: "user", message: { role: "user", content: "Change direction" }, parent_tool_use_id: null });
    let settled = false;
    void steering.then(() => { settled = true; });
    releaseObservation.resolve();
    expect((await observations.next()).value).toEqual({ kind: "output_delta", text: "redirected" });
    expect(settled).toBe(false);
    releaseSteer.resolve();
    expect(await steering).toEqual({ outcome: "accepted" });
    releaseResult.resolve();
    expect((await observations.next()).value).toEqual({ kind: "result", outcome: "succeeded" });
  });

  test("keeps a consumed steer accepted when the Query settles immediately afterward", async () => {
    const releaseStreamInput = deferred<void>();
    const releaseResult = deferred<void>();
    async function* stream(): AsyncGenerator<SDKMessage> {
      yield init("claude-alias");
      await releaseResult.promise;
      yield messageStart();
      yield partial("redirected");
      yield success("redirected");
    }
    const handle = await createHost({
      query: () => fakeQuery(stream(), {
        streamInput: async (input) => {
          await input[Symbol.asyncIterator]().next();
          await releaseStreamInput.promise;
        },
      }),
    }).launch(request());
    const observations = handle.observations[Symbol.asyncIterator]();
    expect((await observations.next()).value).toMatchObject({ kind: "initialized" });
    const steering = handle.steer("Change direction");
    releaseResult.resolve();
    expect((await observations.next()).value).toEqual({ kind: "output_delta", text: "redirected" });
    expect((await observations.next()).value).toEqual({ kind: "result", outcome: "succeeded" });
    expect((await observations.next()).value).toEqual({ kind: "settled", settlement: "eof", afterResult: true });
    expect((await observations.next()).done).toBe(true);
    releaseStreamInput.resolve();
    expect(await steering).toEqual({ outcome: "accepted" });
  });

  test("rejects concurrent, provider-failed, post-result, interrupted, and closed steers without an extra provider call", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const active = await createHost({
      query: () => fakeQuery(neverMessages(), {
        streamInput: async () => { calls += 1; entered.resolve(); await release.promise; },
      }),
    }).launch(request());
    const first = active.steer("Change direction");
    await entered.promise;
    expect(await active.steer("A concurrent change")).toEqual({ outcome: "rejected" });
    expect(calls).toBe(1);
    release.resolve();
    expect(await first).toEqual({ outcome: "accepted" });
    active.close();
    expect(await active.steer("After close")).toEqual({ outcome: "rejected" });
    expect(calls).toBe(1);

    let failedCalls = 0;
    const failed = await createHost({ query: () => fakeQuery(neverMessages(), { streamInput: async () => { failedCalls += 1; throw new Error("provider rejected"); } }) }).launch(request());
    expect(await failed.steer("Provider rejects")).toEqual({ outcome: "rejected" });
    expect(failedCalls).toBe(1);

    const result = await createHost({ query: () => fakeQuery([partial("done"), success("done")]) }).launch(request());
    await collect(result.observations);
    expect(await result.steer("After result")).toEqual({ outcome: "rejected" });

    const interrupted = await createHost({ query: () => fakeQuery(neverMessages()) }).launch(request());
    await interrupted.interrupt();
    expect(await interrupted.steer("After interrupt")).toEqual({ outcome: "rejected" });

    let racedCalls = 0;
    const raced = await createHost({ query: () => fakeQuery(neverMessages(), { streamInput: async () => { racedCalls += 1; } }) }).launch(request());
    const interruptedRace = raced.steer("Interrupt immediately");
    await raced.interrupt();
    expect(await interruptedRace).toEqual({ outcome: "rejected" });
    expect(racedCalls).toBe(0);

    const closedRace = await createHost({ query: () => fakeQuery(neverMessages(), { streamInput: async () => { racedCalls += 1; } }) }).launch(request());
    const closeRace = closedRace.steer("Close immediately");
    closedRace.close();
    expect(await closeRace).toEqual({ outcome: "rejected" });
    expect(racedCalls).toBe(0);
  });

  test("does not impose a cumulative ceiling on the lossless output stream", async () => {
    const handle = await createHost({
      query: () => fakeQuery([
        partial("x".repeat(48 * 1024)),
        partial("y".repeat(16 * 1024)),
        partial("z"),
      ]),
    }).launch(request());
    const observations = await collect(handle.observations);
    expect(observations).toHaveLength(4);
    expect(observations[0]).toMatchObject({ kind: "output_delta", text: "x".repeat(48 * 1024) });
    expect(observations[1]).toMatchObject({ kind: "output_delta", text: "y".repeat(16 * 1024) });
    expect(observations[2]).toMatchObject({ kind: "output_delta", text: "z" });
    expect(observations[3]).toEqual({ kind: "settled", settlement: "eof", afterResult: false });
  });

  test("rejects success unless the streamed text exactly matches the SDK result", async () => {
    const handle = await createHost({
      query: () => fakeQuery([partial("visible stream"), success("different final")]),
    }).launch(request());
    expect(await collect(handle.observations)).toEqual([
      { kind: "output_delta", text: "visible stream" },
      { kind: "settled", settlement: "rejected", afterResult: true },
    ]);
  });

  test("validates success against the final root assistant message while retaining earlier streamed text", async () => {
    const handle = await createHost({
      query: () => fakeQuery([
        messageStart(),
        partial("I will use a tool."),
        assistantTool("Bash"),
        messageStart(),
        partial("Redirected work complete."),
        success("Redirected work complete."),
      ]),
    }).launch(request());
    expect(await collect(handle.observations)).toEqual([
      { kind: "output_delta", text: "I will use a tool." },
      { kind: "activity", activity: "tool", state: "requested", toolName: "Bash" },
      { kind: "output_delta", text: "Redirected work complete." },
      { kind: "result", outcome: "succeeded" },
      { kind: "settled", settlement: "eof", afterResult: true },
    ]);
  });

  test("keeps a successful result separate from later iterator EOF", async () => {
    const releaseEof = deferred<void>();
    const resultObserved = deferred<void>();
    async function* stream(): AsyncGenerator<SDKMessage> {
      yield init("claude-alias");
      yield partial("Created the requested file.\n\nIt is ready.");
      yield success("Created the requested file.\n\nIt is ready.");
      resultObserved.resolve();
      await releaseEof.promise;
    }
    const handle = await createHost({ query: () => fakeQuery(stream()) }).launch(request());
    const iterator = handle.observations[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ kind: "initialized", model: "claude-alias", claudeCodeVersion: "2.1.235" });
    expect((await iterator.next()).value).toEqual({ kind: "output_delta", text: "Created the requested file.\n\nIt is ready." });
    expect((await iterator.next()).value).toEqual({ kind: "result", outcome: "succeeded" });
    await resultObserved.promise;
    let settled = false;
    const pending = iterator.next().then((item) => {
      settled = item.done === false && item.value.kind === "settled";
      return item;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseEof.resolve();
    expect(await pending).toEqual({ done: false, value: { kind: "settled", settlement: "eof", afterResult: true } });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  test("retains an official error result before a rejected iterator without leaking diagnostics", async () => {
    async function* stream(): AsyncGenerator<SDKMessage> {
      yield init("claude-alias");
      yield errorResult();
      throw new Error("private provider diagnostic");
    }
    const handle = await createHost({ query: () => fakeQuery(stream()) }).launch(request());
    const observations = await collect(handle.observations);
    expect(observations).toEqual([
      { kind: "initialized", model: "claude-alias", claudeCodeVersion: "2.1.235" },
      { kind: "result", outcome: "failed" },
      { kind: "settled", settlement: "rejected", afterResult: true },
    ]);
    expect(JSON.stringify(observations)).not.toContain("private provider");
  });

  test("recognizes interruption only from official aborted result facts", async () => {
    const handle = await createHost({
      query: () => fakeQuery([init("claude-alias"), errorResult("aborted_tools")]),
    }).launch(request());
    expect(await collect(handle.observations)).toEqual([
      { kind: "initialized", model: "claude-alias", claudeCodeVersion: "2.1.235" },
      { kind: "result", outcome: "interrupted" },
      { kind: "settled", settlement: "eof", afterResult: true },
    ]);
  });

  test("uses host-minted permission authority decisions and lets a denied tool still finish", async () => {
    let permission: ClaudeInteraction | undefined;
    let canUseTool: ((name: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown>) | undefined;
    const host = createHost({
      interactionAuthority: async (interaction) => {
        permission = interaction;
        return { kind: "deny" };
      },
      query: (parameters) => {
        canUseTool = parameters.options?.canUseTool as never;
        return fakeQuery([init("claude-alias"), partial("done"), success("done")]);
      },
    });
    const handle = await host.launch(request());
    const decision = await canUseTool!("Bash", { command: "private command" }, callbackOptions());
    expect(decision).toEqual({
      behavior: "deny",
      message: "Nautilo denied this action",
      toolUseID: "private-tool-use-id",
      decisionClassification: "user_reject",
    });
    expect(permission).toMatchObject({ kind: "permission", scope: "root", allowSession: false, toolName: "Bash" });
    expect(JSON.stringify(permission)).not.toContain("private-tool-use-id");
    expect(await collect(handle.observations)).toContainEqual({ kind: "result", outcome: "succeeded" });
  });

  test("maps AskUserQuestion single-select, multi-select, and Other answers to official question-text strings", async () => {
    let authorityCalls = 0;
    let canUseTool: ((name: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
    const host = createHost({
      interactionAuthority: async (interaction) => {
        authorityCalls += 1;
        if (interaction.kind !== "question") return { kind: "deny" };
        return {
          kind: "answers",
          answers: Object.fromEntries(interaction.questions.map((question, index) => [
            question.text,
            index === 0 ? "Second" : index === 1 ? "First, Second" : "A different approach",
          ])),
        };
      },
      query: (parameters) => {
        canUseTool = parameters.options?.canUseTool as never;
        return fakeQuery([init("claude-alias"), partial("done"), success("done")]);
      },
    });
    await host.launch(request());
    const response = await canUseTool!("AskUserQuestion", {
      questions: [
        question("Pick one?", false),
        question("Pick many?", true),
        question("Other?", false),
      ],
    }, callbackOptions());
    expect(authorityCalls).toBe(1);
    expect(response).toMatchObject({
      behavior: "allow",
      decisionClassification: "user_temporary",
      updatedInput: {
        answers: {
          "Pick one?": "Second",
          "Pick many?": "First, Second",
          "Other?": "A different approach",
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain("preview");
  });

  test("denies malformed or subagent interactions before calling human authority", async () => {
    let calls = 0;
    let canUseTool: ((name: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
    const host = createHost({
      interactionAuthority: async () => {
        calls += 1;
        return { kind: "allow_once" };
      },
      query: (parameters) => {
        canUseTool = parameters.options?.canUseTool as never;
        return fakeQuery([init("claude-alias")]);
      },
    });
    await host.launch(request());
    const malformed = await canUseTool!("AskUserQuestion", { questions: [{ question: "bad", header: "bad", options: [] }] }, callbackOptions());
    const subagent = await canUseTool!("Read", {}, callbackOptions({ agentID: "child" }));
    expect(malformed["behavior"]).toBe("deny");
    expect(subagent["behavior"]).toBe("deny");
    expect(calls).toBe(0);
  });

  test("uses the official interrupt receipt once and denies a parked authority after stop intent", async () => {
    const authorityGate = deferred<ClaudeInteractionDecision>();
    const receiptGate = deferred<unknown>();
    let canUseTool: ((name: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
    let interrupts = 0;
    const host = createHost({
      interactionAuthority: async () => authorityGate.promise,
      query: (parameters) => {
        canUseTool = parameters.options?.canUseTool as never;
        return fakeQuery([init("claude-alias")], {
          interrupt: async () => {
            interrupts += 1;
            return receiptGate.promise;
          },
        });
      },
    });
    const handle = await host.launch(request());
    const permission = canUseTool!("Read", {}, callbackOptions());
    const first = handle.interrupt();
    const second = handle.interrupt();
    expect(first).toBe(second);
    receiptGate.resolve({ still_queued: [] });
    expect(await first).toEqual({ outcome: "acknowledged" });
    authorityGate.resolve({ kind: "allow_once" });
    expect((await permission)["behavior"]).toBe("deny");
    expect(interrupts).toBe(1);
  });

  test("local close and local abort never invent an authoritative result", async () => {
    const closed = deferred<void>();
    async function* stream(): AsyncGenerator<SDKMessage> {
      yield init("claude-alias");
      await closed.promise;
    }
    const host = createHost({
      query: () => fakeQuery(stream(), { close: () => closed.resolve() }),
    });
    const handle = await host.launch(request());
    handle.close();
    expect(await collect(handle.observations)).toEqual([
      { kind: "settled", settlement: "eof", afterResult: false },
    ]);
  });

  test("permits an immediate fresh successor after the first Query settles", async () => {
    let queries = 0;
    const host = createHost({
      query: () => {
        queries += 1;
        return fakeQuery([init(queries === 1 ? "first-alias" : "second-alias"), errorResult("aborted_streaming")]);
      },
    });
    const first = await host.launch(request());
    expect(first.available).toBe(true);
    await collect(first.observations);
    const second = await host.launch(request());
    expect(second.available).toBe(true);
    await collect(second.observations);
    expect(queries).toBe(2);
  });

  test("scopes the human budget to one Query and reserves AskUserQuestion parsing for that exact tool", async () => {
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    const seen: ClaudeInteraction[] = [];
    const callbacks: Array<(name: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<Record<string, unknown>>> = [];
    async function* live(release: Deferred<void>): AsyncGenerator<SDKMessage> {
      yield init("claude-alias");
      await release.promise;
    }
    const host = createHost({
      interactionAuthority: async (interaction) => {
        seen.push(interaction);
        return { kind: "allow_once" };
      },
      query: (parameters) => {
        callbacks.push(parameters.options?.canUseTool as never);
        return fakeQuery(callbacks.length === 1 ? live(releaseFirst) : live(releaseSecond));
      },
    });
    const first = await host.launch(request());
    for (let index = 0; index < 32; index += 1) expect((await callbacks[0]!("Read", {}, callbackOptions()))["behavior"]).toBe("allow");
    releaseFirst.resolve();
    await collect(first.observations);
    const second = await host.launch(request());
    expect((await callbacks[1]!("Bash", { questions: [] }, callbackOptions()))["behavior"]).toBe("allow");
    expect(seen.at(-1)).toMatchObject({ kind: "permission", toolName: "Bash" });
    releaseSecond.resolve();
    await collect(second.observations);
  });

  test("fails closed for hostile launch input and bounded input without starting a Query", async () => {
    let queries = 0;
    const host = createHost({ query: () => { queries += 1; return fakeQuery([]); } });
    const accessor: unknown = Object.create(null, {
      prompt: { enumerable: true, get: () => { throw new Error("getter"); } },
      workingDirectory: { enumerable: true, value: "/workspace" },
      model: { enumerable: true, value: "claude" },
    });
    expect((await host.launch(accessor as never)).available).toBe(false);
    expect((await host.launch({ prompt: "x".repeat(16 * 1024 + 1), workingDirectory: "/workspace", model: "claude" })).available).toBe(false);
    expect(queries).toBe(0);
  });

  test("keeps discovery account/catalog behavior separate from execution observations", async () => {
    const facts: RelayClaudeFact[] = [];
    let captured: Parameters<ClaudeAgentSdk["query"]>[0] | undefined;
    const host = createHost({
      onFact: (fact) => facts.push(fact),
      query: (parameters) => {
        captured = parameters;
        return fakeQuery([], {
          accountInfo: async () => ({ email: "writer@example.test", apiProvider: "firstParty" }),
          supportedModels: async () => [{ value: "claude-fable-5", displayName: "Fable 5", description: "Frontier" }],
        });
      },
    });
    expect(await host.discover({ workingDirectory: "/workspace" })).toBe(true);
    expect(typeof captured?.prompt).not.toBe("string");
    expect(facts).toContainEqual({ kind: "runtime", state: "ready", version: "2.1.235", executionQualified: true });
    expect(facts).toContainEqual({ kind: "account", account: { state: "connected", email: "writer@example.test", apiProvider: "firstParty" } });
    expect(facts).toContainEqual({ kind: "model_catalog", complete: true, models: [{ id: "claude-fable-5", displayName: "Fable 5", description: "Frontier" }] });
  });
});

function createHost(input: Readonly<{
  query: ClaudeAgentSdk["query"];
  onFact?: (fact: RelayClaudeFact) => void;
  interactionAuthority?: (interaction: ClaudeInteraction, signal: AbortSignal) => Promise<ClaudeInteractionDecision>;
}>): ClaudeAgentSdkHost {
  return new ClaudeAgentSdkHost({
    executableResolver: {
      resolve: async () => ({
        path: "/usr/local/bin/claude",
        version: "2.1.235",
        features: reviewedFeatures,
      }),
    },
    sdk: { query: input.query },
    onFact: input.onFact ?? (() => undefined),
    ...(input.interactionAuthority === undefined ? {} : { interactionAuthority: input.interactionAuthority }),
  });
}

function request(): { prompt: string; workingDirectory: string; model: string } {
  return { prompt: "Inspect", workingDirectory: "/workspace", model: "claude-fable-5" };
}

function init(model: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    model,
    claude_code_version: "2.1.235",
  } as unknown as SDKMessage;
}

function partial(text: string): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  } as unknown as SDKMessage;
}

function messageStart(): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "message_start", message: { role: "assistant", content: [] } },
  } as unknown as SDKMessage;
}

function hook(subtype: "hook_started" | "hook_progress" | "hook_response"): SDKMessage {
  return { type: "system", subtype } as unknown as SDKMessage;
}

function assistantTool(name: string): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", name }] },
  } as unknown as SDKMessage;
}

function success(candidate: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: candidate,
    terminal_reason: null,
  } as unknown as SDKMessage;
}

function errorResult(terminalReason: string | null = null): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: terminalReason,
  } as unknown as SDKMessage;
}

function question(text: string, multiSelect: boolean): Record<string, unknown> {
  return {
    question: text,
    header: "Choice",
    multiSelect,
    options: [
      { label: "First", description: "One", preview: "private preview" },
      { label: "Second", description: "Two" },
    ],
  };
}

function callbackOptions(extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    signal: new AbortController().signal,
    toolUseID: "private-tool-use-id",
    requestId: "private-request-id",
    ...extra,
  };
}

function fakeQuery(
  messages: readonly SDKMessage[] | AsyncIterable<SDKMessage>,
  overrides: Readonly<{
    interrupt?: () => Promise<unknown>;
    streamInput?: (input: AsyncIterable<unknown>) => Promise<unknown>;
    close?: () => void;
    accountInfo?: () => Promise<unknown>;
    supportedModels?: () => Promise<unknown>;
  }> = {},
): Query {
  const stream = isAsyncIterable(messages) ? messages : asAsync(messages);
  return {
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    interrupt: overrides.interrupt ?? (async () => undefined),
    streamInput: overrides.streamInput ?? (async () => undefined),
    close: overrides.close ?? (() => undefined),
    accountInfo: overrides.accountInfo ?? (async () => ({ email: "writer@example.test", apiProvider: "firstParty" })),
    supportedModels: overrides.supportedModels ?? (async () => []),
  } as unknown as Query;
}

async function* asAsync(messages: readonly SDKMessage[]): AsyncGenerator<SDKMessage> {
  yield* messages;
}

async function* neverMessages(): AsyncGenerator<SDKMessage> {
  await new Promise<never>(() => undefined);
  yield undefined as never;
}

function isAsyncIterable(value: readonly SDKMessage[] | AsyncIterable<SDKMessage>): value is AsyncIterable<SDKMessage> {
  return !Array.isArray(value);
}

async function submittedMessage(parameters: Parameters<ClaudeAgentSdk["query"]>[0] | undefined): Promise<unknown> {
  const prompt = parameters?.prompt;
  if (prompt === undefined || typeof prompt === "string") return undefined;
  return (await prompt[Symbol.asyncIterator]().next()).value;
}

async function collect(observations: AsyncIterable<ClaudeExecutionObservation>): Promise<ClaudeExecutionObservation[]> {
  const result: ClaudeExecutionObservation[] = [];
  for await (const observation of observations) result.push(observation);
  return result;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
