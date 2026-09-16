import { describe, expect, test } from "bun:test";
import type { ClaudeInteractionAuthority, ClaudeLaunchHandle } from "@nautilo/claude-agent-sdk-host";
import { RELAY_PROTOCOL_VERSION, type RelayClaudeExecutionCommand, type RelayClaudeExecutionDesktopEvent, type RelayClaudeExecutionSession } from "@nautilo/relay";
import { ElectronClaudeExecutionHost } from "../../electron/claude-execution";
import type { CurrentFolderClaudeLease } from "../../electron/current-folder-claude-lease";

const session: RelayClaudeExecutionSession = { relayId: "relay", relaySessionId: "session", desktopSessionId: "desktop", pairingGenerationRef: "pair", selectedProtocolVersion: RELAY_PROTOCOL_VERSION, capabilityRevision: 0 };
const start = (ref = "run"): RelayClaudeExecutionCommand => ({ type: "relay:claude-execution-command", scope: session, executionRef: ref, action: { kind: "start", prompt: "work", model: "model" } });

describe("Electron Claude execution", () => {
  test("withheld, oversized and old-peer actions cannot be approved on the host", async () => {
    for (const [version, detail, expectedReason] of [
      [20, { state: "withheld" as const, reason: "sensitive" as const }, "sensitive"],
      [20, { state: "shown" as const, text: "a".repeat(128 * 1024) }, "frame_limit"],
      [19, { state: "shown" as const, text: "Bash\nnode --test" }, undefined],
    ] as const) {
      let authority!: ClaudeInteractionAuthority;
      const events: RelayClaudeExecutionDesktopEvent[] = [];
      const peer = { ...session, selectedProtocolVersion: version };
      const host = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => fakeLease() }, createHost: (next) => { authority = next; return { launch: async () => ({ available: true, observations: never(), interrupt: async () => ({ outcome: "acknowledged" as const }), close: () => undefined }) }; } });
      host.onRegistered(peer, { send: (event) => { events.push(event); return true; } });
      host.onCommand({ ...start(), scope: peer });
      await waitFor(() => events.some((event) => event.event.kind === "started"));
      const pending = authority({ kind: "permission", interactionRef: "permission", toolName: "Bash", scope: "root", allowSession: false, detail }, new AbortController().signal);
      await waitFor(() => events.some((event) => event.event.kind === "interaction"));
      const offered = events.find((event) => event.event.kind === "interaction")?.event;
      if (offered?.kind !== "interaction" || offered.interaction.kind !== "permission") throw new Error("missing permission");
      expect(offered.interaction.detail).toEqual(expectedReason ? { state: "withheld", reason: expectedReason } : undefined);
      host.onCommand({ ...start(), scope: peer, action: { kind: "respond", interactionRef: "permission", response: { kind: "allow_once" } } });
      expect(await pending).toEqual({ kind: "deny" });
      await waitFor(() => events.some((event) => event.event.kind === "interaction_rejected"));
      expect(events.some((event) => event.event.kind === "interaction_rejected")).toBeTrue();
      host.onDisconnected();
    }
  });
  test("uses the negotiated current relay protocol and rejects mismatched scope versions", async () => {
    const current = { ...session, selectedProtocolVersion: RELAY_PROTOCOL_VERSION };
    const events: RelayClaudeExecutionDesktopEvent[] = [];
    let launches = 0;
    const host = new ElectronClaudeExecutionHost({
      currentFolder: () => ({ path: "/synthetic", revision: 0 }),
      leaseProvider: { acquire: async () => fakeLease() },
      createHost: () => ({ launch: async () => {
        launches++;
        return { available: true, observations: never(), interrupt: async () => ({ outcome: "acknowledged" as const }),
          steer: async () => ({ outcome: "accepted" as const }), close: () => undefined };
      } }),
    });
    host.onRegistered(current, { send: (event) => { events.push(event); return true; } });
    host.onCommand({ ...start("stale-version"), scope: { ...current, selectedProtocolVersion: RELAY_PROTOCOL_VERSION - 1 } });
    await tick();
    expect(launches).toBe(0);
    host.onCommand({ ...start(), scope: current });
    await waitFor(() => events.some((event) => event.event.kind === "started"));
    expect(launches).toBe(1);
    host.onCommand({ ...start(), scope: current, action: { kind: "steer", steerRef: "redirect", prompt: "New\ndirection" } });
    await waitFor(() => events.some((event) => event.event.kind === "steer_receipt"));
    host.onCommand({ ...start(), scope: current, action: { kind: "interrupt" } });
    await waitFor(() => events.some((event) => event.event.kind === "interrupt_receipt"));
    expect(events.every((event) => event.scope.selectedProtocolVersion === RELAY_PROTOCOL_VERSION)).toBeTrue();
    host.onDisconnected();
  });

  test("starts only after a local lease and forwards observed result facts", async () => {
    const events: RelayClaudeExecutionDesktopEvent[] = [];
    const lease = fakeLease();
    const host = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => lease }, createHost: () => ({ launch: async () => handle([{ kind: "output_delta", text: "done" }, { kind: "result", outcome: "succeeded" }, { kind: "settled", settlement: "eof", afterResult: true }]) }) });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } });
    host.onCommand(start());
    await waitFor(() => events.length === 4);
    expect(events.map((event) => event.event.kind)).toEqual(["started", "output_delta", "result", "settled"]);
    expect(events[2]?.event).toEqual({ kind: "result", outcome: "success", text: null });
    expect(lease.signal.aborted).toBeTrue();
  });

  test("forwards root assistant output deltas through the existing execution event", async () => {
    const events: RelayClaudeExecutionDesktopEvent[] = [];
    const host = new ElectronClaudeExecutionHost({
      currentFolder: () => ({ path: "/tmp", revision: 0 }),
      leaseProvider: { acquire: async () => fakeLease() },
      createHost: () => ({ launch: async () => handle([
        { kind: "output_delta", text: "Hello\n" },
        { kind: "output_delta", text: "world" },
        { kind: "result", outcome: "succeeded" },
        { kind: "settled", settlement: "eof", afterResult: true },
      ]) }),
    });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } });
    host.onCommand(start());
    await waitFor(() => events.length === 5);
    expect(events.map((event) => event.event.kind)).toEqual(["started", "output_delta", "output_delta", "result", "settled"]);
    expect(events.slice(1, 3).map((event) => event.event)).toEqual([
      { kind: "output_delta", text: "Hello\n" },
      { kind: "output_delta", text: "world" },
    ]);
  });

  test("gates a fast interaction behind started and maps exact response refs", async () => {
    const events: RelayClaudeExecutionDesktopEvent[] = [];
    let authority: ClaudeInteractionAuthority | null = null;
    const host = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => fakeLease() }, createHost: (next) => { authority = next; return { launch: async () => ({ available: true, observations: never(), interrupt: async () => ({ outcome: "acknowledged" as const }), close: () => undefined }) }; } });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } });
    host.onCommand(start());
    await waitFor(() => authority !== null && events.some((event) => event.event.kind === "started"));
    const pending = authority!({ kind: "permission", interactionRef: "permission", toolName: "Bash", scope: "root", allowSession: false, detail: { state: "shown", text: "Bash\nnode --test" } }, new AbortController().signal);
    await waitFor(() => events.some((event) => event.event.kind === "interaction"));
    host.onCommand({ type: "relay:claude-execution-command", scope: session, executionRef: "run", action: { kind: "respond", interactionRef: "permission", response: { kind: "allow_once" } } });
    expect(await pending).toEqual({ kind: "allow_once" });
    expect(events.map((event) => event.event.kind)).toContain("interaction_accepted");
    host.onDisconnected();
  });

  test("disconnect closes the live handle without fabricating result or stop", async () => {
    const events: RelayClaudeExecutionDesktopEvent[] = [];
    let closed = false;
    const host = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => fakeLease() }, createHost: () => ({ launch: async () => ({ available: true, observations: never(), interrupt: async () => ({ outcome: "acknowledged" as const }), close: () => { closed = true; } }) }) });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } }); host.onCommand(start());
    await waitFor(() => events.length === 1); host.onDisconnected(); await waitFor(() => closed);
    expect(events.map((event) => event.event.kind)).toEqual(["started"]);
  });

  test("synchronously fences double starts and a replacement while acquire is pending", async () => {
    let release!: (lease: CurrentFolderClaudeLease) => void;
    const acquired = new Promise<CurrentFolderClaudeLease>((resolve) => { release = resolve; });
    let launches = 0;
    const events: RelayClaudeExecutionDesktopEvent[] = [];
    const host = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => acquired }, createHost: () => ({ launch: async () => { launches++; return handle([]); } }) });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } });
    host.onCommand(start("one")); host.onCommand(start("two"));
    host.onRegistered({ ...session, relaySessionId: "replacement" }, { send: () => true });
    release(fakeLease()); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(launches).toBe(0); expect(events.map((event) => event.event.kind)).toEqual(["unavailable"]);
  });

  test("interrupt is single-flight", async () => {
    let interrupts = 0; const events: RelayClaudeExecutionDesktopEvent[] = [];
    const host = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => fakeLease() }, createHost: () => ({ launch: async () => ({ available: true, observations: never(), interrupt: async () => { interrupts++; return { outcome: "acknowledged" as const }; }, close: () => undefined }) }) });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } }); host.onCommand(start()); await waitFor(() => events.length === 1);
    const command: RelayClaudeExecutionCommand = { type: "relay:claude-execution-command", scope: session, executionRef: "run", action: { kind: "interrupt" } }; host.onCommand(command); host.onCommand(command);
    await waitFor(() => events.filter((event) => event.event.kind === "interrupt_receipt").length === 1); expect(interrupts).toBe(1); host.onDisconnected();
  });

  test("emits an exact steer receipt only after the active handle resolves", async () => {
    const events: RelayClaudeExecutionDesktopEvent[] = [];
    let resolveSteer!: () => void;
    const steering = new Promise<void>((resolve) => { resolveSteer = resolve; });
    let prompt: string | null = null;
    const host = new ElectronClaudeExecutionHost({
      currentFolder: () => ({ path: "/tmp", revision: 0 }),
      leaseProvider: { acquire: async () => fakeLease() },
      createHost: () => ({ launch: async () => ({
        available: true, observations: never(), interrupt: async () => ({ outcome: "acknowledged" as const }),
        steer: async (next) => { prompt = next; await steering; return { outcome: "accepted" as const }; }, close: () => undefined,
      }) }),
    });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } }); host.onCommand(start());
    await waitFor(() => events.some((event) => event.event.kind === "started"));
    host.onCommand({ type: "relay:claude-execution-command", scope: session, executionRef: "run", action: { kind: "steer", steerRef: "steer-1", prompt: "Change direction" } });
    await tick(); expect(prompt).toBe("Change direction"); expect(events.map((event) => event.event.kind)).toEqual(["started"]);
    resolveSteer(); await waitFor(() => events.some((event) => event.event.kind === "steer_receipt"));
    expect(events.at(-1)?.event).toEqual({ kind: "steer_receipt", steerRef: "steer-1", outcome: "accepted" }); host.onDisconnected();
  });

  test("keeps an admitted receipt when EOF closes the lease during receipt validation", async () => {
    const events: RelayClaudeExecutionDesktopEvent[] = [];
    const observations = Promise.withResolvers<void>();
    const validation = Promise.withResolvers<boolean>();
    const validating = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let delayReceiptValidation = false;
    const lease = fakeLease();
    const host = new ElectronClaudeExecutionHost({
      currentFolder: () => ({ path: "/synthetic", revision: 0 }),
      leaseProvider: { acquire: async () => ({ ...lease,
        validate: async () => {
          if (delayReceiptValidation) { delayReceiptValidation = false; validating.resolve(); return validation.promise; }
          return lease.validate();
        },
        close: async () => { await lease.close(); closed.resolve(); },
      }) },
      createHost: () => ({ launch: async () => ({
        available: true,
        observations: (async function* () {
          await observations.promise;
          yield { kind: "result" as const, outcome: "succeeded" as const };
          yield { kind: "settled" as const, settlement: "eof" as const, afterResult: true };
        })(),
        steer: async () => { delayReceiptValidation = true; return { outcome: "accepted" as const }; },
        interrupt: async () => ({ outcome: "acknowledged" as const }), close: () => undefined,
      }) }),
    });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } });
    host.onCommand(start()); await waitFor(() => events.length === 1);
    host.onCommand({ ...start(), action: { kind: "steer", steerRef: "receipt", prompt: "Redirect" } });
    await validating.promise;
    observations.resolve(); await closed.promise;
    validation.resolve(false);
    await waitFor(() => events.some((event) => event.event.kind === "steer_receipt"));
    expect(events.at(-1)?.event).toEqual({ kind: "steer_receipt", steerRef: "receipt", outcome: "accepted" });
    host.onDisconnected();
  });

  for (const invalidation of ["folder", "disconnect", "successor"] as const) {
    test(`does not publish a retired steer receipt after ${invalidation}`, async () => {
      const events: RelayClaudeExecutionDesktopEvent[] = [];
      const receipt = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const observations = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const lease = fakeLease();
      let launches = 0;
      const host = new ElectronClaudeExecutionHost({
        currentFolder: () => ({ path: "/synthetic", revision: 0 }),
        leaseProvider: { acquire: async () => launches === 0 ? { ...lease, close: async () => { await lease.close(); closed.resolve(); } } : fakeLease() },
        createHost: () => ({ launch: async () => {
          launches += 1;
          return { available: true,
            observations: (async function* () { await observations.promise; yield { kind: "settled" as const, settlement: "eof" as const, afterResult: false }; })(),
            steer: async () => { entered.resolve(); await receipt.promise; return { outcome: "accepted" as const }; },
            interrupt: async () => ({ outcome: "acknowledged" as const }), close: () => undefined,
          };
        } }),
      });
      host.onRegistered(session, { send: (event) => { events.push(event); return true; } });
      host.onCommand(start()); await waitFor(() => events.length === 1);
      host.onCommand({ ...start(), action: { kind: "steer", steerRef: "receipt", prompt: "Redirect" } });
      await entered.promise; observations.resolve(); await closed.promise;
      if (invalidation === "folder") host.onCurrentFolderChanged();
      if (invalidation === "disconnect") host.onDisconnected();
      if (invalidation === "successor") host.onCommand(start("successor"));
      receipt.resolve(); await tick();
      expect(events.some((event) => event.event.kind === "steer_receipt")).toBe(false);
      if (invalidation === "folder") { host.onCommand(start()); await tick(); expect(launches).toBe(1); }
      host.onDisconnected();
    });
  }

  test("rejects provider failure and a concurrent steer without a second provider call", async () => {
    const events: RelayClaudeExecutionDesktopEvent[] = [];
    let calls = 0; let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const host = new ElectronClaudeExecutionHost({
      currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => fakeLease() },
      createHost: () => ({ launch: async () => ({
        available: true, observations: never(), interrupt: async () => ({ outcome: "acknowledged" as const }),
        steer: async () => { calls += 1; await pending; return { outcome: "rejected" as const }; }, close: () => undefined,
      }) }),
    });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } }); host.onCommand(start());
    await waitFor(() => events.some((event) => event.event.kind === "started"));
    host.onCommand({ type: "relay:claude-execution-command", scope: session, executionRef: "run", action: { kind: "steer", steerRef: "first", prompt: "Change" } });
    await tick(); host.onCommand({ type: "relay:claude-execution-command", scope: session, executionRef: "run", action: { kind: "steer", steerRef: "second", prompt: "Concurrent" } });
    await waitFor(() => events.some((event) => event.event.kind === "steer_receipt" && event.event.steerRef === "second"));
    expect(calls).toBe(1); expect(events.at(-1)?.event).toEqual({ kind: "steer_receipt", steerRef: "second", outcome: "rejected" });
    release(); await waitFor(() => events.some((event) => event.event.kind === "steer_receipt" && event.event.steerRef === "first"));
    expect(events.at(-1)?.event).toEqual({ kind: "steer_receipt", steerRef: "first", outcome: "rejected" }); host.onDisconnected();
  });

  test("rejects a registered-scope steer that has no exact active execution", async () => {
    const events: RelayClaudeExecutionDesktopEvent[] = [];
    const host = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }) });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } });
    host.onCommand({ type: "relay:claude-execution-command", scope: session, executionRef: "stale-run", action: { kind: "steer", steerRef: "stale-steer", prompt: "Change" } });
    await waitFor(() => events.length === 1);
    expect(events[0]?.event).toEqual({ kind: "steer_receipt", steerRef: "stale-steer", outcome: "rejected" }); host.onDisconnected();
  });

  test("projects exact question labels and fences every response shape", async () => {
    const events: RelayClaudeExecutionDesktopEvent[] = []; let authority: ClaudeInteractionAuthority | null = null;
    const host = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => fakeLease() }, createHost: (next) => { authority = next; return { launch: async () => ({ available: true, observations: never(), interrupt: async () => ({ outcome: "acknowledged" as const }), close: () => undefined }) }; } });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } }); host.onCommand(start()); await waitFor(() => authority !== null && events.length === 1);
    const ask = (multiSelect: boolean) => authority!({ kind: "question", interactionRef: crypto.randomUUID(), scope: "root", questions: [{ text: "Choose\nnow", header: "Question", multiSelect, allowOther: true, options: [{ label: "One", description: "first" }, { label: "Two", description: "second" }] }] }, new AbortController().signal);
    const pending = ask(false); await waitFor(() => events.some((event) => event.event.kind === "interaction"));
    const interaction = events.at(-1)?.event; if (interaction?.kind !== "interaction" || interaction.interaction.kind !== "question") throw new Error("missing question");
    const question = interaction.interaction.questions[0]; if (!question) throw new Error("missing question ref"); const [one, two] = question.options;
    if (!one || !two) throw new Error("missing option refs");
    host.onCommand({ type: "relay:claude-execution-command", scope: session, executionRef: "run", action: { kind: "respond", interactionRef: interaction.interaction.interactionRef, response: { kind: "answers", answers: { [question.questionRef]: [one.optionRef] } } } });
    expect(await pending).toEqual({ kind: "answers", answers: { "Choose\nnow": "One" } });
    const multi = ask(true); await waitFor(() => events.filter((event) => event.event.kind === "interaction").length === 2);
    const next = events.at(-1)?.event; if (next?.kind !== "interaction" || next.interaction.kind !== "question") throw new Error("missing next question"); const nextQuestion = next.interaction.questions[0]; if (!nextQuestion) throw new Error("missing next ref");
    const nextOne = nextQuestion.options[0]; if (!nextOne) throw new Error("missing next option");
    host.onCommand({ type: "relay:claude-execution-command", scope: session, executionRef: "run", action: { kind: "respond", interactionRef: next.interaction.interactionRef, response: { kind: "answers", answers: { [nextQuestion.questionRef]: [nextOne.optionRef, "custom\nwith\ttabs\rand café"] } } } });
    expect(await multi).toEqual({ kind: "answers", answers: { "Choose\nnow": "One, custom\nwith\ttabs\rand café" } });
    for (const mode of ["foreign", "two"] as const) {
      const invalid = ask(false); const count = events.filter((event) => event.event.kind === "interaction").length; await waitFor(() => events.filter((event) => event.event.kind === "interaction").length === count + 1);
      const event = events.at(-1)?.event; if (event?.kind !== "interaction" || event.interaction.kind !== "question") throw new Error("missing invalid question"); const item = event.interaction.questions[0]; if (!item) throw new Error("missing invalid ref");
      const answers = mode === "foreign" ? ["00000000-0000-4000-8000-000000000000"] : item.options.slice(0, 2).map((option) => option.optionRef);
      host.onCommand({ type: "relay:claude-execution-command", scope: session, executionRef: "run", action: { kind: "respond", interactionRef: event.interaction.interactionRef, response: { kind: "answers", answers: { [item.questionRef]: answers } } } }); expect(await invalid).toEqual({ kind: "deny" });
    }
    const concurrent = ask(false); const count = events.filter((event) => event.event.kind === "interaction").length; await waitFor(() => events.filter((event) => event.event.kind === "interaction").length === count + 1);
    const last = events.at(-1)?.event; if (last?.kind !== "interaction" || last.interaction.kind !== "question") throw new Error("missing concurrent question"); const lastQuestion = last.interaction.questions[0]; const lastOption = lastQuestion?.options[0]; if (!lastQuestion || !lastOption) throw new Error("missing concurrent refs");
    const response: RelayClaudeExecutionCommand = { type: "relay:claude-execution-command", scope: session, executionRef: "run", action: { kind: "respond", interactionRef: last.interaction.interactionRef, response: { kind: "answers", answers: { [lastQuestion.questionRef]: [lastOption.optionRef] } } } }; host.onCommand(response); host.onCommand(response);
    expect(await concurrent).toEqual({ kind: "answers", answers: { "Choose\nnow": "One" } }); await waitFor(() => events.filter((event) => event.event.kind === "interaction_rejected").length === 3); expect(events.filter((event) => event.event.kind === "interaction_accepted")).toHaveLength(3); host.onDisconnected();
  });

  test("closes a handle returned after disconnect without publishing it", async () => {
    let resolveLaunch!: (value: ClaudeLaunchHandle) => void; let closed = false; const events: RelayClaudeExecutionDesktopEvent[] = [];
    const pendingLaunch = new Promise<ClaudeLaunchHandle>((resolve) => { resolveLaunch = resolve; });
    const host = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => fakeLease() }, createHost: () => ({ launch: async () => pendingLaunch }) });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } }); host.onCommand(start("late")); await tick(); host.onDisconnected();
    resolveLaunch({ available: true, observations: never(), interrupt: async () => ({ outcome: "acknowledged" }), close: () => { closed = true; } }); await waitFor(() => closed);
    expect(events).toHaveLength(0);
  });

  test("latches a Stop during deferred acquisition and applies it exactly once after launch", async () => {
    let releaseLease!: (lease: CurrentFolderClaudeLease) => void; const acquired = new Promise<CurrentFolderClaudeLease>((resolve) => { releaseLease = resolve; }); let resolveLaunch!: (value: ClaudeLaunchHandle) => void; let entered = false; let interrupts = 0; const events: RelayClaudeExecutionDesktopEvent[] = [];
    const pendingLaunch = new Promise<ClaudeLaunchHandle>((resolve) => { resolveLaunch = resolve; });
    const host = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => acquired }, createHost: () => ({ launch: async () => { entered = true; return pendingLaunch; } }) });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } }); host.onCommand(start()); await tick();
    const interrupt: RelayClaudeExecutionCommand = { type: "relay:claude-execution-command", scope: session, executionRef: "run", action: { kind: "interrupt" } }; host.onCommand(interrupt); host.onCommand(interrupt);
    releaseLease(fakeLease()); await waitFor(() => entered);
    resolveLaunch({ available: true, observations: never(), interrupt: async () => { interrupts += 1; return { outcome: "acknowledged" as const }; }, close: () => undefined });
    await waitFor(() => events.filter((event) => event.event.kind === "interrupt_receipt").length === 1); expect(events.map((event) => event.event.kind)).toEqual(["started", "interrupt_receipt"]); expect(interrupts).toBe(1); host.onDisconnected();
  });

  test("keeps only the latest settled ref, so replay is denied without a 64-task cap", async () => {
    let launches = 0; const events: RelayClaudeExecutionDesktopEvent[] = [];
    const host = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => fakeLease() }, createHost: () => ({ launch: async () => { launches += 1; return handle([]); } }) });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } });
    for (let index = 0; index < 65; index += 1) { const ref = `run-${index}`; host.onCommand(start(ref)); await waitFor(() => events.some((event) => event.executionRef === ref && event.event.kind === "started")); await tick(); }
    host.onCommand(start("run-64")); await waitFor(() => events.some((event) => event.executionRef === "run-64" && event.event.kind === "unavailable"));
    host.onCommand(start("run-0")); await waitFor(() => events.filter((event) => event.executionRef === "run-0" && event.event.kind === "started").length === 2); expect(launches).toBe(66);
  });

  test("Current Folder change closes an active execution and fences a pending acquisition", async () => {
    let activeClosed = false; const active = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => fakeLease() }, createHost: () => ({ launch: async () => ({ available: true, observations: never(), interrupt: async () => ({ outcome: "acknowledged" as const }), close: () => { activeClosed = true; } }) }) });
    active.onRegistered(session, { send: () => true }); active.onCommand(start("active")); await tick(); active.onCurrentFolderChanged(); await waitFor(() => activeClosed);
    let release!: (lease: CurrentFolderClaudeLease) => void; let launches = 0; const acquired = new Promise<CurrentFolderClaudeLease>((resolve) => { release = resolve; }); const pendingLease = fakeLease();
    const pending = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => acquired }, createHost: () => ({ launch: async () => { launches += 1; return handle([]); } }) });
    pending.onRegistered(session, { send: () => true }); pending.onCommand(start("pending")); pending.onCurrentFolderChanged(); release(pendingLease); await waitFor(() => pendingLease.signal.aborted);
    expect(launches).toBe(0);
  });

  test("contains initial and post-launch validation throws without wedging a successor", async () => {
    let checks = 0; let failedClosed = false; let launches = 0; const events: RelayClaudeExecutionDesktopEvent[] = [];
    const failedLease = Object.freeze({ workingDirectory: "/private/tmp", signal: new AbortController().signal, validate: async () => { checks += 1; if (checks === 2) throw new Error("post-launch"); return true; }, close: async () => { failedClosed = true; } });
    const goodLease = fakeLease(); const host = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => checks === 0 ? failedLease : goodLease }, createHost: () => ({ launch: async () => { launches += 1; return handle([]); } }) });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } }); host.onCommand(start("bad")); await waitFor(() => events.some((event) => event.executionRef === "bad" && event.event.kind === "unavailable")); expect(failedClosed).toBeTrue();
    host.onCommand(start("good")); await waitFor(() => events.some((event) => event.executionRef === "good" && event.event.kind === "started")); expect(launches).toBe(2);
  });

  test("aborts an interaction during publication without accepting a provider decision", async () => {
    const events: RelayClaudeExecutionDesktopEvent[] = []; let authority: ClaudeInteractionAuthority | null = null; let validations = 0; let releaseValidation!: (value: boolean) => void;
    const delayed = new Promise<boolean>((resolve) => { releaseValidation = resolve; }); const controller = new AbortController();
    const lease = Object.freeze({ workingDirectory: "/private/tmp", signal: new AbortController().signal, validate: async () => { validations += 1; return validations === 6 ? delayed : true; }, close: async () => undefined });
    const host = new ElectronClaudeExecutionHost({ currentFolder: () => ({ path: "/tmp", revision: 0 }), leaseProvider: { acquire: async () => lease }, createHost: (next) => { authority = next; return { launch: async () => ({ available: true, observations: never(), interrupt: async () => ({ outcome: "acknowledged" as const }), close: () => undefined }) }; } });
    host.onRegistered(session, { send: (event) => { events.push(event); return true; } }); host.onCommand(start()); await waitFor(() => authority !== null && events.some((event) => event.event.kind === "started"));
    const decision = authority!({ kind: "permission", interactionRef: "abort", toolName: "Bash", scope: "root", allowSession: false }, controller.signal); await waitFor(() => validations === 6); controller.abort(); releaseValidation(true);
    expect(await decision).toEqual({ kind: "deny" }); expect(events.some((event) => event.event.kind === "interaction_accepted")).toBeFalse(); host.onDisconnected();
  });
});

function fakeLease(): CurrentFolderClaudeLease { const controller = new AbortController(); return Object.freeze({ workingDirectory: "/private/tmp", signal: controller.signal, validate: async () => !controller.signal.aborted, close: async () => { controller.abort(); } }); }
function handle(values: readonly import("@nautilo/claude-agent-sdk-host").ClaudeExecutionObservation[]): ClaudeLaunchHandle { return Object.freeze({ available: true, observations: iterable(values), interrupt: async () => ({ outcome: "acknowledged" as const }), steer: async () => ({ outcome: "accepted" as const }), close: () => undefined }); }
async function* iterable<T>(values: readonly T[]): AsyncIterable<T> { yield* values; }
async function* never<T>(): AsyncIterable<T> {
  await new Promise<never>(() => undefined);
  yield undefined as T;
}
async function tick(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 0)); }
async function waitFor(predicate: () => boolean): Promise<void> { for (let index = 0; index < 50; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 0)); } throw new Error("timed out"); }
