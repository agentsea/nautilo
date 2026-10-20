import {
  bolterConnectionObservationSchema, bolterNativeCommandSchema, bolterNativeResultSchema,
  bolterReceivedMessageSchema, bolterAttachmentPayloadSchema,
  type BolterAttachmentPayload,
  type BolterConnectionObservation, type BolterNativeCommand, type BolterNativeResult, type BolterReceivedMessage,
} from "@nautilo/types";
import { RELAY_HOST_CONTROL_MAX_BYTES } from "./desktop-host-protocol";

/** Finite adapter lane on the existing authenticated Desktop socket. */
export const BOLTER_RELAY_PROTOCOL_VERSION = 30 as const;
export const BOLTER_FILES_PROTOCOL_VERSION = 31 as const;
/** Matches the existing private Host framing ceiling; provider limits remain independently qualified. */
export const BOLTER_RELAY_MAX_FRAME_BYTES = RELAY_HOST_CONTROL_MAX_BYTES;
export type RelayBolterScope = Readonly<{
  relayId: string; relaySessionId: string; desktopSessionId: string; pairingGenerationRef: string;
  selectedProtocolVersion: number; capabilityRevision: number;
}>;
type Envelope = Readonly<{ version: typeof BOLTER_RELAY_PROTOCOL_VERSION; scope: RelayBolterScope }>;
export type RelayBolterCommand = Envelope & Readonly<{
  type: "relay:bolter-command"; correlationId: string; command: BolterNativeCommand;
}>;
export type RelayBolterResult = Envelope & Readonly<{
  type: "relay:bolter-result"; correlationId: string; result: BolterNativeResult;
}>;
export type RelayBolterObservation = Envelope & Readonly<{
  type: "relay:bolter-observation"; connectionId: string; generation: number; observation: BolterConnectionObservation;
}>;
export type RelayBolterBatch = Envelope & Readonly<{
  type: "relay:bolter-batch"; connectionId: string; generation: number; batchId: string; messages: readonly BolterReceivedMessage[];
}>;
export type RelayBolterBatchAck = Envelope & Readonly<{
  type: "relay:bolter-batch-ack"; connectionId: string; generation: number; batchId: string; status: "accepted" | "blocked";
}>;
export type BolterAuthorizedContent = Readonly<{ chatId: string; threadRootId: string | null; content: string; files?: readonly BolterAttachmentPayload[] }>;
export type RelayBolterAuthorize = Envelope & Readonly<{
  type: "relay:bolter-authorize"; correlationId: string; outboxId: string;
}>;
export type RelayBolterAuthorized = Envelope & Readonly<{
  type: "relay:bolter-authorized"; correlationId: string; outboxId: string; content: BolterAuthorizedContent | null;
}>;
export type RelayBolterServerMessage = RelayBolterCommand | RelayBolterBatchAck | RelayBolterAuthorized;
export type RelayBolterDesktopMessage = RelayBolterResult | RelayBolterObservation | RelayBolterBatch | RelayBolterAuthorize;
const scopeKeys = ["relayId", "relaySessionId", "desktopSessionId", "pairingGenerationRef", "selectedProtocolVersion", "capabilityRevision"] as const;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function opaque(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !/\s/u.test(value) && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127); }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
export function parseRelayBolterScope(value: unknown): RelayBolterScope | null {
  if (!record(value) || !exact(value, scopeKeys) || !scopeKeys.slice(0, 4).every(key => opaque(value[key]))
    || !positive(value["selectedProtocolVersion"]) || value["selectedProtocolVersion"] < BOLTER_RELAY_PROTOCOL_VERSION
    || typeof value["capabilityRevision"] !== "number" || !Number.isSafeInteger(value["capabilityRevision"]) || value["capabilityRevision"] < 0) return null;
  return value as RelayBolterScope;
}
export function sameRelayBolterScope(left: RelayBolterScope, right: RelayBolterScope): boolean {
  return scopeKeys.every(key => left[key] === right[key]);
}
export function isRelayBolterCapability(value: unknown): value is { version: 1; hostKind: "electron" } {
  return record(value) && exact(value, ["version", "hostKind"]) && value["version"] === 1 && value["hostKind"] === "electron";
}
function parse(value: unknown): RelayBolterServerMessage | RelayBolterDesktopMessage | null {
  try {
    if (!record(value) || value["version"] !== BOLTER_RELAY_PROTOCOL_VERSION || !parseRelayBolterScope(value["scope"])) return null;
    const wire = JSON.stringify(value);
    if (new TextEncoder().encode(wire).byteLength > BOLTER_RELAY_MAX_FRAME_BYTES) return null;
    const base = ["type", "version", "scope"];
    switch (value["type"]) {
      case "relay:bolter-authorize":
        return exact(value, [...base, "correlationId", "outboxId"]) && uuid(value["correlationId"]) && uuid(value["outboxId"]) ? value as RelayBolterAuthorize : null;
      case "relay:bolter-authorized": {
        const content = value["content"];
        return exact(value, [...base, "correlationId", "outboxId", "content"]) && uuid(value["correlationId"]) && uuid(value["outboxId"])
          && (content === null || record(content) && exact(content, ["chatId", "threadRootId", "content", ...(Object.hasOwn(content, "files") ? ["files"] : [])])
            && opaque(content["chatId"]) && (content["threadRootId"] === null || opaque(content["threadRootId"]))
            && typeof content["content"] === "string" && content["content"].length > 0
            && (!Object.hasOwn(content, "files") || (value["scope"] as RelayBolterScope).selectedProtocolVersion >= BOLTER_FILES_PROTOCOL_VERSION
              && Array.isArray(content["files"]) && content["files"].every(file => bolterAttachmentPayloadSchema.safeParse(file).success))) ? value as RelayBolterAuthorized : null;
      }
      case "relay:bolter-command":
        return exact(value, [...base, "correlationId", "command"]) && uuid(value["correlationId"]) && bolterNativeCommandSchema.safeParse(value["command"]).success ? value as RelayBolterCommand : null;
      case "relay:bolter-result":
        return exact(value, [...base, "correlationId", "result"]) && uuid(value["correlationId"]) && bolterNativeResultSchema.safeParse(value["result"]).success ? value as RelayBolterResult : null;
      case "relay:bolter-observation":
        return exact(value, [...base, "connectionId", "generation", "observation"]) && uuid(value["connectionId"]) && positive(value["generation"]) && bolterConnectionObservationSchema.safeParse(value["observation"]).success ? value as RelayBolterObservation : null;
      case "relay:bolter-batch":
        return exact(value, [...base, "connectionId", "generation", "batchId", "messages"]) && uuid(value["connectionId"]) && positive(value["generation"]) && opaque(value["batchId"])
          && Array.isArray(value["messages"]) && value["messages"].every(message => bolterReceivedMessageSchema.safeParse(message).success) ? value as RelayBolterBatch : null;
      case "relay:bolter-batch-ack":
        return exact(value, [...base, "connectionId", "generation", "batchId", "status"]) && uuid(value["connectionId"]) && positive(value["generation"]) && opaque(value["batchId"])
          && (value["status"] === "accepted" || value["status"] === "blocked") ? value as RelayBolterBatchAck : null;
      default: return null;
    }
  } catch { return null; }
}
export function parseRelayBolterServerMessage(value: unknown): RelayBolterServerMessage | null {
  const parsed = parse(value);
  return parsed?.type === "relay:bolter-command" || parsed?.type === "relay:bolter-batch-ack" || parsed?.type === "relay:bolter-authorized" ? parsed : null;
}
export function parseRelayBolterDesktopMessage(value: unknown): RelayBolterDesktopMessage | null {
  const parsed = parse(value);
  return parsed?.type === "relay:bolter-result" || parsed?.type === "relay:bolter-observation" || parsed?.type === "relay:bolter-batch" || parsed?.type === "relay:bolter-authorize" ? parsed : null;
}
