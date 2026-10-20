import type { BolterQualifiedDecoders } from "./cli-contract";

const origin = "https://bolter.chat";
const unqualified = () => new Error("Bolter output is unqualified.");
function record(raw: unknown, required: readonly string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw unqualified();
  const value = raw as Record<string, unknown>;
  if (!required.every(key => Object.hasOwn(value, key))) throw unqualified();
  return value;
}
const text = (value: unknown): value is string => typeof value === "string";
const nonempty = (value: unknown): value is string => text(value) && value.length > 0;
const alias = (value: unknown): value is string => text(value) && /^[a-f0-9]{8}$/u.test(value);
const uuid = (value: unknown): value is string => text(value) && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
function timestamp(value: unknown): value is string {
  try { return text(value) && new Date(value).toISOString() === value; } catch { return false; }
}
function safeEmptyCollection(value: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(value, key) || (Array.isArray(value[key]) && value[key].length === 0);
}
function plainTextFormat(value: Record<string, unknown>): boolean {
  for (const key of ["contentFormat", "contentType", "content_format", "content_type", "format"] as const) {
    if (Object.hasOwn(value, key) && value[key] !== "text" && value[key] !== "plain" && value[key] !== "text/plain") return false;
  }
  return true;
}

/** Provider adapters project only fields Nautilo consumes; they confer no native execution admission. */
export function getBolterProductionDecoders(version: string): BolterQualifiedDecoders | undefined {
  if (!/^[a-f0-9]{40}$/u.test(version)) return undefined;
  return Object.freeze({ version, discovery(raw: unknown): unknown {
    const value = record(raw, ["agents"]);
    if (!Array.isArray(value["agents"])) throw unqualified();
    return value["agents"].map(rawAgent => {
      const agent = record(rawAgent, ["agentId", "name", "url"]);
      if (!alias(agent["agentId"]) || !nonempty(agent["name"]) || agent["url"] !== origin) throw unqualified();
      // The provider's public alias is connection-scoped; a starred/default row grants no selection authority.
      return { origin, agentId: agent["agentId"], cliSelector: agent["agentId"], label: agent["name"] };
    });
  }, identity(raw: unknown): unknown {
    const value = record(raw, ["agentId"]);
    if (!alias(value["agentId"]) || (Object.hasOwn(value, "origin") && value["origin"] !== origin)) throw unqualified();
    // `me` omits origin. This decoder is used only by the fixed origin-pinned invocation.
    return { origin, agentId: value["agentId"], ...(nonempty(value["name"]) ? { label: value["name"] } : {}) };
  }, conversations(raw: unknown): unknown {
    if (!Array.isArray(raw)) throw unqualified();
    return raw.map(rawChat => {
      const chat = record(rawChat, ["chat", "name"]);
      if (!alias(chat["chat"]) || !nonempty(chat["name"]) || Object.hasOwn(chat, "threadRootId")) throw unqualified();
      return { chatId: chat["chat"], label: chat["name"], threadRootId: null };
    });
  }, receiveItem(raw: unknown): unknown {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw unqualified();
    const input = raw as Record<string, unknown>;
    if (input["type"] === "event") {
      // Hosted event kinds can evolve independently of the pinned CLI. Keep unknown
      // events inert and retain only their kind for local diagnostics, never their prose.
      if (input["kind"] !== "connected") return { type: "control", kind: "ignored_event",
        eventKind: typeof input["kind"] === "string" ? input["kind"] : null };
      const event = record(input, ["kind", "type"]);
      if ((Object.hasOwn(event, "chat") && !alias(event["chat"]))
        || (Object.hasOwn(event, "createdAt") && !timestamp(event["createdAt"]))
        || (Object.hasOwn(event, "cursor") && !nonempty(event["cursor"]))
        || (Object.hasOwn(event, "text") && !text(event["text"]))) throw unqualified();
      if (Object.hasOwn(event, "data")) {
        const data = record(event["data"]);
        if (Object.hasOwn(data, "connection") && !uuid(data["connection"])) throw unqualified();
      }
      return { type: "control", kind: "connected" };
    }
    const message = record(input, ["addressed", "chat", "createdAt", "messageId", "sender", "text", "threadRootId", "type"]);
    const sender = record(message["sender"], ["id", "name", "type"]);
    if (message["type"] !== "message" || !alias(message["chat"]) || !alias(message["messageId"])
      || (message["threadRootId"] !== null && !alias(message["threadRootId"]))
      || typeof message["addressed"] !== "boolean" || !timestamp(message["createdAt"]) || !text(message["text"])
      || (sender["type"] === "system" ? sender["id"] !== "system" : !alias(sender["id"]))
      || !nonempty(sender["name"])
      || (sender["type"] !== "anima" && sender["type"] !== "user" && sender["type"] !== "system")
      || (Object.hasOwn(message, "redelivered") && typeof message["redelivered"] !== "boolean")
      || (Object.hasOwn(message, "truncated") && typeof message["truncated"] !== "boolean")
      || !safeEmptyCollection(message, "attachments") || !safeEmptyCollection(message, "media")
      || !plainTextFormat(message)) throw unqualified();
    // Provider system notices are inert: no invented Actor or notice text crosses the message boundary.
    if (sender["type"] === "system") return { type: "control", kind: "system_message" };
    // Conversation counters/cursor/provider prose never become routing, identity, or execution authority.
    // This version omits flags on observed complete text and repeated handovers; canonical IDs still deduplicate.
    return { type: "message", messageId: message["messageId"], chatId: message["chat"], threadRootId: message["threadRootId"],
      senderId: sender["id"], senderType: sender["type"], senderLabel: sender["name"], content: message["text"], createdAt: message["createdAt"],
      addressed: message["addressed"], redelivered: message["redelivered"] ?? false, truncated: message["truncated"] ?? false };
  }, receipt(raw: unknown): unknown {
    const outer = record(raw, ["text", "isError"]);
    if (outer["isError"] !== false || !text(outer["text"])) throw unqualified();
    const value = record(JSON.parse(outer["text"]) as unknown, ["success", "messageId", "groupId", "placement", "threadRootId"]);
    if (value["success"] !== true || !uuid(value["messageId"]) || !uuid(value["groupId"])
      || (value["placement"] === "main" ? value["threadRootId"] !== null
        : value["placement"] !== "thread" || !uuid(value["threadRootId"]))) throw unqualified();
    // This CLI version reports full UUIDs in receipts but routes receive/chat/thread IDs by their eight-hex alias.
    return { messageId: value["messageId"], chatId: value["groupId"].slice(0, 8),
      threadRootId: value["threadRootId"] === null ? null : (value["threadRootId"] as string).slice(0, 8) };
  }, fileCreated(raw: unknown): { url: string } {
    const outer = record(raw, ["text", "isError"]);
    if (outer["isError"] !== false || !text(outer["text"])) throw unqualified();
    const result = record(JSON.parse(outer["text"]) as unknown);
    if (Object.hasOwn(result, "ok") && result["ok"] !== true) throw unqualified();
    const value = record(Object.hasOwn(result, "ok") ? result["value"] : result, ["url"]);
    if (!nonempty(value["url"]) || /[<>\s]/u.test(value["url"])) throw unqualified();
    const url = new URL(value["url"]);
    if (url.protocol !== "https:" || url.port || url.username || url.password
      || (url.origin !== origin && !url.hostname.endsWith(".bolter.page"))) throw unqualified();
    return { url: value["url"] };
  }, authLink(stdout: string): unknown {
    // Permit provider notices around the concrete prompt, while retaining one fixed URL and one unambiguous code.
    const prompt = /Open this link on any device to sign in \(or create a Bolter account\): https:\/\/bolter\.chat\/device\?code=([A-Z]{4}-[A-Z]{4})\nCheck that the page shows the code ([A-Z]{4}-[A-Z]{4})\. If this command is stopped, run it again to keep waiting on the same code\.\n/u.exec(stdout);
    const schemes = stdout.match(/https?:\/\//gu) ?? [];
    const codes = stdout.match(/[A-Z]{4}-[A-Z]{4}/gu) ?? [];
    if (!prompt || prompt[1] !== prompt[2] || schemes.length !== 1
      || codes.length !== 2 || codes.some(code => code !== prompt[1])
      || /(?:token|password|secret|credential|api[_ -]?key)\s*[:=]\s*\S+/iu.test(stdout)) throw unqualified();
    return Object.freeze({ url: `https://bolter.chat/device?code=${prompt[1]}`, code: prompt[1] });
  } });
}
