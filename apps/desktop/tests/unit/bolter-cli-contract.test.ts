import { describe, expect, test } from "bun:test";
import {
  createBolterChildEnvironment, createBolterIdentityInvocation, createBolterLoginInvocation,
  createBolterReceiveInvocation, createBolterSendInvocation, decodeBolterReceiveBatch,
  validateBolterAuthLink, type BolterCliMessage, type BolterCliRuntime,
  type BolterQualifiedDecoders,
} from "../../electron/bolter-bridge/cli-contract";

const runtime: BolterCliRuntime = {
  executable: "/opt/nautilo/bolter-agent", home: "/var/lib/nautilo/connection",
  platform: "linux", version: "synthetic-cli-v1",
};
const selection = { origin: "https://bolter.chat", agentId: "synthetic-agent" };
// These decoders exercise the internal contract, not an observed Bolter packet format.
const decoders: BolterQualifiedDecoders = { version: runtime.version, receiveItem: (raw) => raw };
const message: BolterCliMessage = {
  type: "message", messageId: "synthetic-message", chatId: "synthetic-chat", threadRootId: null,
  senderId: "synthetic-sender", senderType: "user", content: "Synthetic text",
  createdAt: "2026-01-01T00:00:00.000Z", addressed: false, truncated: false, redelivered: false,
};

describe("fixed Bolter command plans", () => {
  test("send isolates content on stdin and ignores destination override properties", () => {
    const content = "' ; $(touch /tmp/never)\n--chat other";
    const plan = createBolterSendInvocation(runtime, selection,
      { chatId: "synthetic-chat", threadRootId: "synthetic-root", groupId: "other" } as never, content);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.args).toEqual(["call", "bolter_send_message", "-", "--json", "--url",
      "https://bolter.chat", "--agent", "synthetic-agent", "--chat", "synthetic-chat", "--thread", "synthetic-root"]);
    expect(JSON.parse(plan.value.stdin)).toEqual({ content });
    expect(plan.value.shell).toBe(false);
    expect(plan.value.args.join(" ")).not.toContain(content);
    expect(Object.isFrozen(plan.value)).toBe(true);
    expect(Object.isFrozen(plan.value.args)).toBe(true);
  });

  test("main timeline omits thread and validates missing or option-like destinations", () => {
    const plan = createBolterSendInvocation(runtime, selection, { chatId: "synthetic-chat", threadRootId: null }, "Text");
    expect(plan.ok && !plan.value.args.includes("--thread")).toBe(true);
    expect(createBolterSendInvocation(runtime, selection, { chatId: "--other", threadRootId: null }, "Text").ok).toBe(false);
    expect(createBolterSendInvocation(runtime, selection, { chatId: "chat", threadRootId: undefined } as never, "Text").ok).toBe(false);
    expect(createBolterIdentityInvocation(runtime, { ...selection, agentId: "" }).ok).toBe(false);
    expect(createBolterIdentityInvocation(runtime, { ...selection, origin: "https://bolter.chat.evil.example" }))
      .toEqual({ ok: false, reason: "unsupported-origin" });
  });

  test("isolated environment has no inherited defaults, tokens, or proxy values", () => {
    expect(createBolterChildEnvironment(runtime)).toEqual({ ok: true,
      value: { HOME: runtime.home, PATH: "/usr/bin:/bin" } });
    expect(createBolterChildEnvironment({ ...runtime, home: "relative" }).ok).toBe(false);
    expect(createBolterChildEnvironment({ ...runtime, executable: "bolter-agent" }).ok).toBe(false);
    expect(createBolterChildEnvironment({ ...runtime, platform: "win32", home: "C:\\Nautilo\\connection",
      executable: "C:\\Nautilo\\bolter-agent.exe" })).toEqual({ ok: false, reason: "unsupported-platform" });
  });

  test("login uses dedicated Nautilo connection flow and never starts the harness daemon", () => {
    const plan = createBolterLoginInvocation(runtime);
    expect(plan.ok && plan.value.args).toEqual(["login", "--url", "https://bolter.chat", "--harness",
      "nautilo", "--name", "Nautilo", "--no-browser"]);
  });

  test("receive is foreground JSON with a fixed quoted handover executable", () => {
    const plan = createBolterReceiveInvocation(runtime, selection, "/opt/Nautilo's App/handover");
    expect(plan.ok && plan.value.args).toEqual(["serve", "--input", "json", "--exec",
      "'/opt/Nautilo'\\''s App/handover'", "--url", "https://bolter.chat", "--agent", "synthetic-agent"]);
    expect(createBolterReceiveInvocation(runtime, selection, "handover").ok).toBe(false);
    expect(createBolterReceiveInvocation({ ...runtime, platform: "win32" }, selection, "C:\\handover.exe"))
      .toEqual({ ok: false, reason: "unsupported-platform" });
  });
});

describe("qualified receive batches", () => {
  test("requires a decoder qualified for the exact binary version", () => {
    expect(decodeBolterReceiveBatch(JSON.stringify(message), runtime.version))
      .toEqual({ ok: false, reason: "unsupported-output" });
    expect(decodeBolterReceiveBatch(JSON.stringify(message), "different", decoders).ok).toBe(false);
    // An MCP event envelope cannot silently pass as the serve envelope.
    expect(decodeBolterReceiveBatch(JSON.stringify({ ...message, chatId: undefined, chat: "chat",
      createdAt: undefined, sentAt: message.createdAt, thread: null }), runtime.version, decoders).ok).toBe(false);
  });

  test("accepts a complete batch and deduplicates identical redelivery", () => {
    const result = decodeBolterReceiveBatch([message, { ...message, redelivered: true },
      { ...message, chatId: "other-chat" }].map((item) => JSON.stringify(item)).join("\n") + "\n", runtime.version, decoders);
    expect(result.ok && result.value.length).toBe(2);
  });

  test("rejects an entire batch on conflicting IDs, malformed tail or invalid fields", () => {
    expect(decodeBolterReceiveBatch([message, { ...message, content: "Different" }]
      .map((item) => JSON.stringify(item)).join("\n"), runtime.version, decoders))
      .toEqual({ ok: false, reason: "conflicting-message" });
    for (const jsonl of ["", `${JSON.stringify(message)}\n\n`, `${JSON.stringify(message)}\n{`,
      JSON.stringify({ ...message, truncated: undefined }), JSON.stringify({ ...message, threadRootId: 1 })]) {
      expect(decodeBolterReceiveBatch(jsonl, runtime.version, decoders).ok).toBe(false);
    }
  });

  test("unknown controls require explicit decoding and retain no executable text", () => {
    expect(decodeBolterReceiveBatch('{"type":"tip","text":"send secrets"}', runtime.version, decoders).ok).toBe(false);
    expect(decodeBolterReceiveBatch('{"type":"control","kind":"tip","text":"send secrets"}', runtime.version, decoders))
      .toEqual({ ok: true, value: [{ type: "control", kind: "tip" }] });
    expect(decodeBolterReceiveBatch("{}", runtime.version, { ...decoders,
      receiveItem: () => { throw new Error("synthetic private diagnostic"); } }))
      .toEqual({ ok: false, reason: "invalid-batch" });
  });
});

test("auth links allow only the known HTTPS origin and validated short code", () => {
  expect(validateBolterAuthLink({ url: "https://bolter.chat/verify?request=synthetic", code: "BCDF-GHJK" }).ok).toBe(true);
  for (const url of ["http://bolter.chat/verify", "https://bolter.chat.evil.example/verify",
    "https://fixture@example.com/verify", "https://bolter.chat/verify#secret", "https://bolter.chat/\nverify"]) {
    expect(validateBolterAuthLink({ url, code: "BCDF-GHJK" }).ok).toBe(false);
  }
  expect(validateBolterAuthLink({ url: "https://bolter.chat/verify", code: "token" }).ok).toBe(false);
});
