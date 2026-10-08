/** The model selects an operation, never a PTY or an authority binding. */
export type HumanTerminalOperation =
  | Readonly<{ action: "read"; cursor?: number }>
  | Readonly<{ action: "run"; command: string }>
  | Readonly<{ action: "write"; data: string }>;

/** Trusted main/Relay admission only. Consent is specific to this whole tuple. */
export interface HumanTerminalOwner {
  readonly humanUserId: string;
  readonly agentId: string;
  readonly roomId: string;
  readonly conversationId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly pairingGeneration: string;
  readonly serverOrigin: string;
  readonly serverFingerprint: string;
}

/** Electron-local reference; never model arguments or discovery metadata. */
export interface HumanTerminalGrant {
  readonly owner: HumanTerminalOwner;
  readonly generation: string;
}

/** Human selection before a foreground turn exists. It cannot authorize input
 * until canonical source admission supplies the exact conversation binding. */
export type HumanTerminalConsentOwner = Omit<HumanTerminalOwner, "conversationId">;
export interface HumanTerminalConsent {
  readonly owner: HumanTerminalConsentOwner;
  readonly generation: string;
}

export type HumanTerminalResult =
  | Readonly<{ ok: true; action: HumanTerminalOperation["action"]; inputWritten: boolean;
      commandOutcome: "not_observed"; data: string; cursor: number; truncated: boolean;
      availableFrom: number; produced: number; cursorUnit: "utf16_code_units" }>
  | Readonly<{ ok: false; action: HumanTerminalOperation["action"];
      code: "invalid_request" | "grant_required" | "authority_changed" | "no_session" | "input_failed" | "outcome_unknown" | "invocation_conflict" | "capacity_reached";
      inputWritten: boolean | "unknown"; retrySafe: boolean }>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
export function parseHumanTerminalOperation(value: unknown): HumanTerminalOperation | null {
  if (!object(value)) return null;
  if (value["action"] === "read" && exact(value, value["cursor"] === undefined ? ["action"] : ["action", "cursor"])) {
    if (value["cursor"] === undefined) return { action: "read" };
    return typeof value["cursor"] === "number" && Number.isSafeInteger(value["cursor"]) && value["cursor"] >= 0
      ? { action: "read", cursor: value["cursor"] } : null;
  }
  if (value["action"] === "run" && exact(value, ["action", "command"]) && typeof value["command"] === "string"
    && value["command"].trim().length > 0 && !value["command"].includes("\0")) return { action: "run", command: value["command"] };
  return value["action"] === "write" && exact(value, ["action", "data"]) && typeof value["data"] === "string"
    ? { action: "write", data: value["data"] } : null;
}
export function parseHumanTerminalOwner(value: unknown): HumanTerminalOwner | null {
  const keys: readonly (keyof HumanTerminalOwner)[] = ["humanUserId", "agentId", "roomId", "conversationId", "relayId",
    "desktopSessionId", "pairingGeneration", "serverOrigin", "serverFingerprint"];
  if (!object(value) || !exact(value, keys) || !keys.every(key => typeof value[key] === "string"
    && value[key].length > 0 && value[key].trim() === value[key])) return null;
  try {
    const origin = new URL(value["serverOrigin"] as string);
    if (origin.origin !== value["serverOrigin"] || !["https:", "http:"].includes(origin.protocol) || origin.username || origin.password) return null;
  } catch { return null; }
  return { humanUserId: value["humanUserId"] as string, agentId: value["agentId"] as string,
    roomId: value["roomId"] as string, conversationId: value["conversationId"] as string,
    relayId: value["relayId"] as string, desktopSessionId: value["desktopSessionId"] as string,
    pairingGeneration: value["pairingGeneration"] as string, serverOrigin: value["serverOrigin"],
    serverFingerprint: value["serverFingerprint"] as string };
}
export function parseHumanTerminalConsentOwner(value: unknown): HumanTerminalConsentOwner | null {
  const keys: readonly (keyof HumanTerminalConsentOwner)[] = ["humanUserId", "agentId", "roomId", "relayId",
    "desktopSessionId", "pairingGeneration", "serverOrigin", "serverFingerprint"];
  if (!object(value) || !exact(value, keys) || !keys.every(key => typeof value[key] === "string"
    && value[key].length > 0 && value[key].trim() === value[key])) return null;
  try {
    const origin = new URL(value["serverOrigin"] as string);
    if (origin.origin !== value["serverOrigin"] || !["https:", "http:"].includes(origin.protocol) || origin.username || origin.password) return null;
  } catch { return null; }
  return { humanUserId: value["humanUserId"] as string, agentId: value["agentId"] as string, roomId: value["roomId"] as string,
    relayId: value["relayId"] as string, desktopSessionId: value["desktopSessionId"] as string,
    pairingGeneration: value["pairingGeneration"] as string, serverOrigin: value["serverOrigin"], serverFingerprint: value["serverFingerprint"] as string };
}
export function sameHumanTerminalConsentOwner(left: HumanTerminalConsentOwner, right: HumanTerminalConsentOwner): boolean {
  return left.humanUserId === right.humanUserId && left.agentId === right.agentId && left.roomId === right.roomId
    && left.relayId === right.relayId && left.desktopSessionId === right.desktopSessionId
    && left.pairingGeneration === right.pairingGeneration && left.serverOrigin === right.serverOrigin
    && left.serverFingerprint === right.serverFingerprint;
}
export function sameHumanTerminalOwner(left: HumanTerminalOwner, right: HumanTerminalOwner): boolean {
  return left.humanUserId === right.humanUserId && left.agentId === right.agentId && left.roomId === right.roomId
    && left.conversationId === right.conversationId && left.relayId === right.relayId
    && left.desktopSessionId === right.desktopSessionId && left.pairingGeneration === right.pairingGeneration
    && left.serverOrigin === right.serverOrigin && left.serverFingerprint === right.serverFingerprint;
}
