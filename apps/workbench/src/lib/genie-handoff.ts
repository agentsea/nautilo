import {
  GENIE_APPLICATION_BRIDGE_VERSION_V1,
  parseGenieHandoffV1,
  type GenieHandoffV1,
  type LocalMcpInstallFailureCode,
} from "@nautilo/types";
import type { NautiloApiClient } from "@nautilo/api-client/browser";
import { sendOrdinaryRoomMessage } from "./ordinary-room-message";

const textEncoder = new TextEncoder();

const BROWSER_CONTEXT_KEYS = new Set(["url", "selection"]);
const LOCAL_MCP_CONTEXT_KEYS = new Set(["mcpName", "failureCode", "environmentNames"]);
const LOCAL_MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;

// This is deliberately narrower than the historic LocalMcpInstallFailureCode
// union: a handoff carries only the safe, actionable prerequisite outcomes.
const HANDOFF_LOCAL_MCP_FAILURE_CODES = new Set<LocalMcpInstallFailureCode>([
  "invalid_request",
  "relay_unavailable",
  "relay_protocol_unsupported",
  "missing_launcher",
  "missing_environment",
  "spawn_failed",
  "protocol_failed",
  "discovery_timeout",
  "empty_toolset",
  "internal",
]);

export interface BrowserPageHandoffInput {
  readonly intent: string;
  readonly context: {
    readonly url: string;
    readonly selection?: string | undefined;
  };
}

export interface LocalMcpHandoffInput {
  readonly intent: string;
  readonly context: {
    readonly mcpName?: string | undefined;
    readonly failureCode?: LocalMcpInstallFailureCode | undefined;
    readonly environmentNames?: readonly string[] | undefined;
  };
}

export interface GenieHandoffPorts {
  /** Existing authenticated client; all sends delegate through ordinary chat. */
  readonly apiClient: NautiloApiClient;
  /** The composer/Room runtime remains the authority for the active Room. */
  readonly getCurrentRoomId: () => string | null;
  /** Preserve the existing composer as the only draft owner. */
  readonly appendCurrentRoomDraft?: (content: string) => void | Promise<void>;
  readonly refreshRooms: () => Promise<void>;
  readonly setActiveRoom: (roomId: string) => void | Promise<void>;
}

export interface GenieHandoffController {
  buildBrowserPage: (input: BrowserPageHandoffInput) => GenieHandoffV1;
  buildLocalMcp: (input: LocalMcpHandoffInput) => GenieHandoffV1;
  deliver: (
    handoff: unknown,
    options?: { readonly explicitHumanAction?: boolean | undefined },
  ) => Promise<void>;
}

/** The narrow, editable-composer authority needed for browser draft delivery. */
export interface GenieHandoffDraftComposerPorts extends Omit<GenieHandoffPorts, "appendCurrentRoomDraft"> {
  readonly getCurrentDraft: () => string;
  /** Must synchronously advance the owning composer's authoritative draft ref. */
  readonly setCurrentDraft: (next: string) => void;
}

export type GenieHandoffDraftDispatcher = (handoff: GenieHandoffV1) => Promise<void>;

/**
 * An instance-owned handoff bridge. It is deliberately a single live
 * registrar, not a queue: source surfaces either reach the mounted composer
 * now, or receive `false` and retain their own recovery UI.
 */
export interface GenieHandoffBridge {
  registerBrowserPageDraftDispatcher: (dispatcher: GenieHandoffDraftDispatcher) => () => void;
  deliverBrowserPageDraft: (handoff: unknown) => Promise<boolean>;
}

/** New Room + message succeeded; only presentation of that success failed. */
export class GenieHandoffPartialSuccessError extends Error {
  readonly roomId: string;

  constructor(roomId: string) {
    super("Genie handoff message was sent, but the new Room could not be opened.");
    this.name = "GenieHandoffPartialSuccessError";
    this.roomId = roomId;
  }
}

export type GenieHandoffDeliveryStage = "create-room" | "send-current-room" | "send-new-room";

/** A dependency failed before an ordinary Human message was persisted. */
export class GenieHandoffDeliveryError extends Error {
  readonly stage: GenieHandoffDeliveryStage;

  constructor(stage: GenieHandoffDeliveryStage) {
    super("Genie handoff could not be delivered.");
    this.name = "GenieHandoffDeliveryError";
    this.stage = stage;
  }
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactContextKeys(value: unknown, allowed: ReadonlySet<string>): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError("Genie handoff source context is not supported.");
  }
}

function assertMcpName(value: unknown): asserts value is string {
  if (typeof value !== "string" || value !== value.normalize("NFC").trim()
    || !LOCAL_MCP_NAME.test(value) || utf8Bytes(value) > 160) {
    throw new TypeError("Genie handoff MCP name is not supported.");
  }
}

function assertEnvironmentNames(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some((name) =>
    typeof name !== "string" || !ENVIRONMENT_NAME.test(name) || utf8Bytes(name) > 128,
  )) {
    throw new TypeError("Genie handoff environment names are not supported.");
  }
}

function normalizedEnvironmentNames(value: readonly string[]): string[] {
  // Environment names are ASCII by contract. Code-unit comparison is therefore
  // deterministic across locales and pins punctuation ordering (A < Z < _).
  return [...new Set(value)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function assertLocalMcpFailureCode(value: unknown): asserts value is LocalMcpInstallFailureCode {
  if (typeof value !== "string" || !HANDOFF_LOCAL_MCP_FAILURE_CODES.has(value as LocalMcpInstallFailureCode)) {
    throw new TypeError("Genie handoff MCP failure is not supported.");
  }
}

function assertBrowserHandoff(handoff: GenieHandoffV1): void {
  assertExactContextKeys(handoff.context, BROWSER_CONTEXT_KEYS);
  if (typeof handoff.context.url !== "string") {
    throw new TypeError("Genie browser handoff requires a page URL.");
  }
  if (handoff.context.selection !== undefined && typeof handoff.context.selection !== "string") {
    throw new TypeError("Genie browser handoff selection is not supported.");
  }
}

function assertLocalMcpHandoff(handoff: GenieHandoffV1): void {
  assertExactContextKeys(handoff.context, LOCAL_MCP_CONTEXT_KEYS);
  const { mcpName, failureCode, environmentNames } = handoff.context;
  if (mcpName !== undefined) assertMcpName(mcpName);
  if (failureCode !== undefined) assertLocalMcpFailureCode(failureCode);
  if (environmentNames !== undefined) {
    const names = environmentNames.split("\n");
    assertEnvironmentNames(names);
    const normalized = normalizedEnvironmentNames(names);
    if (normalized.length !== names.length || normalized.some((name, index) => name !== names[index])) {
      throw new TypeError("Genie handoff environment names must be unique and sorted.");
    }
  }
}

/**
 * Parse the shared security boundary first, then narrow it to the two concrete
 * Workbench producers that exist in v1. New producers must add their own
 * source-specific builder and validation rather than inheriting this seam.
 */
export function parseWorkbenchGenieHandoff(value: unknown): GenieHandoffV1 {
  const handoff = parseGenieHandoffV1(value);
  if (handoff.source === "browser.page") {
    assertBrowserHandoff(handoff);
    return handoff;
  }
  if (handoff.source === "connections.local_mcp") {
    assertLocalMcpHandoff(handoff);
    return handoff;
  }
  throw new TypeError("Genie handoff source is not supported by Workbench.");
}

export function buildBrowserPageGenieHandoff(input: BrowserPageHandoffInput): GenieHandoffV1 {
  assertExactContextKeys(input.context, BROWSER_CONTEXT_KEYS);
  if (typeof input.context.url !== "string"
    || (input.context.selection !== undefined && typeof input.context.selection !== "string")) {
    throw new TypeError("Genie browser handoff context is not supported.");
  }
  return parseWorkbenchGenieHandoff({
    version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
    source: "browser.page",
    intent: input.intent,
    context: {
      url: input.context.url,
      ...(input.context.selection === undefined ? {} : { selection: input.context.selection }),
    },
    delivery: "draft-current-room",
  });
}

export function buildLocalMcpGenieHandoff(input: LocalMcpHandoffInput): GenieHandoffV1 {
  assertExactContextKeys(input.context, LOCAL_MCP_CONTEXT_KEYS);
  const { mcpName, failureCode, environmentNames } = input.context;
  if (mcpName !== undefined) assertMcpName(mcpName);
  if (failureCode !== undefined) assertLocalMcpFailureCode(failureCode);
  const normalizedNames = environmentNames === undefined
    ? undefined
    : (() => {
      assertEnvironmentNames(environmentNames);
      return normalizedEnvironmentNames(environmentNames);
    })();
  return parseWorkbenchGenieHandoff({
    version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
    source: "connections.local_mcp",
    intent: input.intent,
    context: {
      ...(mcpName === undefined ? {} : { mcpName }),
      ...(failureCode === undefined ? {} : { failureCode }),
      ...(normalizedNames === undefined || normalizedNames.length === 0
        ? {}
        : { environmentNames: normalizedNames.join("\n") }),
    },
    delivery: "send-new-room",
  });
}

/**
 * Compose a browser handoff into the real editable composer. This factory has
 * no immediate-delivery option: ordinary Room sending remains exclusively in
 * the established Human send path.
 */
export function createBrowserPageDraftDispatcher(
  ports: GenieHandoffDraftComposerPorts,
): GenieHandoffDraftDispatcher {
  const controller = createGenieHandoffController({
    ...ports,
    appendCurrentRoomDraft: (addition) => {
      const existing = ports.getCurrentDraft();
      ports.setCurrentDraft(existing ? `${existing}\n${addition}` : addition);
    },
  });
  return async (value) => {
    const handoff = parseWorkbenchGenieHandoff(value);
    if (handoff.source !== "browser.page" || handoff.delivery !== "draft-current-room") {
      throw new TypeError("Genie draft dispatcher accepts browser drafts only.");
    }
    await controller.deliver(handoff);
  };
}

/**
 * Create a bridge scoped to one Workbench shell. Registration cleanup is
 * identity-safe so an unmounting stale sidecar cannot remove a newer reader
 * rail. The bridge snapshots the current dispatcher and never queues/replays.
 */
export function createGenieHandoffBridge(): GenieHandoffBridge {
  let dispatcher: GenieHandoffDraftDispatcher | null = null;
  return {
    registerBrowserPageDraftDispatcher: (next) => {
      dispatcher = next;
      return () => {
        if (dispatcher === next) dispatcher = null;
      };
    },
    deliverBrowserPageDraft: async (value) => {
      const handoff = parseWorkbenchGenieHandoff(value);
      if (handoff.source !== "browser.page" || handoff.delivery !== "draft-current-room") {
        throw new TypeError("Genie handoff bridge accepts browser drafts only.");
      }
      const current = dispatcher;
      if (!current) return false;
      await current(handoff);
      return true;
    },
  };
}

/**
 * The projection intentionally carries only the declared context. Browser
 * selections remain quoted text, while local MCP intent is pre-normalized
 * safe setup/fix prose from its existing producer.
 */
export function genieHandoffMessageContent(handoff: GenieHandoffV1): string {
  const parsed = parseWorkbenchGenieHandoff(handoff);
  if (parsed.source === "connections.local_mcp") return parsed.intent;

  const selection = parsed.context.selection;
  const quote = selection === undefined
    ? ""
    : `\n\n> ${selection.replace(/\n/gu, "\n> ")}`;
  return `${parsed.context.url}${quote}`;
}

function currentRoomId(ports: GenieHandoffPorts): string {
  const roomId = ports.getCurrentRoomId();
  if (typeof roomId !== "string" || roomId.length === 0) {
    throw new TypeError("Genie handoff requires an active Room.");
  }
  return roomId;
}

function roomLabelFor(handoff: GenieHandoffV1): string {
  return handoff.source === "browser.page" ? "Ask Genie about this page" : "Set up local MCP";
}

async function deliverDependency<T>(stage: GenieHandoffDeliveryStage, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch {
    throw new GenieHandoffDeliveryError(stage);
  }
}

/**
 * Pure orchestration over injected existing UI and Room authority. The only
 * direct effects are delegated to the passed ports, in delivery order.
 */
export function createGenieHandoffController(ports: GenieHandoffPorts): GenieHandoffController {
  return {
    buildBrowserPage: buildBrowserPageGenieHandoff,
    buildLocalMcp: buildLocalMcpGenieHandoff,
    deliver: async (value, options = {}) => {
      const handoff = parseWorkbenchGenieHandoff(value);
      const content = genieHandoffMessageContent(handoff);
      if (handoff.delivery === "draft-current-room") {
        currentRoomId(ports);
        if (!ports.appendCurrentRoomDraft) {
          throw new TypeError("Genie handoff draft is unavailable.");
        }
        await ports.appendCurrentRoomDraft(content);
        return;
      }
      if (options.explicitHumanAction !== true) {
        throw new TypeError("Immediate Genie handoff delivery requires an explicit Human action.");
      }
      if (handoff.delivery === "send-current-room") {
        const roomId = currentRoomId(ports);
        await deliverDependency(
          "send-current-room",
          () => sendOrdinaryRoomMessage(ports.apiClient, roomId, { content }),
        );
        return;
      }
      const room = await deliverDependency(
        "create-room",
        () => ports.apiClient.createRoom({ label: roomLabelFor(handoff) }),
      );
      await deliverDependency(
        "send-new-room",
        () => sendOrdinaryRoomMessage(ports.apiClient, room.id, { content }),
      );
      try {
        await ports.refreshRooms();
        await ports.setActiveRoom(room.id);
      } catch {
        // The message is already a persisted ordinary Human message. Returning
        // its opaque Room id lets the caller recover without replaying it.
        throw new GenieHandoffPartialSuccessError(room.id);
      }
    },
  };
}
