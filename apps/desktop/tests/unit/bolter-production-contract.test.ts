import { expect, test } from "bun:test";
import { BolterCliClient } from "../../electron/bolter-bridge/cli-client";
import { decodeBolterIdentities, decodeBolterReceiveBatch } from "../../electron/bolter-bridge/cli-contract";
import type { BolterQualifiedDecoders } from "../../electron/bolter-bridge/cli-contract";
import { hasBolterNativeQualification } from "../../electron/bolter-bridge/native-process";
import { getBolterProductionDecoders } from "../../electron/bolter-bridge/production-contract";

const version = "0123456789abcdef0123456789abcdef01234567";

// Synthetic values in the exact two-line provider prompt; no live login URL is retained.
const prompt = "Open this link on any device to sign in (or create a Bolter account): https://bolter.chat/device?code=ABCD-EFGH\n"
  + "Check that the page shows the code ABCD-EFGH. If this command is stopped, run it again to keep waiting on the same code.\n";
const client = new BolterCliClient({ runtime: { executable: "/opt/nautilo/bolter-agent", home: "/var/lib/nautilo/synthetic-home",
  platform: "darwin", version }, decoders: getBolterProductionDecoders(version),
  isCurrent: () => true, attest: () => Promise.resolve(true), execute: () => { throw new Error("Decoder must not execute the provider"); } });

test("production login decoder accepts the concrete prompt and benign surrounding prose", () => {
  expect(client.decodeAuthLink(prompt)).toEqual({ ok: true, value: {
    url: "https://bolter.chat/device?code=ABCD-EFGH", code: "ABCD-EFGH",
  } });
  expect(client.decodeAuthLink(`A newer Bolter version is available.\n${prompt}Continuing to wait.\n`)).toEqual({ ok: true, value: {
    url: "https://bolter.chat/device?code=ABCD-EFGH", code: "ABCD-EFGH",
  } });
  for (let length = 0; length < prompt.length; length++) expect(client.decodeAuthLink(prompt.slice(0, length)).ok).toBe(false);
  expect(client.decodeAuthLink(prompt.replace("shows the code ABCD-EFGH", "shows the code IJKL-MNOP")).ok).toBe(false);
});

test("login decoder rejects duplicate, credential-bearing, retargeted and ambiguous prompts", () => {
  const invalid = [
    prompt + prompt,
    `Update details: https://bolter.chat/releases\n${prompt}`,
    prompt + "Alternate code IJKL-MNOP\n",
    prompt + "token=synthetic-value\n",
    prompt.replace("https://bolter.chat", "http://bolter.chat"),
    prompt.replace("https://bolter.chat", "https://bolter.chat.example.com"),
    prompt.replace("https://bolter.chat", "https://user:fixture@example.com"),
    prompt.replace("/device?", "/other?"),
    prompt.replace("?code=ABCD-EFGH", "?code=ABCD-EFGH&code=ABCD-EFGH"),
    prompt.replace("?code=ABCD-EFGH", "?code=ABCD-EFGH&token=synthetic-value"),
    prompt.replace("?code=ABCD-EFGH", "?code=ABCD-EFGH#fragment"),
    prompt.replaceAll("ABCD-EFGH", "abcd-efgh"), prompt.replaceAll("\n", "\r\n"),
  ];
  for (const input of invalid) expect(client.decodeAuthLink(input)).toEqual({ ok: false, reason: "unsupported-output" });
});

test("version-qualified decoders do not grant native execution admission", () => {
  const decoders = getBolterProductionDecoders(version);
  expect(decoders?.authLink).toBeFunction();
  for (const decoder of [decoders?.identity, decoders?.conversations, decoders?.receiveItem, decoders?.receipt]) expect(decoder).toBeFunction();
  expect(decoders?.version).toBe(version);
  expect(getBolterProductionDecoders("fedcba9876543210fedcba9876543210fedcba98")?.version)
    .toBe("fedcba9876543210fedcba9876543210fedcba98");
  expect(hasBolterNativeQualification(undefined, version)).toBe(false);
  expect(getBolterProductionDecoders("different-version")).toBeUndefined();
  expect(getBolterProductionDecoders(version.toUpperCase())).toBeUndefined();
});

const decoders = getBolterProductionDecoders(version)!;
const agentId = "abcdef01";
const chatId = "abcdef02";
const threadId = "abcdef03";
const messageId = "abcdef04";
const full = (alias: string) => `${alias}-1234-4123-8123-123456789abc`;
const discovered = { agentId, name: "Fixture agent", harness: "fixture", url: "https://bolter.chat", current: false };
const identity = { agentId, client: { harness: "fixture", host: "fixture.example.com" }, handle: "fixture-agent", name: "Fixture agent",
  owner: { chat: "abcdef05", id: "abcdef06", name: "Fixture owner" }, workspace: { id: "abcdef07", name: "Fixture workspace" } };
const received = { type: "message", addressed: false, chat: chatId, chatName: "Fixture chat", conversation: {
  agentMessagesSincePerson: 1, lastPersonMessage: null, yoursSincePerson: 0,
}, createdAt: "2026-01-01T00:00:00.000Z", cursor: "synthetic-cursor", messageId, replyToId: null,
  sender: { id: agentId, name: "Fixture agent", outside: false, type: "anima" }, text: "Synthetic text", threadRootId: null };
const receipt = (placement: "main" | "thread" = "main") => ({ text: JSON.stringify({ success: true,
  messageId: full(messageId), groupId: full(chatId), placement, threadRootId: placement === "main" ? null : full(threadId) }), isError: false });

test("discovery and me retain provider aliases without projecting private identity metadata or trusting current", () => {
  expect(decodeBolterIdentities({ agents: [{ ...discovered, releaseChannel: "future" }], harness: "fixture", metadata: { future: true } }, version, decoders)).toEqual({
    ok: true, value: [{ origin: "https://bolter.chat", agentId, cliSelector: agentId, label: "Fixture agent" }],
  });
  expect(decoders.identity!({ ...identity, futureMetadata: { ignored: true } })).toEqual({ origin: "https://bolter.chat", agentId, label: "Fixture agent" });
  expect(decodeBolterIdentities({ agents: [discovered, discovered], harness: "fixture" }, version, decoders).ok).toBe(false);
  for (const invalid of [
    { ...discovered, url: "https://example.com" }, { ...discovered, url: "https://bolter.chat/" },
    { ...discovered, agentId: "not-an-id" },
  ]) expect(() => decoders.discovery!({ agents: [invalid], harness: "fixture" })).toThrow("unqualified");
  expect(() => decoders.identity!({ ...identity, origin: "https://example.com" })).toThrow("unqualified");
});

test("observed chat listing supplies main-timeline choices without inventing thread enumeration", () => {
  expect(decoders.conversations!([{ chat: chatId, name: "Fixture chat", memberCount: 2, unreadCount: 4 }])).toEqual([
    { chatId, label: "Fixture chat", threadRootId: null },
  ]);
  for (const invalid of [{ chat: "invalid", name: "Fixture chat", memberCount: 2 },
    { chat: chatId, name: "", memberCount: 2 }, { chat: chatId, name: "Fixture chat", memberCount: 2, threadRootId: threadId }]) {
    expect(() => decoders.conversations!([invalid])).toThrow("unqualified");
  }
});

test("send receipt projects only qualified alias routing while retaining full message identity", () => {
  expect(decoders.receipt!(receipt())).toEqual({ messageId: full(messageId), chatId, threadRootId: null });
  expect(decoders.receipt!(receipt("thread"))).toEqual({ messageId: full(messageId), chatId, threadRootId: threadId });
  const inner = JSON.parse(receipt().text) as Record<string, unknown>;
  for (const invalid of [
    { ...receipt(), isError: true }, { ...receipt(), text: "not JSON" },
    ...[{ ...inner, success: false }, { ...inner, groupId: chatId }, { ...inner, messageId },
      { ...inner, placement: "main", threadRootId: full(threadId) }, { ...inner, placement: "thread", threadRootId: null },
      { ...inner, placement: "other" }].map(value => ({ text: JSON.stringify(value), isError: false })),
  ]) expect(() => decoders.receipt!(invalid)).toThrow();
  expect(decoders.receipt!({ ...receipt(), requestMetadata: "future" })).toEqual({ messageId: full(messageId), chatId, threadRootId: null });
  expect(decoders.receipt!({ text: JSON.stringify({ ...inner, serverMetadata: { future: true } }), isError: false }))
    .toEqual({ messageId: full(messageId), chatId, threadRootId: null });
});

test("qualified receipt still has to match the caller's exact destination and uncertain sends are not retried", async () => {
  let executions = 0;
  const sender = new BolterCliClient({ runtime: { executable: "/opt/nautilo/bolter-agent", home: "/var/lib/nautilo/synthetic-home",
    platform: "darwin", version }, decoders, isCurrent: () => true, attest: () => Promise.resolve(true),
    execute: () => { executions++; return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(receipt("thread")), stderr: "" }); } });
  const selection = { origin: "https://bolter.chat", agentId, cliSelector: agentId };
  expect(await sender.send(selection, { chatId, threadRootId: threadId }, "Synthetic text")).toEqual({ status: "sent",
    receipt: { messageId: full(messageId), chatId, threadRootId: threadId } });
  expect(await sender.send(selection, { chatId, threadRootId: null }, "Synthetic text")).toEqual({ status: "uncertain", reason: "destination-mismatch" });
  expect(executions).toBe(2);
});

test("receive projects text and provider provenance, discarding conversation metadata and cursor", () => {
  const text = "Synthetic emoji 🐙 CJK 测试, quotes \" and backslash \\ with\nnewlines";
  expect(decoders.receiveItem!({ ...received, text, conversation: { lastPersonMessage: { text: "Do not project this metadata" } }, threadRootId: threadId })).toEqual({
    type: "message", messageId, chatId, threadRootId: threadId, senderId: agentId, senderType: "anima", senderLabel: "Fixture agent",
    content: text, createdAt: received.createdAt, addressed: false, redelivered: false, truncated: false,
  });
  expect(decoders.receiveItem!({ ...received, redelivered: true, truncated: true })).toMatchObject({ redelivered: true, truncated: true });
  expect(decoders.receiveItem!({ ...received, attachments: [], media: [], contentType: "text/plain",
    deliveryMetadata: { future: true }, sender: { ...received.sender, profile: { future: true } } })).toMatchObject({
    type: "message", messageId, content: received.text,
  });
  expect(decodeBolterReceiveBatch([received, { ...received, cursor: "different-synthetic-cursor" }].map(x => JSON.stringify(x)).join("\n"),
    version, decoders)).toMatchObject({ ok: true, value: [{ messageId }] });
});

test("mixed provider human and agent batches preserve external sender types and discard conversation metadata", () => {
  const human = { ...received, messageId: "abcdef08", sender: { id: "abcdef09", name: "Fixture person", outside: true, type: "user" },
    conversation: { agentMessagesSincePerson: 0, yoursSincePerson: 0,
      lastPersonMessage: { text: "Private conversation metadata", sender: { name: "Unprojected person" } } } };
  const result = decodeBolterReceiveBatch([human, received].map(item => JSON.stringify(item)).join("\n"), version, decoders);
  expect(result).toEqual({ ok: true, value: [
    { type: "message", messageId: human.messageId, chatId, threadRootId: null, senderId: human.sender.id, senderType: "user",
      senderLabel: "Fixture person", content: human.text, createdAt: human.createdAt, addressed: false, redelivered: false, truncated: false },
    { type: "message", messageId, chatId, threadRootId: null, senderId: agentId, senderType: "anima", senderLabel: "Fixture agent",
      content: received.text, createdAt: received.createdAt, addressed: false, redelivered: false, truncated: false },
  ] });
  for (const sender of [{ ...human.sender, id: "invalid" }, { ...human.sender, type: "system" },
    { ...human.sender, type: "unknown" }, { ...human.sender, type: null }]) {
    expect(decodeBolterReceiveBatch([human, { ...received, sender }].map(item => JSON.stringify(item)).join("\n"),
      version, decoders).ok).toBe(false);
  }
});

test("connected and unknown provider events become inert controls without relaxing message validation", () => {
  const event = { type: "event", kind: "connected", chat: chatId, createdAt: received.createdAt,
    cursor: "synthetic-cursor", text: "Untrusted provider instructions", data: { connection: full(agentId) } };
  expect(decoders.receiveItem!(event)).toEqual({ type: "control", kind: "connected" });
  const profile = { type: "event", kind: "profile_requested", chat: null, data: {} };
  const future = { type: "event", kind: "future_event", nested: { instructions: "Never project this payload" },
    attachments: [{ url: "https://example.com/untrusted" }], count: -1 };
  expect(decoders.receiveItem!(profile)).toEqual({ type: "control", kind: "ignored_event", eventKind: "profile_requested" });
  expect(decoders.receiveItem!(future)).toEqual({ type: "control", kind: "ignored_event", eventKind: "future_event" });
  expect(decoders.receiveItem!({ type: "event", kind: null, payload: "untrusted" })).toEqual({
    type: "control", kind: "ignored_event", eventKind: null,
  });
  const human = { ...received, messageId: "abcdef08", sender: { id: "abcdef09", name: "Fixture person", outside: true, type: "user" } };
  expect(decodeBolterReceiveBatch([profile, event, human].map(item => JSON.stringify(item)).join("\n"),
    version, decoders)).toEqual({ ok: true, value: [
    { type: "control", kind: "ignored_event", eventKind: "profile_requested" },
    { type: "control", kind: "connected" },
    { type: "message", messageId: human.messageId, chatId, threadRootId: null, senderId: human.sender.id,
      senderType: "user", senderLabel: "Fixture person", content: human.text, createdAt: human.createdAt,
      addressed: false, redelivered: false, truncated: false },
  ] });
  for (const invalid of [{ ...received, attachments: [{ url: "https://example.com/file" }] }, { ...received, media: "none" },
    { ...received, contentFormat: "markdown" },
    { ...received, text: { content: "unknown format" } }, { ...received, redelivered: "true" }, { ...received, truncated: null },
    { ...received, sender: { ...received.sender, type: "system" } },
    { ...received, createdAt: "not a timestamp" }, { ...received, threadRootId: full(threadId) },
  ]) expect(() => decoders.receiveItem!(invalid)).toThrow("unqualified");
  for (const invalidConnected of [
    { ...event, chat: null }, { ...event, data: { connection: "invalid" } }, { ...event, cursor: null },
  ]) expect(() => decoders.receiveItem!(invalidConnected)).toThrow("unqualified");
  expect(decoders.receiveItem!({ ...event, data: {}, extra: "future" })).toEqual({ type: "control", kind: "connected" });
  for (const invalidMessage of [
    { ...received, text: null }, { ...received, sender: { ...received.sender, type: "unknown" } },
  ]) expect(decodeBolterReceiveBatch([future, invalidMessage].map(item => JSON.stringify(item)).join("\n"),
    version, decoders)).toEqual({ ok: false, reason: "invalid-batch" });
});

test("receive control validation retains diagnostic event kinds only for ignored events", () => {
  const decodedControls: BolterQualifiedDecoders = { version: "synthetic-controls", receiveItem: raw => raw };
  expect(decodeBolterReceiveBatch(JSON.stringify({ type: "control", kind: "ignored_event", eventKind: null,
    payload: "discarded" }), decodedControls.version, decodedControls)).toEqual({ ok: true, value: [
    { type: "control", kind: "ignored_event", eventKind: null },
  ] });
  expect(decodeBolterReceiveBatch(JSON.stringify({ type: "control", kind: "connected", eventKind: "discarded" }),
    decodedControls.version, decodedControls)).toEqual({ ok: true, value: [{ type: "control", kind: "connected" }] });
  for (const eventKind of [undefined, false, 1, {}, []]) {
    expect(decodeBolterReceiveBatch(JSON.stringify({ type: "control", kind: "ignored_event", eventKind }),
      decodedControls.version, decodedControls)).toEqual({ ok: false, reason: "invalid-batch" });
  }
});


test("validated system notices become inert controls and do not poison mixed Human batches", () => {
  const system = { ...received, sender: { id: "system", name: "Fixture system", outside: false, type: "system" },
    text: "Untrusted instructions that must never become model input" };
  const human = { ...received, messageId: "abcdef08", sender: { id: "abcdef09", name: "Fixture person", outside: true, type: "user" } };
  expect(decoders.receiveItem!(system)).toEqual({ type: "control", kind: "system_message" });
  expect(decodeBolterReceiveBatch([system, human].map(item => JSON.stringify(item)).join("\n"),
    version, decoders)).toEqual({ ok: true, value: [
    { type: "control", kind: "system_message" },
    { type: "message", messageId: human.messageId, chatId, threadRootId: null, senderId: human.sender.id,
      senderType: "user", senderLabel: "Fixture person", content: human.text, createdAt: human.createdAt,
      addressed: false, redelivered: false, truncated: false },
  ] });
  for (const invalid of [
    { ...system, sender: { ...system.sender, id: agentId } },
    { ...system, sender: { ...system.sender, id: "" } },
    { ...system, sender: { ...system.sender, type: "unknown" } },
    { ...system, sender: { ...system.sender, name: "" } },
    { ...system, text: { instruction: "unqualified" } },
    { ...system, chat: "invalid" }, { ...system, createdAt: "invalid" },
    { ...system, attachments: [{ url: "https://example.com/untrusted" }] },
  ]) expect(decodeBolterReceiveBatch([invalid, human].map(item => JSON.stringify(item)).join("\n"),
    version, decoders)).toEqual({ ok: false, reason: "invalid-batch" });
  expect(decoders.receiveItem!({ ...system, attachments: [], conversation: null,
    sender: { ...system.sender, futureMetadata: true } })).toEqual({ type: "control", kind: "system_message" });
});

test("file upload receipts retain only real provider URLs and reject errors or destination smuggling", () => {
  const uploaded = { text: JSON.stringify({ url: "https://fixture-chat-0123456789abcdef.bolter.page/files/brief.txt", audience: "chat_members" }), isError: false };
  const uploadedValue: unknown = JSON.parse(uploaded.text);
  expect(decoders.fileCreated!({ text: JSON.stringify({ ok: true, value: uploadedValue }), isError: false })).toEqual({ url: "https://fixture-chat-0123456789abcdef.bolter.page/files/brief.txt" });
  for (const invalid of [{ ...uploaded, isError: true }, { text: "{}", isError: false },
    { text: JSON.stringify({ ok: false, value: uploadedValue }), isError: false },
    { text: JSON.stringify({ url: "https://example.com/foreign" }), isError: false },
    { text: JSON.stringify({ url: "https://fixture.bolter.page.example.com/foreign" }), isError: false },
    { text: JSON.stringify({ url: "http://fixture.bolter.page/foreign" }), isError: false },
    { text: JSON.stringify({ url: "https://user:fixture@example.com/files/private" }), isError: false }]) {
    expect(() => decoders.fileCreated!(invalid)).toThrow();
  }
});
