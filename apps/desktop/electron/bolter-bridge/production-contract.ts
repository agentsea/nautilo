import type { BolterQualifiedDecoders } from "./cli-contract";

const releaseVersion = "eaf521f882831d4336a3e23dcb9fbd669ad7accd";
export const BOLTER_CLI_RELEASE = Object.freeze({
  version: releaseVersion,
  artifacts: Object.freeze({
    "darwin-arm64": Object.freeze({ url: `https://cdn.bolter.chat/bolter-agent/${releaseVersion}/darwin-arm64`,
      sha256: "b0c6b5de7115e93f7455d593d0bf45485a8a3fcb9c524f77b0920b027b2fa9d4", bytes: 6539810 }),
    "darwin-x64": Object.freeze({ url: `https://cdn.bolter.chat/bolter-agent/${releaseVersion}/darwin-amd64`,
      sha256: "95d66bc0849468f28726661be65fb7975ac102913bbb02d02f7dbf9f2468c5eb", bytes: 7013520 }),
  }),
});
export type BolterCliArtifact = { readonly url: string; readonly sha256: string; readonly bytes: number };

const origin = "https://bolter.chat";
const unqualified = () => new Error("Bolter output is unqualified.");
function record(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw unqualified();
  const value = raw as Record<string, unknown>;
  if (!required.every(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw unqualified();
  return value;
}
const text = (value: unknown): value is string => typeof value === "string";
const nonempty = (value: unknown): value is string => text(value) && value.length > 0;
const alias = (value: unknown): value is string => text(value) && /^[a-f0-9]{8}$/u.test(value);
const uuid = (value: unknown): value is string => text(value) && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function timestamp(value: unknown): value is string {
  try { return text(value) && new Date(value).toISOString() === value; } catch { return false; }
}

/** Exact-version adapters project observed provider fields; they confer no native execution admission. */
export function getBolterProductionDecoders(version: string): BolterQualifiedDecoders | undefined {
  if (version !== BOLTER_CLI_RELEASE.version) return undefined;
  return Object.freeze({ version, discovery(raw: unknown): unknown {
    const value = record(raw, ["agents", "harness"]);
    if (!Array.isArray(value["agents"]) || !nonempty(value["harness"])) throw unqualified();
    return value["agents"].map(rawAgent => {
      const agent = record(rawAgent, ["agentId", "name", "harness", "url", "current"]);
      if (!alias(agent["agentId"]) || !nonempty(agent["name"]) || !nonempty(agent["harness"])
        || agent["url"] !== origin || typeof agent["current"] !== "boolean") throw unqualified();
      // The provider's public alias is connection-scoped; a starred/default row grants no selection authority.
      return { origin, agentId: agent["agentId"], cliSelector: agent["agentId"], label: agent["name"] };
    });
  }, identity(raw: unknown): unknown {
    const value = record(raw, ["agentId", "client", "handle", "name", "owner", "workspace"]);
    const client = record(value["client"], ["harness", "host"]);
    const owner = record(value["owner"], ["chat", "id", "name"]);
    const workspace = record(value["workspace"], ["id", "name"]);
    if (!alias(value["agentId"]) || !nonempty(value["handle"]) || !nonempty(value["name"])
      || !nonempty(client["harness"]) || !nonempty(client["host"]) || !alias(owner["chat"]) || !alias(owner["id"])
      || !nonempty(owner["name"]) || !alias(workspace["id"]) || !nonempty(workspace["name"])) throw unqualified();
    // `me` omits origin. This decoder is used only by the fixed origin-pinned invocation.
    return { origin, agentId: value["agentId"] };
  }, conversations(raw: unknown): unknown {
    if (!Array.isArray(raw)) throw unqualified();
    return raw.map(rawChat => {
      const chat = record(rawChat, ["chat", "name", "memberCount"]);
      if (!alias(chat["chat"]) || !nonempty(chat["name"]) || !count(chat["memberCount"])) throw unqualified();
      return { chatId: chat["chat"], label: chat["name"], threadRootId: null };
    });
  }, receiveItem(raw: unknown): unknown {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw unqualified();
    const input = raw as Record<string, unknown>;
    if (input["type"] === "event") {
      const event = record(input, ["chat", "createdAt", "cursor", "data", "kind", "text", "type"]);
      const data = record(event["data"], ["connection"]);
      if (event["kind"] !== "connected" || !alias(event["chat"]) || !timestamp(event["createdAt"])
        || !nonempty(event["cursor"]) || !text(event["text"]) || !uuid(data["connection"])) throw unqualified();
      return { type: "control", kind: "connected" };
    }
    const message = record(input, ["addressed", "chat", "chatName", "conversation", "createdAt", "cursor", "messageId",
      "replyToId", "sender", "text", "threadRootId", "type"], ["redelivered", "truncated"]);
    const sender = record(message["sender"], ["id", "name", "outside", "type"]);
    const conversation = message["conversation"];
    if (message["type"] !== "message" || !alias(message["chat"]) || !alias(message["messageId"])
      || (message["threadRootId"] !== null && !alias(message["threadRootId"]))
      || (message["replyToId"] !== null && !alias(message["replyToId"]))
      || typeof message["addressed"] !== "boolean" || !nonempty(message["chatName"]) || !timestamp(message["createdAt"])
      || !nonempty(message["cursor"]) || !text(message["text"]) || !conversation || typeof conversation !== "object" || Array.isArray(conversation)
      || (sender["type"] === "system" ? sender["id"] !== "system" : !alias(sender["id"]))
      || !nonempty(sender["name"]) || typeof sender["outside"] !== "boolean"
      || (sender["type"] !== "anima" && sender["type"] !== "user" && sender["type"] !== "system")
      || (Object.hasOwn(message, "redelivered") && typeof message["redelivered"] !== "boolean")
      || (Object.hasOwn(message, "truncated") && typeof message["truncated"] !== "boolean")) throw unqualified();
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
  }, authLink(stdout: string): unknown {
    // Parse only the complete observed prompt. Provider prose is never executable authority.
    const prompt = /^Open this link on any device to sign in \(or create a Bolter account\): https:\/\/bolter\.chat\/device\?code=([A-Z]{4}-[A-Z]{4})\nCheck that the page shows the code ([A-Z]{4}-[A-Z]{4})\. If this command is stopped, run it again to keep waiting on the same code\.\n$/u.exec(stdout);
    if (!prompt || prompt[0] !== stdout || prompt[1] !== prompt[2]) throw new Error("Bolter output is unqualified.");
    return Object.freeze({ url: `https://bolter.chat/device?code=${prompt[1]}`, code: prompt[1] });
  } });
}
