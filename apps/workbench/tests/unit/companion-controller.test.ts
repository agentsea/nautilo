import { describe, expect, test } from "bun:test";
import { initialThreadRoomControllerState, threadRoomReducer } from "../../src/modes/rooms/thread-drawer/thread-room-controller";
import { CompanionController } from "../../src/companion/companion-controller";
import type { CompanionBinding, CompanionOwnerAPI, CompanionSnapshot } from "../../../desktop/electron/companion-contract";
import type { RoomMessageOperations } from "../../src/adapters/room-message-operations";

const binding: CompanionBinding = { roomId: "room-a", agentId: "genie-a", botActorId: "bot-a", name: "Genie" };
const page = { messages: [{ id: "message", role: "assistant", content: "Hello", createdAt: "2026-01-01" }], pageInfo: { hasMoreBefore: true, oldestCursor: null } };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(extra: Partial<ConstructorParameters<typeof CompanionController>[0]> = {}) {
  let snapshot: CompanionSnapshot | null = null;
  let generation = 0;
  let admitted = true;
  let avatar = async (_binding: CompanionBinding): Promise<string | null> => null;
  let read = async (_roomId: string) => page;
  let send = async (_binding: CompanionBinding, _text: string): Promise<unknown> => ({});
  const disabled: string[] = [];
  const published: { generation: string; snapshot: CompanionSnapshot }[] = [];
  const sends: { binding: CompanionBinding; text: string }[] = [];
  const opens: string[] = [];
  const bridge: CompanionOwnerAPI = {
    enable: async () => String(++generation), pickFiles: async () => [],
    disable: async value => { disabled.push(value); },
    publish: async (value, current) => { published.push({ generation: value, snapshot: structuredClone(current) }); },
    onAction: () => () => {}, onClosed: () => () => {},
  };
  const controller = new CompanionController({
    bridge, loadAvatar: target => avatar(target), operations: () => ({ readRoomMessages: (roomId: string) => read(roomId) }) as RoomMessageOperations,
    admitted: () => admitted, changed: value => { snapshot = value; },
    send: async (target, text) => { sends.push({ binding: target, text }); return send(target, text); },
    openRoom: roomId => { opens.push(roomId); },
    ...extra,
  });
  return { controller, bridge, disabled, published, sends, opens, snapshot: () => snapshot,
    setAvatar: (value: typeof avatar) => { avatar = value; },
    setRead: (value: typeof read) => { read = value; }, setSend: (value: typeof send) => { send = value; }, revoke: () => { admitted = false; } };
}

describe("Workbench-owned companion", () => {
  test("a late portrait from the old binding cannot overwrite the newly selected Genie", async () => {
    const f = fixture(); const pending = deferred<string | null>();
    f.setAvatar(() => pending.promise);
    await f.controller.enable(binding);
    f.setAvatar(async () => "data:image/png;base64,TmV3");
    await f.controller.enable({ ...binding, agentId: "genie-b", botActorId: "bot-b", name: "Other Genie" });
    pending.resolve("data:image/png;base64,T2xk"); await Promise.resolve();
    expect(f.snapshot()?.avatarDataUrl).toBe("data:image/png;base64,TmV3");
    expect(f.snapshot()?.binding.agentId).toBe("genie-b");
  });
  test("portrait failure leaves text usable, and Off fences pending image delivery", async () => {
    const f = fixture(); f.setAvatar(async () => { throw new Error("unavailable"); });
    await f.controller.enable(binding);
    expect(f.snapshot()?.avatarDataUrl).toBeNull();
    expect(f.snapshot()?.messages).toHaveLength(1);
    const pending = deferred<string | null>(); f.setAvatar(() => pending.promise);
    await f.controller.action("1", { type: "refresh" }); f.controller.stop();
    const count = f.published.length;
    pending.resolve("data:image/png;base64,T2xk"); await Promise.resolve();
    expect(f.snapshot()).toBeNull(); expect(f.published).toHaveLength(count);
  });
  test("uses the Room projection for empty assistant calls and their tool results", async () => {
    const f = fixture();
    f.setRead(async () => ({ ...page, messages: [
      { id: "call-row", role: "assistant", content: "", createdAt: "2026-01-01", toolCalls: JSON.stringify([{ id: "call-a", name: "read_file", args: { path: "example.txt" } }]) },
      { id: "result-row", role: "tool", content: "Example content", createdAt: "2026-01-01", toolName: "read_file" },
      { id: "reply-row", role: "assistant", content: "**Done**", createdAt: "2026-01-01" },
    ] }));
    await f.controller.enable(binding);
    expect(f.snapshot()?.messages.map(message => message.id)).toEqual(["result-row", "reply-row"]);
    expect(f.snapshot()?.messages[0]?.content).toMatchObject([{ type: "tool-call", toolName: "read_file", result: "Example content" }]);
    expect(f.snapshot()?.messages[1]?.content).toEqual([{ type: "text", text: "**Done**" }]);
  });
  test("pins exact Room/Genie and uses canonical history, including completeness", async () => {
    const f = fixture(); await f.controller.enable(binding);
    expect(f.snapshot()?.messages[0]?.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(f.snapshot()?.hasEarlier).toBe(true);
    await f.controller.action("1", { type: "draft", text: "Hi" });
    await f.controller.action("1", { type: "send", text: "Hi" });
    expect(f.sends).toEqual([{ binding, text: "Hi" }]);
    expect(f.snapshot()?.draft).toBe("");
    await f.controller.action("1", { type: "return" });
    expect(f.opens).toEqual(["room-a"]);
  });
  test("Off fences pending history and clears the private projection", async () => {
    const f = fixture(); const pending = deferred<typeof page>(); f.setRead(() => pending.promise);
    const enabling = f.controller.enable(binding); await Promise.resolve();
    f.controller.stop(); pending.resolve(page); await enabling;
    expect(f.snapshot()).toBeNull(); expect(f.disabled).toContain("1");
    expect(f.published.every(row => row.snapshot.messages.length === 0)).toBe(true);
  });
  test("Off while enable is pending closes only that generation", async () => {
    const f = fixture(); const pending = deferred<string>(); f.bridge.enable = () => pending.promise;
    const enabling = f.controller.enable(binding); f.controller.stop(); pending.resolve("late"); await enabling;
    expect(f.snapshot()).toBeNull(); expect(f.disabled).toContain("late");
  });
  test("a late old send cannot clear or publish into a new binding", async () => {
    const f = fixture(); await f.controller.enable(binding);
    const pending = deferred<unknown>(); f.setSend(() => pending.promise);
    const sending = f.controller.action("1", { type: "send", text: "Old" });
    const next = { ...binding, roomId: "room-b" }; await f.controller.enable(next);
    await f.controller.action("2", { type: "draft", text: "New draft" });
    pending.resolve({}); await sending;
    expect(f.snapshot()?.binding).toEqual(next); expect(f.snapshot()?.draft).toBe("New draft");
    await f.controller.action("1", { type: "send", text: "stale" }); expect(f.sends).toHaveLength(1);
  });
  test("unknown send outcome is never retried automatically", async () => {
    const f = fixture(); await f.controller.enable(binding);
    f.setSend(async () => { throw new Error("transport lost after persistence"); });
    await f.controller.action("1", { type: "draft", text: "Once" });
    await f.controller.action("1", { type: "send", text: "Once" });
    await f.controller.refresh();
    expect(f.sends).toHaveLength(1); expect(f.snapshot()?.draft).toBe("Once");
    expect(f.snapshot()?.error).toContain("could not be confirmed");
  });
  test("preserves edits typed while a send is pending and prevents duplicate submission", async () => {
    const f = fixture(); await f.controller.enable(binding); const pending = deferred<unknown>(); f.setSend(() => pending.promise);
    await f.controller.action("1", { type: "draft", text: "First" });
    const sending = f.controller.action("1", { type: "send", text: "First" });
    await f.controller.action("1", { type: "send", text: "First" });
    await f.controller.action("1", { type: "draft", text: "Second" });
    pending.resolve({}); await sending;
    expect(f.snapshot()?.draft).toBe("Second"); expect(f.sends).toHaveLength(1);
  });
  test("coalesces in-flight Room invalidations and ignores other Rooms", async () => {
    const f = fixture(); await f.controller.enable(binding);
    const pending = deferred<typeof page>(); let reads = 0; f.setRead(() => { reads++; return reads === 1 ? pending.promise : Promise.resolve(page); });
    f.controller.invalidate("other-room"); expect(reads).toBe(0);
    const refreshing = f.controller.refresh(); f.controller.invalidate(binding.roomId); f.controller.invalidate(binding.roomId);
    pending.resolve(page); await refreshing; expect(reads).toBe(2);
  });
  test("revoked admission fences a pending read and future commands", async () => {
    const f = fixture(); await f.controller.enable(binding);
    const pending = deferred<typeof page>(); f.setRead(() => pending.promise);
    const refreshing = f.controller.refresh(); const before = f.published.length;
    f.revoke(); pending.resolve(page); await refreshing;
    await f.controller.action("1", { type: "send", text: "denied" });
    expect(f.published).toHaveLength(before); expect(f.sends).toHaveLength(0);
  });
  test("failed Room read removes cached transcript, and Refresh recovers", async () => {
    const f = fixture(); await f.controller.enable(binding);
    f.setRead(async () => { throw new Error("access unavailable"); }); await f.controller.refresh();
    expect(f.snapshot()?.messages).toEqual([]); expect(f.snapshot()?.error).toContain("Could not read");
    f.setRead(async () => page); await f.controller.refresh(); expect(f.snapshot()?.error).toBeNull();
  });
});

test("file-only send uses uploaded references in the pinned Room and clears only accepted attachments", async () => {
  const sent: unknown[] = [];
  const f = fixture({ canAttach: () => true, upload: async (_file, room) => { expect(room).toBe(binding.roomId); return "upload-a"; },
    send: async (target, text, options) => { sent.push({ target, text, options }); } });
  f.bridge.pickFiles = async () => [{ name: "example.txt", base64: "eA==", sizeBytes: 1 }];
  await f.controller.enable(binding); await f.controller.action("1", { type: "attach" });
  expect(f.snapshot()?.attachments[0]?.status).toBe("ready");
  await f.controller.action("1", { type: "send", text: "" });
  expect(sent).toEqual([{ target: binding, text: "", options: { voiceMode: false, attachments: [{ attachmentId: "upload-a" }] } }]);
  expect(f.snapshot()?.attachments).toEqual([]);
});
test("failed uploads block send and can be removed without losing the draft", async () => {
  const f = fixture({ canAttach: () => true, upload: async () => { throw new Error("offline"); } });
  f.bridge.pickFiles = async () => [{ name: "example.txt", base64: "eA==", sizeBytes: 1 }];
  await f.controller.enable(binding); await f.controller.action("1", { type: "attach" });
  await f.controller.action("1", { type: "draft", text: "Keep me" });
  await f.controller.action("1", { type: "send", text: "Keep me" });
  expect(f.sends).toHaveLength(0); expect(f.snapshot()?.attachments[0]?.status).toBe("error");
  await f.controller.action("1", { type: "remove-attachment", id: f.snapshot()!.attachments[0]!.id });
  expect(f.snapshot()?.draft).toBe("Keep me"); expect(f.snapshot()?.attachments).toEqual([]);
});
test("picker and upload completions cannot cross Off or rebind", async () => {
  const upload = deferred<string>(); const f = fixture({ canAttach: () => true, upload: () => upload.promise });
  f.bridge.pickFiles = async () => [{ name: "example.txt", base64: "eA==", sizeBytes: 1 }];
  await f.controller.enable(binding); const attaching = f.controller.action("1", { type: "attach" }); await Promise.resolve();
  await f.controller.enable({ ...binding, roomId: "room-b" }); upload.resolve("old-upload"); await attaching;
  expect(f.snapshot()?.attachments).toEqual([]);
  const picker = deferred<Awaited<ReturnType<typeof f.bridge.pickFiles>>>(); f.bridge.pickFiles = () => picker.promise;
  const picking = f.controller.action("2", { type: "attach" }); f.controller.stop();
  picker.resolve([{ name: "example.txt", base64: "eA==", sizeBytes: 1 }]); await picking;
  expect(f.snapshot()).toBeNull();
});
test("Stop reaches the Room during a stalled send and also cancels work admitted by its late receipt", async () => {
  const send = deferred<unknown>(); const stopped: string[] = [];
  const f = fixture({ stopTask: async roomId => { stopped.push(roomId); return { stopped: true }; } });
  f.setSend(() => send.promise); await f.controller.enable(binding);
  const sending = f.controller.action("1", { type: "send", text: "Do work" });
  const stopping = f.controller.action("1", { type: "stop-task" });
  expect(stopped).toEqual([binding.roomId]);
  await stopping;
  expect(f.snapshot()?.stopState).toBe("failed");
  expect(f.snapshot()?.error).toContain("message is still being sent");
  send.resolve({}); await sending;
  expect(stopped).toEqual([binding.roomId, binding.roomId]); expect(f.snapshot()?.stopState).toBe("stopped");
  const failed = fixture({ stopTask: async () => { throw new Error("offline"); } }); await failed.controller.enable(binding);
  await failed.controller.action("1", { type: "stop-task" });
  expect(failed.snapshot()?.stopState).toBe("failed"); expect(failed.snapshot()?.error).toContain("could not be confirmed");
});
test("spoken replies follow the pinned voice owner and stop-talking never cancels tasks", async () => {
  let speechStops = 0; let taskStops = 0; let running = true; const modes: boolean[] = [];
  const f = fixture({ media: { prepare() {}, createCapture: () => ({ cancel() {} }) as any, enable() {}, release() {}, stopTalking() { speechStops++; } },
    workRunning: async () => running,
    stopTask: async () => { taskStops++; running = false; return { stopped: true }; },
    send: async (_target, _text, options) => { modes.push(options.voiceMode); } });
  await f.controller.enable(binding); f.controller.updateMedia(binding.roomId, true, true);
  await f.controller.action("1", { type: "stop-talking" }); expect(speechStops).toBe(1); expect(taskStops).toBe(0);
  expect(f.snapshot()?.workRunning).toBe(true);
  // A separate cancel must not invoke the playback stop or hide remaining speech.
  await f.controller.action("1", { type: "stop-task" });
  expect(taskStops).toBe(1); expect(speechStops).toBe(1);
  expect(f.snapshot()?.workRunning).toBe(false); expect(f.snapshot()?.speaking).toBe(true);
  await f.controller.action("1", { type: "send", text: "Hello" });
  f.controller.updateMedia("other-room", true, true); await f.controller.action("1", { type: "send", text: "Hi" });
  expect(modes).toEqual([true, false]);
});

test("speech can be stopped in a silent gap only for the pinned Room", async () => {
  let speechStops = 0;
  const f = fixture({ media: { prepare() {}, createCapture: () => ({ cancel() {} }) as any, enable() {}, release() {}, stopTalking() { speechStops++; } } });
  await f.controller.enable(binding);
  f.controller.updateMedia(binding.roomId, true, false, true);
  expect(f.snapshot()?.speaking).toBe(false);
  expect(f.snapshot()?.canStopTalking).toBe(true);
  await f.controller.action("1", { type: "stop-talking" });
  expect(speechStops).toBe(1);
  f.controller.updateMedia("other-room", true, false, true);
  expect(f.snapshot()?.canStopTalking).toBe(false);
  await f.controller.action("1", { type: "stop-talking" });
  expect(speechStops).toBe(1);
});

test("mic off retains transcription for deliberate Send without changing the sound preference", async () => {
  let starts = 0; let finishes = 0; let voiceEnables = 0; let speechStops = 0;
  let changed!: (state: { state: "listening" | "transcribing" | "idle"; error: null }) => void;
  let result!: (text: string) => void;
  const f = fixture({ media: { prepare() {}, enable() { voiceEnables++; }, release() {}, stopTalking() { speechStops++; },
    createCapture: (onChange, onResult) => {
      changed = onChange; result = onResult;
      return { start() { starts++; changed({ state: "listening", error: null }); }, finish() { finishes++; changed({ state: "transcribing", error: null }); }, cancel() {} } as any;
    },
  } });
  await f.controller.enable(binding);
  await f.controller.action("1", { type: "mic" });
  expect(starts).toBe(1); expect(speechStops).toBe(1); expect(voiceEnables).toBe(1);
  expect(f.snapshot()?.capture).toBe("listening");
  await f.controller.action("1", { type: "mic" });
  expect(finishes).toBe(1); expect(f.snapshot()?.capture).toBe("transcribing");
  changed({ state: "idle", error: null }); result("A spoken message");
  await Promise.resolve();
  expect(f.sends).toEqual([]);
  expect(f.snapshot()?.draft).toBe("A spoken message");
  await f.controller.action("1", { type: "send", text: "A spoken message" });
  expect(f.sends).toEqual([{ binding, text: "A spoken message" }]);
  expect(f.snapshot()?.voiceEnabled).toBe(false);
});

test("dictation retains a typed draft for review and late transcription cannot reach a new binding", async () => {
  const results: ((text: string) => void)[] = [];
  let cancels = 0;
  const f = fixture({ media: { prepare() {}, enable() {}, release() {}, stopTalking() {},
    createCapture: (_changed, result) => { results.push(result); return { cancel() { cancels++; } } as any; },
  } });
  await f.controller.enable(binding);
  await f.controller.action("1", { type: "draft", text: "Unsent idea" });
  results[0]!("More context");
  expect(f.snapshot()?.draft).toBe("Unsent idea\nMore context");
  expect(f.snapshot()?.draftRevision).toBe(1); expect(f.sends).toHaveLength(0);
  await f.controller.enable({ ...binding, roomId: "room-b" });
  results[0]!("Old result");
  expect(f.snapshot()?.draft).toBe(""); expect(f.sends).toHaveLength(0); expect(cancels).toBeGreaterThan(0);
});

 test("Off fences the follow-up stop for a late send receipt", async () => {
  const send = deferred<unknown>(); const stopped: string[] = [];
  const f = fixture({ stopTask: async roomId => { stopped.push(roomId); return { stopped: true }; } });
  f.setSend(() => send.promise); await f.controller.enable(binding);
  const sending = f.controller.action("1", { type: "send", text: "Do work" });
  await f.controller.action("1", { type: "stop-task" });
  await f.controller.enable({ ...binding, roomId: "room-b" });
  send.resolve({}); await sending;
  expect(stopped).toEqual([binding.roomId]);
  expect(f.snapshot()?.binding.roomId).toBe("room-b");
});

test("an older stop response cannot overwrite the stop after send admission", async () => {
  const send = deferred<unknown>(); const initialStop = deferred<{ stopped: boolean }>();
  let count = 0;
  const f = fixture({ stopTask: async () => ++count === 1 ? initialStop.promise : { stopped: true } });
  f.setSend(() => send.promise); await f.controller.enable(binding);
  const sending = f.controller.action("1", { type: "send", text: "Do work" });
  const stopping = f.controller.action("1", { type: "stop-task" });
  send.resolve({}); await sending;
  expect(f.snapshot()?.stopState).toBe("stopped");
  initialStop.reject(new Error("late failure")); await stopping;
  expect(f.snapshot()?.stopState).toBe("stopped");
  expect(f.snapshot()?.error).toBeNull();
});

test("follow-up Stop does not hide an ambiguous send outcome", async () => {
  const send = deferred<unknown>();
  const f = fixture({ stopTask: async () => ({ stopped: true }) });
  f.setSend(() => send.promise); await f.controller.enable(binding);
  const sending = f.controller.action("1", { type: "send", text: "Do work" });
  await f.controller.action("1", { type: "stop-task" });
  send.reject(new Error("connection lost")); await sending;
  expect(f.snapshot()?.stopState).toBe("stopped");
  expect(f.snapshot()?.error).toContain("Send could not be confirmed");
  expect(f.sends).toHaveLength(1);
});

describe("companion shared Room live projection", () => {
  const tokens = (content: string, done = false) => ({ type: "message.tokens" as const, laneKey: "room:room-a", content, done, turnId: "turn-a", authorAgentId: "genie-a" });
  test("outgoing message is visible before send acknowledgement and reconciles an early echo once", async () => {
    const f = fixture(); await f.controller.enable(binding);
    const pending = deferred<unknown>(); f.setSend(() => pending.promise);
    const sending = f.controller.action("1", { type: "send", text: "Hello there" });
    expect(f.snapshot()?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Hello there" }]);
    expect(f.snapshot()?.messages.at(-1)?.metadata?.custom?.optimisticRequestId).toBeString();
    f.controller.ingestEvent("room-a", { type: "message.new", laneKey: "room:room-a", messageId: "42", role: "user", content: "Hello there" });
    pending.resolve({ messageId: 42 }); await sending;
    expect(f.snapshot()?.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(f.snapshot()?.messages.at(-1)?.id).toBe("42");
    expect(f.snapshot()?.messages.at(-1)?.metadata?.custom?.optimisticRequestId).toBeUndefined();
  });
  test("live tokens appear immediately without reloading history and survive an in-flight older page", async () => {
    const f = fixture(); await f.controller.enable(binding);
    const pending = deferred<typeof page>(); f.setRead(() => pending.promise);
    const refresh = f.controller.refresh();
    f.controller.ingestEvent("room-a", tokens("Live "));
    expect(f.snapshot()?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Live " }]);
    f.controller.ingestEvent("room-a", tokens("reply"));
    pending.resolve(page); await refresh;
    expect(f.snapshot()?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Live reply" }]);
    f.controller.ingestEvent("room-a", tokens("", true));
    f.controller.ingestEvent("room-a", { type: "message.new", laneKey: "room:room-a", messageId: "43", role: "ai", content: "Live reply", authorAgentId: "genie-a" });
    expect(f.snapshot()?.messages).toHaveLength(2);
    expect(f.snapshot()?.messages.at(-1)?.id).toBe("43");
  });
  test("an unrelated Room or revoked binding cannot display incoming text", async () => {
    const f = fixture(); await f.controller.enable(binding);
    f.controller.ingestEvent("other-room", tokens("Wrong room"));
    expect(f.snapshot()?.messages).toHaveLength(1);
    f.revoke(); f.controller.ingestEvent("room-a", tokens("Revoked"));
    expect(f.snapshot()?.messages).toHaveLength(1);
    f.controller.stop(); f.controller.ingestEvent("room-a", tokens("Closed"));
    expect(f.snapshot()).toBeNull();
  });
  test("history arriving before a send receipt does not duplicate the pending message", async () => {
    const f = fixture(); await f.controller.enable(binding);
    const pending = deferred<unknown>(); f.setSend(() => pending.promise);
    const sending = f.controller.action("1", { type: "send", text: "Pending" });
    f.setRead(async () => ({ ...page, messages: [...page.messages, { id: "44", role: "user", content: "Pending", createdAt: "2026-01-02" }] }));
    await f.controller.refresh();
    expect(f.snapshot()?.messages.filter(message => message.role === "user")).toHaveLength(1);
    pending.resolve({ messageId: 44 }); await sending;
    expect(f.snapshot()?.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(f.snapshot()?.messages.at(-1)?.id).toBe("44");
  });
  test("a completed stream is not swallowed by an older identical reply or a Human message", async () => {
    const f = fixture(); await f.controller.enable(binding);
    f.controller.ingestEvent("room-a", tokens("Hello", true));
    await f.controller.refresh();
    expect(f.snapshot()?.messages).toHaveLength(2);
    f.controller.ingestEvent("room-a", { type: "message.new", laneKey: "room:room-a", messageId: "45", role: "user", content: "Next question" });
    expect(f.snapshot()?.messages).toHaveLength(3);
    expect(f.snapshot()?.messages.filter(message => message.role === "assistant")).toHaveLength(2);
  });
  test("an uncertain send remains visible, marked unconfirmed, and is not retried", async () => {
    const f = fixture(); await f.controller.enable(binding);
    f.setSend(async () => { throw new Error("connection lost"); });
    await f.controller.action("1", { type: "send", text: "Keep this visible" });
    expect(f.snapshot()?.messages.at(-1)?.metadata?.custom?.sendFailed).toBe(true);
    expect(f.snapshot()?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Keep this visible" }]);
    expect(f.sends).toHaveLength(1);
  });
  test("a persisted tool result replaces the live tool card rather than duplicating it", async () => {
    const f = fixture(); await f.controller.enable(binding);
    f.controller.ingestEvent("room-a", { type: "tool.start", laneKey: "room:room-a", toolCallId: "call-1", toolName: "read_file" });
    f.setRead(async () => ({ ...page, messages: [
      ...page.messages,
      { id: "call-row", role: "assistant", content: "", createdAt: "2026-01-02", toolCalls: JSON.stringify([{ id: "call-1", name: "read_file", args: {} }]) },
      { id: "result-row", role: "tool", content: "Result", createdAt: "2026-01-02", toolName: "read_file" },
    ] }));
    await f.controller.refresh();
    expect(f.snapshot()?.messages.filter(message => Array.isArray(message.content) && message.content.some(part => part.type === "tool-call"))).toHaveLength(1);
  });
});

test("companion keeps separate assistant messages in the same turn until their own durable rows arrive", async () => {
  const f = fixture(); await f.controller.enable(binding);
  for (const [key, content] of [["first", "First sentence"], ["second", "Second sentence"]]) {
    f.controller.ingestEvent("room-a", { type: "message.tokens", laneKey: "room:room-a", turnId: "one-turn", assistantMessageKey: key, authorAgentId: "genie-a", content, done: true });
  }
  f.controller.ingestEvent("room-a", { type: "message.new", laneKey: "room:room-a", messageId: "77", role: "ai", content: "Second sentence", assistantMessageKey: "second", authorAgentId: "genie-a" });
  expect(f.snapshot()?.messages).toHaveLength(3);
  expect(f.snapshot()?.messages[1]?.content).toEqual([{ type: "text", text: "First sentence" }]);
  expect(f.snapshot()?.messages[2]?.id).toBe("77");
});

test("an identical new draft survives the preceding send receipt", async () => {
  const f = fixture(); await f.controller.enable(binding);
  await f.controller.action("1", { type: "draft", text: "Again" });
  const pending = deferred<unknown>(); f.setSend(() => pending.promise);
  const sending = f.controller.action("1", { type: "send", text: "Again" });
  expect(f.snapshot()?.draft).toBe("");
  await f.controller.action("1", { type: "draft", text: "Again" });
  pending.resolve({ messageId: 78 }); await sending;
  expect(f.snapshot()?.draft).toBe("Again");
});


test("sound toggles use the shared preference without changing capture or cancelling work", async () => {
  const preferences: boolean[] = []; let cancels = 0; let taskStops = 0;
  const f = fixture({ media: {
    prepare() {}, enable() {}, release() {}, stopTalking() {},
    setEnabled(enabled) { preferences.push(enabled); },
    createCapture: () => ({ cancel() { cancels++; } }) as any,
  }, workRunning: async () => true, stopTask: async () => { taskStops++; return { stopped: true }; } });
  await f.controller.enable(binding);
  f.controller.updateMedia(binding.roomId, true, true);
  await f.controller.action("1", { type: "sound", enabled: false });
  expect(preferences).toEqual([false]);
  expect(cancels).toBe(0); expect(taskStops).toBe(0);
  f.controller.updateMedia(binding.roomId, false, false);
  expect(f.snapshot()?.voiceEnabled).toBe(false);
  expect(f.snapshot()?.workRunning).toBe(true);
  await f.controller.action("stale", { type: "sound", enabled: true });
  expect(preferences).toEqual([false]);
});

// Exercise the real capture lifecycle: microphone release, transcription and
// cancellation must agree with the controller's send intent.
import { SpeechCapture } from "../../src/lib/speech-capture";
const settleCapture = () => new Promise(resolve => setTimeout(resolve, 0));
function voiceFixture() {
  const transcription = deferred<string>();
  const delivery = deferred<unknown>();
  const sent: { text: string; options: unknown }[] = [];
  let stoppedTracks = 0; let interrupted = 0;
  const f = fixture({
    canAttach: () => true, upload: async () => "upload-a",
    send: async (_binding, text, options) => { sent.push({ text, options }); return delivery.promise; },
    media: {
      prepare() {}, enable() {}, release() {}, stopTalking() { interrupted++; },
      createCapture: (changed, result) => new SpeechCapture({
        permission: async () => {},
        stream: async () => ({ getTracks: () => [{ stop() { stoppedTracks++; } }] }) as unknown as MediaStream,
        recorder: () => {
          const recorder = { state: "inactive", mimeType: "audio/webm", onstop: null as null | (() => void),
            ondataavailable: null as null | ((event: { data: Blob }) => void), onerror: null,
            start() { this.state = "recording"; },
            stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["audio"]) }); this.onstop?.(); } };
          return recorder as unknown as MediaRecorder;
        },
        transcribe: () => transcription.promise,
      }, changed, result),
    },
  });
  return { ...f, transcription, delivery, sent, stoppedTracks: () => stoppedTracks, interrupted: () => interrupted };
}

test("two bubble taps submit only speech, preserve panel draft/files, and reject duplicate pending taps", async () => {
  const f = voiceFixture();
  f.bridge.pickFiles = async () => [{ name: "example.txt", base64: "eA==", sizeBytes: 1 }];
  await f.controller.enable(binding);
  await f.controller.action("1", { type: "draft", text: "Unsent panel draft" });
  await f.controller.action("1", { type: "attach" });
  await f.controller.action("1", { type: "talk" }); await settleCapture();
  expect(f.snapshot()?.capture).toBe("listening"); expect(f.interrupted()).toBe(1);
  await f.controller.action("1", { type: "talk" });
  expect(f.snapshot()?.capture).toBe("transcribing"); expect(f.stoppedTracks()).toBeGreaterThan(0);
  await f.controller.action("1", { type: "talk" });
  await f.controller.action("1", { type: "view", value: "chat" });
  f.transcription.resolve("Spoken turn"); await settleCapture();
  expect(f.sent).toEqual([{ text: "Spoken turn", options: { voiceMode: false, attachments: [] } }]);
  expect(f.snapshot()?.draft).toBe("Unsent panel draft"); expect(f.snapshot()?.attachments).toHaveLength(1);
  expect(f.snapshot()?.busy).toBe(true);
  await f.controller.action("1", { type: "talk" }); expect(f.interrupted()).toBe(1);
  f.delivery.resolve({}); await settleCapture();
  expect(f.sent).toHaveLength(1); expect(f.snapshot()?.attachments).toHaveLength(1);
  f.controller.stop();
});

test("panel dictation stays a draft even when the view changes to bubble during transcription", async () => {
  const f = voiceFixture(); await f.controller.enable(binding);
  await f.controller.action("1", { type: "mic" }); await settleCapture();
  await f.controller.action("1", { type: "mic" });
  await f.controller.action("1", { type: "view", value: "orb" });
  f.transcription.resolve("Review me"); await settleCapture();
  expect(f.sent).toHaveLength(0); expect(f.snapshot()?.draft).toBe("Review me");
  f.controller.stop();
});

test("Escape and Off fence late bubble transcription without sending or retaining discarded audio", async () => {
  for (const off of [false, true]) {
    const f = voiceFixture(); await f.controller.enable(binding);
    await f.controller.action("1", { type: "talk" }); await settleCapture();
    await f.controller.action("1", { type: "talk" });
    if (off) f.controller.stop(); else await f.controller.action("1", { type: "mute" });
    f.transcription.resolve("Discard me"); await settleCapture();
    expect(f.sent).toHaveLength(0); expect(f.snapshot()?.draft ?? "").toBe("");
    f.controller.stop();
  }
});

test("unconfirmed bubble send saves speech beside the pending draft and does not retry", async () => {
  const f = voiceFixture(); await f.controller.enable(binding);
  await f.controller.action("1", { type: "draft", text: "Keep me" });
  await f.controller.action("1", { type: "talk" }); await settleCapture();
  await f.controller.action("1", { type: "talk" });
  f.transcription.resolve("Check me"); await settleCapture();
  f.delivery.reject(new Error("Transport lost")); await settleCapture();
  expect(f.snapshot()?.draft).toBe("Keep me\nCheck me"); expect(f.snapshot()?.sendUncertain).toBe(true);
  await f.controller.action("1", { type: "talk" }); await f.controller.refresh();
  expect(f.sent).toHaveLength(1); expect(f.snapshot()?.capture).toBe("idle");
  f.controller.stop();
});


test("shared Room history failure becomes visible and cannot overwrite another Room", () => {
  const opening = threadRoomReducer(initialThreadRoomControllerState, {
    type: "open", roomId: "room-a", visible: true, connected: true,
  });
  const failed = threadRoomReducer(opening, { type: "hydrate.failed", roomId: "room-a", error: "History unavailable" });
  expect(failed.phase).toBe("error"); expect(failed.error).toBe("History unavailable");
  expect(threadRoomReducer(opening, { type: "hydrate.failed", roomId: "room-b", error: "Stale" })).toBe(opening);
});
