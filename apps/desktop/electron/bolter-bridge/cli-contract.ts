import { posix, win32 } from "node:path";

export type BolterContractFailure =
  | "invalid-input" | "unsupported-origin" | "unsupported-platform"
  | "unsupported-output" | "invalid-batch" | "conflicting-message";
export type BolterContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: BolterContractFailure };

export interface BolterCliSelection {
  label?: string;
  origin: string;
  /** Canonical provider identity, never inferred from the short CLI selector. */
  agentId: string;
  cliSelector: string;
}

export interface BolterCliRuntime {
  executable: string;
  home: string;
  platform: "darwin" | "linux" | "win32";
  version: string;
}

export interface BolterCliInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
}

export interface BolterCliBinding {
  chatId: string;
  threadRootId: string | null;
}

export interface BolterCliIdentity { origin: string; agentId: string; label?: string }
export interface BolterCliDiscoveredIdentity extends BolterCliSelection { label?: string }
export interface BolterCliConversation extends BolterCliBinding { label: string }
export interface BolterCliAuthLink { url: string; code: string }
export interface BolterCliReceipt extends BolterCliBinding { messageId: string }

/** Internal normalized form, not a claim about the provider's serve JSON schema. */
export interface BolterCliMessage extends BolterCliBinding {
  type: "message";
  messageId: string;
  senderId: string;
  senderType: "user" | "anima" | "system";
  senderLabel?: string;
  content: string;
  createdAt: string;
  addressed: boolean;
  truncated: boolean;
  redelivered: boolean;
}

/** Control items are retained for the owner's policy; they never become instructions. */
export interface BolterCliControl {
  type: "control";
  kind: string;
  /** Local diagnostic metadata for ignored provider events; never model input. */
  eventKind?: string | null;
}
export type BolterCliReceiveItem = BolterCliMessage | BolterCliControl;

/**
 * Only install decoders after qualifying fixtures for the exact executable version.
 * MCP event discovery does not qualify foreground serve, auth or send outputs.
 */
export interface BolterQualifiedDecoders {
  version: string;
  identity?: (raw: unknown) => unknown;
  discovery?: (raw: unknown) => unknown;
  conversations?: (raw: unknown) => unknown;
  authLink?: (stdout: string) => unknown;
  receiveItem?: (raw: unknown) => unknown;
  receipt?: (raw: unknown) => unknown;
  fileCreated?: (raw: unknown) => { url: string };
}

function success<T>(value: T): BolterContractResult<T> { return { ok: true, value }; }
function failure(reason: BolterContractFailure): BolterContractResult<never> {
  return { ok: false, reason };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function argument(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !value.startsWith("-") && !hasControlCharacters(value);
}
function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function id(value: unknown): value is string {
  return argument(value) && !/\s/.test(value);
}
function origin(value: unknown): value is "https://bolter.chat" {
  return value === "https://bolter.chat";
}
function absolute(value: string, platform: BolterCliRuntime["platform"]): boolean {
  return argument(value) && (platform === "win32" ? win32 : posix).isAbsolute(value);
}

export function createBolterChildEnvironment(
  runtime: BolterCliRuntime,
): BolterContractResult<Readonly<Record<string, string>>> {
  // Child HOME credential isolation has not been qualified on Windows.
  if (runtime.platform === "win32") return failure("unsupported-platform");
  if (!absolute(runtime.home, runtime.platform) ||
      !absolute(runtime.executable, runtime.platform) || !argument(runtime.version)) {
    return failure("invalid-input");
  }
  if (runtime.platform !== "darwin" && runtime.platform !== "linux") return failure("unsupported-platform");
  return success(Object.freeze({ HOME: runtime.home, PATH: "/usr/bin:/bin" }));
}

function invocation(
  runtime: BolterCliRuntime, args: string[], stdin = "",
): BolterContractResult<BolterCliInvocation> {
  const environment = createBolterChildEnvironment(runtime);
  if (!environment.ok) return environment;
  return success(Object.freeze({ executable: runtime.executable, args: Object.freeze(args),
    stdin, env: environment.value, shell: false as const }));
}
function selected(selection: BolterCliSelection): BolterContractResult<string[]> {
  if (!origin(selection.origin)) return failure("unsupported-origin");
  if (!id(selection.agentId) || !argument(selection.cliSelector)) return failure("invalid-input");
  return success(["--url", selection.origin, "--agent", selection.cliSelector]);
}

/** Local discovery has no --url flag; each decoded identity must carry its origin. */
export function createBolterDiscoveryInvocation(runtime: BolterCliRuntime): BolterContractResult<BolterCliInvocation> {
  return invocation(runtime, ["agents", "--json"]);
}
export function createBolterConversationsInvocation(runtime: BolterCliRuntime,
  selection: BolterCliSelection): BolterContractResult<BolterCliInvocation> {
  const flags = selected(selection);
  return flags.ok ? invocation(runtime, ["chats", "--json", ...flags.value]) : flags;
}

export function createBolterIdentityInvocation(
  runtime: BolterCliRuntime, selection: BolterCliSelection,
): BolterContractResult<BolterCliInvocation> {
  const flags = selected(selection);
  return flags.ok ? invocation(runtime, ["me", "--json", ...flags.value]) : flags;
}

export function createBolterLoginInvocation(
  runtime: BolterCliRuntime,
): BolterContractResult<BolterCliInvocation> {
  return invocation(runtime, ["login", "--url", "https://bolter.chat", "--harness", "nautilo",
    "--name", "Nautilo", "--no-browser"]);
}

export function createBolterSendInvocation(
  runtime: BolterCliRuntime, selection: BolterCliSelection, binding: BolterCliBinding, content: string,
): BolterContractResult<BolterCliInvocation> {
  const flags = selected(selection);
  if (!flags.ok) return flags;
  if (!id(binding.chatId) || (binding.threadRootId !== null && !id(binding.threadRootId)) ||
      typeof content !== "string" || content.length === 0) return failure("invalid-input");
  const args = ["call", "bolter_send_message", "-", "--json", ...flags.value, "--chat", binding.chatId];
  if (binding.threadRootId !== null) args.push("--thread", binding.threadRootId);
  // Deliberately exclude provider destination overrides and metadata, even on a cast input.
  return invocation(runtime, args, JSON.stringify({ content }));
}

/** Fixed chat-scoped upload. The provider chooses the resulting access-gated URL. */
export function createBolterFileInvocation(runtime: BolterCliRuntime, selection: BolterCliSelection,
  binding: BolterCliBinding, file: { path: string; mimeType: string; content: string }): BolterContractResult<BolterCliInvocation> {
  const flags = selected(selection);
  if (!flags.ok) return flags;
  if (!id(binding.chatId) || (binding.threadRootId !== null && !id(binding.threadRootId))
    || !/^\/nautilo\/[a-f0-9-]+\/[^/]+$/u.test(file.path) || hasControlCharacters(file.path)
    || !argument(file.mimeType) || typeof file.content !== "string") return failure("invalid-input");
  const args = ["call", "files_create_file", "-", "--json", ...flags.value, "--chat", binding.chatId];
  if (binding.threadRootId !== null) args.push("--thread", binding.threadRootId);
  return invocation(runtime, args, JSON.stringify({ path: file.path, mime_type: file.mimeType, content: file.content }));
}

export function createBolterReceiveInvocation(
  runtime: BolterCliRuntime, selection: BolterCliSelection, handoverExecutable: string,
): BolterContractResult<BolterCliInvocation> {
  const flags = selected(selection);
  if (!flags.ok) return flags;
  // Provider --exec command parsing on Windows has not been qualified.
  if (runtime.platform === "win32") return failure("unsupported-platform");
  if (!absolute(handoverExecutable, runtime.platform)) return failure("invalid-input");
  const command = `'${handoverExecutable.replaceAll("'", "'\\''")}'`;
  // Include unaddressed Human messages; the server admits only exact active bindings
  // and independently rejects self echoes and unaddressed agent messages.
  return invocation(runtime, ["serve", "--all", "--input", "json", "--exec", command, ...flags.value]);
}

export function validateBolterIdentity(raw: unknown): BolterContractResult<BolterCliIdentity> {
  if (!record(raw) || !origin(raw["origin"]) || !id(raw["agentId"])) return failure("unsupported-output");
  return success({ origin: raw["origin"], agentId: raw["agentId"],
    ...(typeof raw["label"] === "string" && raw["label"].trim() ? { label: raw["label"] } : {}) });
}

export function decodeBolterIdentities(raw: unknown, version: string,
  decoders?: BolterQualifiedDecoders): BolterContractResult<readonly BolterCliDiscoveredIdentity[]> {
  if (decoders?.version !== version || !decoders.discovery) return failure("unsupported-output");
  try {
    const decoded: unknown = decoders.discovery(raw);
    if (!Array.isArray(decoded)) return failure("unsupported-output");
    const identities: BolterCliDiscoveredIdentity[] = [];
    const canonical = new Set<string>();
    const selectors = new Set<string>();
    for (const item of decoded) {
      if (!record(item) || !origin(item["origin"]) || !id(item["agentId"]) || !argument(item["cliSelector"])
        || (item["label"] !== undefined && (typeof item["label"] !== "string" || item["label"].length === 0))) return failure("unsupported-output");
      const key = JSON.stringify([item["origin"], item["agentId"]]);
      if (canonical.has(key) || selectors.has(item["cliSelector"])) return failure("unsupported-output");
      canonical.add(key); selectors.add(item["cliSelector"]);
      identities.push(Object.freeze({ origin: item["origin"], agentId: item["agentId"], cliSelector: item["cliSelector"],
        ...(typeof item["label"] === "string" ? { label: item["label"] } : {}) }));
    }
    return success(Object.freeze(identities));
  } catch { return failure("unsupported-output"); }
}

export function decodeBolterConversations(raw: unknown, version: string,
  decoders?: BolterQualifiedDecoders): BolterContractResult<readonly BolterCliConversation[]> {
  if (decoders?.version !== version || !decoders.conversations) return failure("unsupported-output");
  try {
    const decoded: unknown = decoders.conversations(raw);
    if (!Array.isArray(decoded)) return failure("unsupported-output");
    const conversations: BolterCliConversation[] = [];
    const seen = new Set<string>();
    for (const item of decoded) {
      if (!record(item) || !id(item["chatId"]) || (item["threadRootId"] !== null && !id(item["threadRootId"]))
        || typeof item["label"] !== "string" || item["label"].length === 0) return failure("unsupported-output");
      const key = JSON.stringify([item["chatId"], item["threadRootId"]]);
      if (seen.has(key)) return failure("unsupported-output");
      seen.add(key); conversations.push(Object.freeze({ chatId: item["chatId"], threadRootId: item["threadRootId"], label: item["label"] }));
    }
    return success(Object.freeze(conversations));
  } catch { return failure("unsupported-output"); }
}

export function validateBolterAuthLink(raw: unknown): BolterContractResult<BolterCliAuthLink> {
  if (!record(raw) || typeof raw["url"] !== "string" || typeof raw["code"] !== "string" ||
      !/^[A-Z]{4}-[A-Z]{4}$/.test(raw["code"])) return failure("unsupported-output");
  try {
    const url = new URL(raw["url"]);
    if (url.origin !== "https://bolter.chat" || url.username || url.password || url.hash ||
        hasControlCharacters(raw["url"]) || /\s/.test(raw["url"])) return failure("unsupported-output");
    return success({ url: url.href, code: raw["code"] });
  } catch { return failure("unsupported-output"); }
}

export function validateBolterReceipt(raw: unknown): BolterContractResult<BolterCliReceipt> {
  if (!record(raw) || !id(raw["messageId"]) || !id(raw["chatId"]) ||
      (raw["threadRootId"] !== null && !id(raw["threadRootId"]))) return failure("unsupported-output");
  return success({ messageId: raw["messageId"], chatId: raw["chatId"], threadRootId: raw["threadRootId"] });
}

function validateReceiveItem(raw: unknown): BolterContractResult<BolterCliReceiveItem> {
  if (!record(raw)) return failure("invalid-batch");
  if (raw["type"] === "control" && id(raw["kind"])) {
    if (raw["kind"] === "ignored_event") {
      if (raw["eventKind"] !== null && typeof raw["eventKind"] !== "string") return failure("invalid-batch");
      return success({ type: "control", kind: "ignored_event", eventKind: raw["eventKind"] });
    }
    return success({ type: "control", kind: raw["kind"] });
  }
  if (raw["type"] !== "message" || !id(raw["messageId"]) || !id(raw["chatId"]) || !id(raw["senderId"]) ||
      (raw["threadRootId"] !== null && !id(raw["threadRootId"])) ||
      (raw["senderType"] !== "user" && raw["senderType"] !== "anima" && raw["senderType"] !== "system") ||
      (raw["senderLabel"] !== undefined && (typeof raw["senderLabel"] !== "string" || raw["senderLabel"].length === 0)) ||
      typeof raw["content"] !== "string" || typeof raw["createdAt"] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(raw["createdAt"]) || !Number.isFinite(Date.parse(raw["createdAt"])) ||
      typeof raw["addressed"] !== "boolean" || typeof raw["truncated"] !== "boolean" ||
      typeof raw["redelivered"] !== "boolean") return failure("invalid-batch");
  return success({ type: "message", messageId: raw["messageId"], chatId: raw["chatId"],
    threadRootId: raw["threadRootId"], senderId: raw["senderId"],
    senderType: raw["senderType"], content: raw["content"],
    ...(typeof raw["senderLabel"] === "string" ? { senderLabel: raw["senderLabel"] } : {}),
    createdAt: raw["createdAt"], addressed: raw["addressed"], truncated: raw["truncated"], redelivered: raw["redelivered"] });
}

export function decodeBolterReceiveBatch(
  jsonl: string, version: string, decoders?: BolterQualifiedDecoders,
): BolterContractResult<readonly BolterCliReceiveItem[]> {
  if (!decoders?.receiveItem || decoders.version !== version) return failure("unsupported-output");
  // A child processes the complete batch at EOF. Empty/interior lines are not accepted.
  const lines = jsonl.endsWith("\n") ? jsonl.slice(0, -1).split("\n") : jsonl.split("\n");
  if (lines.some((line) => line.trim().length === 0)) return failure("invalid-batch");
  const items: BolterCliReceiveItem[] = [];
  const seen = new Map<string, string>();
  try {
    for (const line of lines) {
      const raw: unknown = JSON.parse(line);
      const item = validateReceiveItem(decoders.receiveItem(raw));
      if (!item.ok) return item;
      if (item.value.type === "message") {
        const { redelivered: _redelivered, ...immutable } = item.value;
        const key = JSON.stringify([immutable.chatId, immutable.messageId]);
        const fingerprint = JSON.stringify(immutable);
        const prior = seen.get(key);
        if (prior !== undefined && prior !== fingerprint) return failure("conflicting-message");
        if (prior !== undefined) continue;
        seen.set(key, fingerprint);
      }
      items.push(item.value);
    }
    return success(items);
  } catch { return failure("invalid-batch"); }
}
