import {
  ComputerUseContextRegistry,
  type ComputerUseContextScope,
  type ComputerUseObservationCoverage,
  type ComputerUseProviderScreenSnapshot,
  type ComputerUseScreenSnapshotMetadata,
  type ComputerUseProviderTarget,
  type ComputerUseTargetEvidence,
  type RegisteredComputerTarget,
  type ComputerUseWindowReadTicket,
} from "./native-context-registry.js";
import type { CuaCheckedContextPort } from "./native-cua-lifecycle.js";
import { isPinnedCuaBundleIdentifier, cuaPixelClickArguments, type CuaPixelClickOptions, type CuaContextToolCallResult, type CuaContextToolName, type CuaContextToolResult, type CuaWindowCaptureResult, type CuaWindowTraversalEffort } from "./native-cua-supervisor.js";
import { parseBoundedPngDimensions } from "./native-image-contract.js";
import type {
  ComputerDoFocusRequest,
  ComputerObserveRequest,
  ComputerObserveResult,
  ComputerUseOperationOutcome,
} from "./native-semantic-contracts.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Jimp, JimpMime } from "jimp";
import { COMPUTER_USE_HOST_PNG_MAX_BYTES } from "@nautilo/computer-use-host-protocol";
import { normalizeCuaMacosKey, normalizeCuaMacosHotkey, type ComputerNativeControlState, type ComputerNativeControlCollection } from "@nautilo/computer-use-contracts/native";

const execFileAsync = promisify(execFile);
const HUMAN_INPUT_EPOCH_TOLERANCE_MILLISECONDS = 100;

/** The only physical-input fact used by this provider is macOS IOHIDSystem's idle clock. */
export type CuaReadHidIdleNanoseconds = () => Promise<number>;

class CuaExternalInterferenceError extends Error {
  constructor() {
    super("Local mouse or keyboard input interrupted the desktop operation.");
  }
}

export async function readMacosHidIdleNanoseconds(): Promise<number> {
  const { stdout } = await execFileAsync("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-r", "-d", "1"], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  const match = stdout.match(/"HIDIdleTime"\s*=\s*([0-9]+)/);
  const value = Number(match?.[1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("macOS HID idle clock was unavailable");
  return value;
}

/**
 * This is intentionally a host classifier rather than a Cua condition.  A
 * reset can only mean that attribution is no longer exclusive; it never
 * becomes provider prose or a claim that Cua refused an action.
 */

/** This foundation is intentionally constructed only from a readiness-checked port. */
export interface CuaComputerUseAdapterOptions {
  readonly port: CuaCheckedContextPort;
  readonly registry?: ComputerUseContextRegistry;
  readonly maxWindows?: number;
  /** Test seam; production reads the macOS IOHIDSystem idle clock. */
  readonly readHidIdleNanoseconds?: CuaReadHidIdleNanoseconds;
  /** Test seam; separate from operation deadlines to remain monotonic. */
  readonly monotonicMilliseconds?: () => number;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/** The checked Cua route preserves its true provider in every receipt. */
export interface CuaComputerMutationReceipt {
  readonly version: 1;
  readonly timing: "immediate";
  readonly action: "focus" | "click" | "type_text" | "set_value" | "scroll" | "press_key" | "hotkey" | "drag_drop" | "invoke_menu" | "set_window_frame" | "create_window" | "move_pointer";
  readonly target: { readonly version: 1; readonly context: string; readonly reference: string };
  readonly resolvedTarget: ComputerUseTargetEvidence
    | Readonly<{ kind: "app"; state: "unavailable" }>
    | Readonly<{ kind: "element"; state: "unavailable" }>;
  readonly provider: "cua";
  readonly deliveryMode: "background" | "foreground" | "foreground_escalated" | "not_applicable" | "not_delivered" | "unknown";
  readonly completionCertainty: "completed" | "partially_completed" | "not_completed" | "unknown_completion";
  readonly verification: "verified" | "not_verified" | "unavailable";
  readonly textDelivery?: Readonly<{ requestedCharacters: number; deliveredCharacters: number | null; maxChunkCharacters?: number }>;
  /** Closed, content-free Cua ActionResult projection; null when no success action result exists. */
  readonly providerAction?: Readonly<{
    effect: "confirmed" | "partial" | "unverifiable" | "suspected_noop" | "refused";
    route: "accessibility" | "synthetic_events" | "global_input" | "system_api" | "dom" | "trusted_input";
    delivery: Readonly<{ mode: "background" | "foreground" | "not_applicable" | "unknown"; deliveredCount?: number }> | null;
    evidenceKinds: readonly ("value_readback" | "window_change" | "native_api_result")[];
    escalation: Readonly<{ target: "pixel" | "foreground" | "page" | "session"; reason: "route_unavailable" | "delivery_failed" | "effect_unconfirmed" | "suspected_noop" | "permission_required" }> | null;
  }> | null;
  readonly postObservation?: CuaAppearedWindowPostObservation;
  readonly unexecutedRemainder: { readonly count: number; readonly reason: "none" | "failed" | "unknown_completion" | "cancelled" };
  readonly outcome: ComputerUseOperationOutcome;
}

export type CuaComputerDoResult =
  | { readonly ok: true; readonly receipt: CuaComputerMutationReceipt }
  | { readonly ok: false; readonly receipt: CuaComputerMutationReceipt; readonly error: string; readonly outcome: ComputerUseOperationOutcome };

export type CuaComputerDoClickRequest = Readonly<{
  scope: ComputerUseContextScope;
  signal?: AbortSignal;
  operation: Readonly<{
    kind: "click";
    target: Readonly<{ context: string; reference: string }>;
    coordinateSpace: "presented_snapshot_pixels" | "window_snapshot_pixels";
    x: number;
    y: number;
    deliveryMode?: "background" | "foreground";
  } & CuaPixelClickOptions> | Readonly<{
    kind: "click";
    target: Readonly<{ context: string; reference: string }>;
    axAction?: "press" | "show_menu" | "pick" | "confirm" | "cancel" | "open";
    button?: "left" | "right" | "middle";
    modifiers?: readonly ("cmd" | "shift" | "option" | "alt" | "ctrl")[];
    deliveryMode?: "background" | "foreground";
  }>;
}>;

export interface CuaComputerDoDragDropRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "drag_drop";
    target: Readonly<{ context: string; reference: string }>;
    coordinateSpace: "window_snapshot_pixels" | "presented_snapshot_pixels";
    from: Readonly<{ x: number; y: number }>;
    to: Readonly<{ x: number; y: number }>;
    durationMs?: number;
    steps?: number;
    button?: "left" | "right" | "middle";
    modifiers?: readonly ("cmd" | "shift" | "option" | "alt" | "ctrl")[];
    deliveryMode?: "background" | "foreground";
  }>;
}

/** Text remains request-only: no receipt, error, registry record, or log carries it. */
export interface CuaComputerDoSemanticTypeTextRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "type_text";
    target: Readonly<{ context: string; reference: string }>;
    text: string;
    delayMs?: number;
    deliveryMode?: "background" | "foreground";
  }>;
}

export interface CuaComputerDoCoordinateTypeTextRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "type_text";
    target: Readonly<{ context: string; reference: string }>;
    coordinateSpace: "window_snapshot_pixels" | "presented_snapshot_pixels";
    x: number;
    y: number;
    text: string;
    delayMs?: number;
    deliveryMode?: "background" | "foreground";
  }>;
}

export interface CuaComputerDoDesktopTypeTextRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "type_text";
    scope: "desktop";
    target: Readonly<{ context: string; reference: string }>;
    text: string;
    delayMs?: number;
  }>;
}

export type CuaComputerDoTypeTextRequest = CuaComputerDoSemanticTypeTextRequest | CuaComputerDoCoordinateTypeTextRequest | CuaComputerDoDesktopTypeTextRequest;

/** Value is request-only: receipts retain no prior, requested or observed content. */
export interface CuaComputerDoSetValueRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "set_value";
    target: Readonly<{ context: string; reference: string }>;
    value: string;
  }>;
}

export interface CuaComputerDoElementScrollRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "scroll";
    target: Readonly<{ context: string; reference: string }>;
    direction: "up" | "down" | "left" | "right";
    amount: number;
    by: "line" | "page";
    deliveryMode?: "background" | "foreground";
  }>;
}

export interface CuaComputerDoCoordinateScrollRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "scroll";
    target: Readonly<{ context: string; reference: string }>;
    coordinateSpace: "window_snapshot_pixels" | "presented_snapshot_pixels";
    x: number;
    y: number;
    direction: "up" | "down" | "left" | "right";
    amount: number;
    by: "line" | "page";
    deliveryMode?: "background" | "foreground";
  }>;
}

export type CuaComputerDoScrollRequest = CuaComputerDoElementScrollRequest | CuaComputerDoCoordinateScrollRequest;

export interface CuaComputerDoSemanticPressKeyRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "press_key";
    target: Readonly<{ context: string; reference: string }>;
    key: string;
    modifiers: readonly string[];
    deliveryMode?: "background" | "foreground";
  }>;
}

export interface CuaComputerDoCoordinatePressKeyRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "press_key";
    target: Readonly<{ context: string; reference: string }>;
    coordinateSpace: "window_snapshot_pixels" | "presented_snapshot_pixels";
    x: number;
    y: number;
    key: string;
    modifiers: readonly string[];
    deliveryMode?: "background" | "foreground";
  }>;
}

export interface CuaComputerDoDesktopPressKeyRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "press_key";
    scope: "desktop";
    target: Readonly<{ context: string; reference: string }>;
    key: string;
    modifiers: readonly string[];
  }>;
}

export type CuaComputerDoPressKeyRequest = CuaComputerDoSemanticPressKeyRequest | CuaComputerDoCoordinatePressKeyRequest | CuaComputerDoDesktopPressKeyRequest;

type HotkeyRequest<T extends CuaComputerDoPressKeyRequest> = T extends CuaComputerDoPressKeyRequest
  ? Omit<T, "operation"> & { readonly operation: Omit<T["operation"], "kind" | "key" | "modifiers"> & { readonly kind: "hotkey"; readonly keys: readonly string[] } }
  : never;
export type CuaComputerDoHotkeyRequest = HotkeyRequest<CuaComputerDoPressKeyRequest>;

export interface CuaComputerDoMovePointerRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "move_pointer";
    scope: "desktop";
    target: Readonly<{ context: string; reference: string }>;
    coordinateSpace: "presented_snapshot_pixels";
    x: number;
    y: number;
  }>;
}

export interface CuaComputerDoInvokeMenuRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "invoke_menu";
    target: Readonly<{ context: string; reference: string }>;
    menuPath: readonly string[];
  }>;
}

export interface CuaComputerDoSetWindowFrameRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "set_window_frame";
    target: Readonly<{ context: string; reference: string }>;
    frame: Readonly<{ x: number; y: number; width: number; height: number }>;
  }>;
}

export interface CuaComputerDoCreateWindowRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "create_window";
    target: Readonly<{ context: string; reference: string }>;
    menuPath: readonly string[];
  }>;
}

export type CuaAppearedWindowPostObservation = Readonly<{
  version: 1;
  kind: "appeared_window";
  disposition: "none_observed" | "unique" | "ambiguous" | "incomplete";
  app?: Readonly<{
    target: Readonly<{ version: 1; context: string; reference: string }>;
    evidence: Readonly<{ kind: "app"; appLabel: string }>;
  }>;
  window?: Readonly<{
    target: Readonly<{ version: 1; context: string; reference: string }>;
    evidence: Readonly<{ kind: "window" }>;
  }>;
}>;

/** Content-free projection of Cua VerifyStateOutput. `observed_json` never crosses this seam. */
export interface CuaComputerVerifyRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly target: Readonly<{ context: string; reference: string }>;
  readonly expect: readonly Readonly<Record<string, unknown>>[];
}

/** Semantic launch is the sole operation that begins without an opaque target. */
export interface CuaComputerLaunchRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{ readonly kind: "launch_app"; readonly app: Readonly<{ readonly name: string }> }>;
}

export type CuaComputerLaunchReceipt = Readonly<{
  version: 1;
  timing: "immediate";
  action: "launch_app";
  app: Readonly<{ name: string; target: Readonly<{ version: 1; context: string; reference: string }> | null }>;
  window: Readonly<{ version: 1; context: string; reference: string }> | null;
  launchProgress: Readonly<{ requested: boolean; processRunning: boolean; windowReady: boolean }> | null;
  windowSelection: "none" | "unique" | "ambiguous" | "unknown";
  completionCertainty: "completed" | "not_completed" | "unknown_completion";
  verification: "required" | "not_applicable";
  outcome: ComputerUseOperationOutcome;
}>;

export type CuaComputerLaunchResult =
  | { readonly ok: true; readonly receipt: CuaComputerLaunchReceipt }
  | { readonly ok: false; readonly receipt: CuaComputerLaunchReceipt; readonly error: string; readonly outcome: ComputerUseOperationOutcome };

export interface CuaWindowStateObserveRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly target: Readonly<{ context: string; reference: string }>;
  readonly capture?: "window_snapshot";
  /** Positive semantic evidence search; never an element-action selector. */
  readonly query?: string;
  /** Exact caller-requested AX traversal bounds; omitted fields use provider defaults. */
  readonly effort?: CuaWindowTraversalEffort;
  /** Explicit semantic capability request; no implicit write authority. */
  readonly selector?: Readonly<{
    role: string;
    labelEquals?: string;
    interaction?: "right_click" | "double_click";
    action?: "scroll" | "click" | "type_text" | "set_value" | "press_key";
  }>;
}

export type CuaWindowStateObserveResult =
  | { readonly ok: true; readonly observation: Readonly<{
    version: 1; operation: "window_state"; target: Readonly<{ version: 1; context: string; reference: string }>;
    evidence: ComputerUseTargetEvidence | null; completeness: "sufficient" | "partial" | "unavailable";
    degraded: boolean; verification: "supported" | "indeterminate" | "unavailable";
    controlCollection?: ComputerNativeControlCollection;
    element?: Readonly<{
      selector: Readonly<{ role: string; interaction?: "right_click" | "double_click"; action?: "scroll" | "click" | "type_text" | "set_value" | "press_key" }>;
      disposition: "zero" | "unique" | "ambiguous" | "incomplete";
      target?: Readonly<{ version: 1; context: string; reference: string }>;
      evidence?: Readonly<
        { kind: "element"; role: string; action: "type_text" | "scroll" | "set_value" | "click" | "right_click" | "double_click" | "press_key"; enabled?: boolean }
      >;
      state?: ComputerNativeControlState;
    }>;
    windowSnapshot?: Readonly<{
      target: Readonly<{ version: 1; context: string; reference: string }>;
      evidence: Readonly<{ kind: "screen" }>;
      metadata: Readonly<{ format: "png"; dimensions: Readonly<{ width: number; height: number }>; coordinateSpace: "window_snapshot_pixels" }>;
    }>;
    semanticQuery?: Readonly<{
      query: string; effort?: CuaWindowTraversalEffort; exhaustive: false; matched: number; returned: number; omitted: number;
      matches: readonly Readonly<{
        role: string;
        label?: string; value?: string; labelTruncated: boolean; valueTruncated: boolean;
      }>[];
    }>;
    outcome: ComputerUseOperationOutcome;
  }>; readonly visionImage?: Readonly<{ mime: "image/png"; bytes: Uint8Array }> }
  | { readonly ok: false; readonly error: string; readonly outcome: ComputerUseOperationOutcome };

export interface CuaWindowRegionObserveRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly target: Readonly<{ context: string; reference: string }>;
  readonly coordinateSpace: "window_snapshot_pixels" | "presented_snapshot_pixels";
  readonly region: Readonly<{ x: number; y: number; width: number; height: number }>;
}

export type CuaWindowRegionObserveResult =
  | { readonly ok: true; readonly observation: Readonly<{
    version: 1;
    operation: "window_region";
    source: Readonly<{ version: 1; context: string; reference: string }>;
    regionSnapshot: Readonly<{
      target: Readonly<{ version: 1; context: string; reference: string }>;
      evidence: Readonly<{ kind: "screen" }>;
      metadata: Readonly<{
        format: "png";
        dimensions: Readonly<{ width: number; height: number }>;
        coordinateSpace: "presented_snapshot_pixels";
      }>;
    }>;
    outcome: ComputerUseOperationOutcome;
  }>; readonly visionImage: Readonly<{ mime: "image/png"; bytes: Uint8Array }> }
  | { readonly ok: false; readonly error: string; readonly outcome: ComputerUseOperationOutcome };

export interface CuaApplicationWindowsObserveRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly target: Readonly<{ context: string; reference: string }>;
  readonly query?: string;
  readonly effort?: CuaWindowTraversalEffort;
}

export type CuaApplicationWindowsObserveResult =
  | { readonly ok: true; readonly observation: Readonly<{
    version: 1; operation: "application_windows"; target: Readonly<{ version: 1; context: string; reference: string }>;
    completeness: "complete" | "partial" | "unavailable"; discovered: number; returned: number; omitted: number;
    candidates: readonly Readonly<{
      target: Readonly<{ version: 1; context: string; reference: string }>;
      evidence: ComputerUseTargetEvidence;
      semanticQuery?: ParsedWindowSemanticQuery;
      semanticQueryUnavailable?: Readonly<{ query: string; status: "unavailable"; recovery: "focus_target" | "observe_again" }>;
    }>[];
    semanticQuery?: Readonly<{ query: string; effort?: CuaWindowTraversalEffort; exhaustive: false; inspected: number; uninspected: number }>;
    outcome: ComputerUseOperationOutcome;
  }> }
  | { readonly ok: false; readonly error: string; readonly outcome: ComputerUseOperationOutcome };

export type CuaComputerVerifyResult =
  | {
    readonly ok: true;
    readonly verification: Readonly<{
      version: 1;
      target: Readonly<{ version: 1; context: string; reference: string }>;
      provider: "cua";
      status: "satisfied" | "unsatisfied" | "unknown";
      stable: boolean;
      elapsedMs: number;
      samples: number;
      predicates: readonly Readonly<{
        index: number;
        status: "satisfied" | "unsatisfied" | "unknown";
        unknownReason: "invalid_predicate" | "unsupported_predicate" | "untrusted_source" | "multi_match" | "target_missing" | "observation_unavailable" | "stability_unproven" | null;
      }>[];
      outcome: ComputerUseOperationOutcome;
    }>;
  }
  | { readonly ok: false; readonly error: string; readonly outcome: ComputerUseOperationOutcome };

type CuaVerificationReceipt = Extract<CuaComputerVerifyResult, { readonly ok: true }>["verification"];

interface ParsedApplication {
  readonly pid: number;
  readonly name: string;
  readonly bundleId: string | undefined;
  readonly active: boolean;
}

interface ParsedApplications {
  readonly applications: readonly ParsedApplication[];
  readonly uninspectedApplications: number;
}

interface ParsedInstalledApplication {
  readonly name: string;
  readonly bundleId: string | undefined;
  readonly pid: number;
  readonly running: boolean;
}

interface ParsedWindow {
  readonly windowId: number;
  readonly pid: number;
  readonly appName: string;
  readonly title: string;
  readonly bounds: NonNullable<ComputerUseTargetEvidence["bounds"]>;
  readonly layer: number;
  readonly zIndex: number | null;
  readonly onScreen: boolean;
  /**
   * Private app-scoped admission only. Cua's list/launch arrays are raw
   * layer-zero WindowServer inventory; a titled, positive-size row is merely
   * a candidate for exact AX resolution, never proof of actionability.
   */
  readonly appWindowCandidate: boolean;
}

interface ParsedWindows {
  readonly windows: readonly ParsedWindow[];
  readonly uninspectedWindows: number;
}

interface Lease {
  readonly generation: string;
  readonly sessionId: string;
}

const DEFAULT_MAX_WINDOWS = 25;
const MAX_WINDOWS = 100;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

function list(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function signedInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type WindowSnapshotFrame = Readonly<{
  pid: number;
  windowId: number;
  windowWidth: number;
  windowHeight: number;
  width: number;
  height: number;
  origin: Readonly<{ x: number; y: number }>;
  coordinateSpace: "window_snapshot_pixels" | "presented_snapshot_pixels";
}>;

/** Resolve only a self-consistent full-window or Host-derived precision frame. */
function windowSnapshotFrame(
  metadata: ComputerUseScreenSnapshotMetadata,
  providerSnapshot: ComputerUseProviderScreenSnapshot,
): WindowSnapshotFrame | null {
  if (!("coordinateSpace" in metadata)) return null;
  if (providerSnapshot.kind === "window") {
    if (metadata.coordinateSpace !== "window_snapshot_pixels"
      || metadata.dimensions.width !== providerSnapshot.width
      || metadata.dimensions.height !== providerSnapshot.height) return null;
    return {
      pid: providerSnapshot.pid,
      windowId: providerSnapshot.windowId,
      windowWidth: providerSnapshot.width,
      windowHeight: providerSnapshot.height,
      width: providerSnapshot.width,
      height: providerSnapshot.height,
      origin: { x: 0, y: 0 },
      coordinateSpace: "window_snapshot_pixels",
    };
  }
  if (providerSnapshot.kind !== "window_region"
    || metadata.coordinateSpace !== "presented_snapshot_pixels"
    || metadata.dimensions.width !== providerSnapshot.width
    || metadata.dimensions.height !== providerSnapshot.height
    || providerSnapshot.origin.x < 0 || providerSnapshot.origin.y < 0
    || providerSnapshot.origin.x + providerSnapshot.width > providerSnapshot.windowWidth
    || providerSnapshot.origin.y + providerSnapshot.height > providerSnapshot.windowHeight) return null;
  return {
    pid: providerSnapshot.pid,
    windowId: providerSnapshot.windowId,
    windowWidth: providerSnapshot.windowWidth,
    windowHeight: providerSnapshot.windowHeight,
    width: providerSnapshot.width,
    height: providerSnapshot.height,
    origin: { ...providerSnapshot.origin },
    coordinateSpace: "presented_snapshot_pixels",
  };
}

function windowPoint(frame: WindowSnapshotFrame, x: number, y: number): Readonly<{ x: number; y: number }> | null {
  if (!Number.isFinite(x) || x < 0 || x >= frame.width
    || !Number.isFinite(y) || y < 0 || y >= frame.height) return null;
  return { x: frame.origin.x + x, y: frame.origin.y + y };
}

function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = [...value].filter((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint > 31 && codePoint !== 127 && codePoint !== 0x2028 && codePoint !== 0x2029;
  }).join("").trim();
  return cleaned.length === 0 ? undefined : cleaned;
}

function exactHostIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.trim() !== value) return undefined;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 31 || codePoint === 127 || codePoint === 0x2028 || codePoint === 0x2029) return undefined;
  }
  return value;
}

function bundleIdentifier(value: unknown): string | undefined {
  const identifier = exactHostIdentifier(value);
  return identifier !== undefined && isPinnedCuaBundleIdentifier(identifier)
    ? identifier : undefined;
}

/** Provider identity used to select/confirm launch is never sanitized. */
function exactSemanticLabel(value: unknown): string | undefined {
  const candidate = label(value);
  return candidate !== undefined && candidate === value ? candidate : undefined;
}

function structured(result: CuaContextToolResult): Readonly<Record<string, unknown>> | null {
  return result.isError ? null : result.structuredContent;
}

function parseApplications(result: CuaContextToolResult): ParsedApplications | null {
  const data = structured(result);
  const rawApps = data === null ? null : list(data["apps"]);
  if (rawApps === null) return null;
  const applications: ParsedApplication[] = [];
  const seenPids = new Set<number>();
  for (const raw of rawApps) {
    const app = record(raw);
    if (app === null) return null;
    const pid = nonnegativeInteger(app["pid"]);
    const name = label(app["name"]);
    const rawBundleId = app["bundle_id"];
    const bundleId = rawBundleId === null ? undefined : exactHostIdentifier(rawBundleId);
    const active = app["active"];
    const running = app["running"];
    // Cua lists installed applications too. A non-running entry is truthful
    // inventory but cannot become a host capability; a running entry must
    // have a positive, non-reused process id.
    if (pid === undefined || name === undefined || (rawBundleId !== null && bundleId === undefined)
      || typeof active !== "boolean" || typeof running !== "boolean"
      || (running && pid <= 0) || (!running && pid !== 0)) return null;
    if (pid > 0) {
      if (seenPids.has(pid)) return null;
      seenPids.add(pid);
    }
    if (running) applications.push({ pid, name, bundleId, active });
  }
  return { applications, uninspectedApplications: 0 };
}

/**
 * `list_apps` is private discovery only here. Unlike desktop observation it
 * inspects every item in the supervisor's 1MiB raw-protocol containment
 * envelope, so an exact requested name cannot select the first item in a
 * display-truncated inventory. The upstream app-record is additive (it
 * carries launch_path/kind/last_used/windows), therefore only its pinned
 * identity/liveness fields are checked here and the rest stay private.
 */
function parseInstalledApplications(result: CuaContextToolResult): readonly ParsedInstalledApplication[] | null {
  const data = structured(result);
  const rawApps = data === null ? null : list(data["apps"]);
  if (rawApps === null) return null;
  const applications: ParsedInstalledApplication[] = [];
  for (const raw of rawApps) {
    const app = record(raw);
    if (app === null) return null;
    const name = exactSemanticLabel(app["name"]);
    const rawBundleId = app["bundle_id"];
    const bundleId = rawBundleId === null ? undefined : bundleIdentifier(rawBundleId);
    const pid = nonnegativeInteger(app["pid"]);
    const active = app["active"];
    const running = app["running"];
    if (name === undefined || (rawBundleId !== null && bundleId === undefined) || pid === undefined || typeof active !== "boolean" || typeof running !== "boolean"
      || (running && pid <= 0) || (!running && pid !== 0) || (active && !running)) return null;
    applications.push({ name, bundleId, pid, running });
  }
  return applications;
}

function parseBounds(value: unknown): NonNullable<ComputerUseTargetEvidence["bounds"]> | null {
  const bounds = record(value);
  if (bounds === null) return null;
  const x = finiteNumber(bounds["x"]);
  const y = finiteNumber(bounds["y"]);
  const width = finiteNumber(bounds["width"]);
  const height = finiteNumber(bounds["height"]);
  return x === undefined || y === undefined || width === undefined || height === undefined || width < 0 || height < 0
    ? null
    : { x, y, width, height };
}

/** The launch response carries the exact fixed WindowServer bounds shape. */
function parseLaunchBounds(value: unknown): NonNullable<ComputerUseTargetEvidence["bounds"]> | null {
  const bounds = record(value);
  if (bounds === null || !exactKeys(bounds, ["x", "y", "width", "height"])) return null;
  const x = finiteNumber(bounds["x"]);
  const y = finiteNumber(bounds["y"]);
  const width = finiteNumber(bounds["width"]);
  const height = finiteNumber(bounds["height"]);
  return x === undefined || y === undefined || width === undefined || height === undefined || width < 0 || height < 0
    ? null
    : { x, y, width, height };
}

function nullableNonnegativeInteger(value: unknown): boolean {
  return value === null || nonnegativeInteger(value) !== undefined;
}

/**
 * A retained AppKit window can survive close with positive historical bounds
 * while no longer belonging to any Space. Preserve real off-Space/minimized
 * windows, but do not publish that unlocated retained object as actionable.
 */
function isLocatedWindowSurface(
  onScreen: boolean,
  onCurrentSpace: boolean | null,
  spaceIds: readonly unknown[] | null,
): boolean {
  return onScreen || onCurrentSpace !== null || (spaceIds !== null && spaceIds.length > 0);
}

function parseWindows(
  result: CuaContextToolResult,
  applications?: ReadonlyMap<number, ParsedApplication>,
): ParsedWindows | null {
  const data = structured(result);
  const rawWindows = data === null ? null : list(data["windows"]);
  if (data === null || rawWindows === null || !nullableNonnegativeInteger(data["current_space_id"])) return null;
  const windows: ParsedWindow[] = [];
  const seenWindowIds = new Set<number>();
  for (const raw of rawWindows) {
    const window = record(raw);
    if (window === null) return null;
    const windowId = positiveInteger(window["window_id"]);
    const pid = positiveInteger(window["pid"]);
    const appName = exactSemanticLabel(window["app_name"]);
    const rawTitle = window["title"];
    const semanticTitle = label(rawTitle);
    const title = typeof rawTitle === "string" && rawTitle.trim().length === 0 ? "Untitled window" : semanticTitle;
    const bounds = parseBounds(window["bounds"]);
    const layer = signedInteger(window["layer"]);
    const zIndex = window["z_index"];
    const onScreen = window["is_on_screen"];
    const onCurrentSpace = window["on_current_space"];
    const spaceIds = window["space_ids"];
    if (windowId === undefined || pid === undefined || appName === undefined || title === undefined || bounds === null
      || layer !== 0 || (zIndex !== null && signedInteger(zIndex) === undefined)
      || typeof onScreen !== "boolean" || (onCurrentSpace !== null && typeof onCurrentSpace !== "boolean")
      || !nullableNonnegativeInteger(window["current_space_id"])
      || (spaceIds !== null && (!Array.isArray(spaceIds) || !spaceIds.every((space) => nonnegativeInteger(space) !== undefined)))) return null;
    if (seenWindowIds.has(windowId)) return null;
    seenWindowIds.add(windowId);
    const application = applications?.get(pid);
    // A valid window with no same-session application row cannot be attributed
    // safely. The complete list_apps response is inspected, so this is an
    // identity mismatch rather than a local inventory cutoff.
    if (applications !== undefined && application === undefined) continue;
    // `list_apps.name` and WindowServer's `list_windows.app_name` are
    // presentation labels, not an identity join. macOS legitimately reports
    // spelling variants for the same observed process (for example
    // "Proton VPN" versus "ProtonVPN"). The fresh same-session PID is the
    // join key; use the application inventory's canonical label whenever that
    // PID was inspected instead of rejecting the entire desktop observation.
    windows.push({
      windowId,
      pid,
      appName: application?.name ?? appName,
      title,
      bounds,
      layer,
      zIndex: zIndex as number | null,
      onScreen,
      // A title is presentation, not window identity. Located untitled windows
      // remain candidates; their accessibility/input readiness is checked later.
      appWindowCandidate: bounds.width > 0 && bounds.height > 0
        && isLocatedWindowSurface(onScreen, onCurrentSpace, spaceIds as readonly unknown[] | null),
    });
  }
  return { windows, uninspectedWindows: applications === undefined ? 0 : rawWindows.length - windows.length };
}

type ParsedLaunch =
  | { readonly kind: "success"; readonly pid: number; readonly bundleId: string; readonly name: string; readonly windows: readonly ParsedWindow[]; readonly rawWindowCount: number; readonly progress: Readonly<{ requested: boolean; processRunning: boolean; windowReady: boolean }> }
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly progress: Readonly<{ requested: boolean; processRunning: boolean; windowReady: boolean }> }
  | { readonly kind: "unknown" }
  | { readonly kind: "malformed" };

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  // Cua's provider schemas are additive. These are exact required semantic
  // keys, not an assertion that a private provider object has no other fields.
  // Known fields are still validated below and contradictory values still
  // fence the response; unconsumed additions never cross the Host boundary.
  return keys.every((key) => Object.hasOwn(value, key));
}

function parseLaunchProgress(value: unknown): Readonly<{ requested: boolean; processRunning: boolean; windowReady: boolean }> | null {
  const state = record(value);
  if (state === null || !exactKeys(state, ["requested", "process_running", "window_ready"])
    || typeof state["requested"] !== "boolean" || typeof state["process_running"] !== "boolean" || typeof state["window_ready"] !== "boolean"
    || (!state["requested"] && (state["process_running"] || state["window_ready"]))
    || (!state["process_running"] && state["window_ready"])) return null;
  return { requested: state["requested"], processRunning: state["process_running"], windowReady: state["window_ready"] };
}

/** Literal `list_windows::window_record_json` emitted by pinned launch_app. */
const LAUNCH_WINDOW_RECORD_KEYS = [
  "window_id", "pid", "app_name", "title", "bounds", "layer", "z_index", "is_on_screen",
  "current_space_id", "on_current_space", "space_ids",
] as const;

function parseLaunchWindows(value: unknown, pid: number, returnedName: string): Readonly<{ windows: readonly ParsedWindow[]; rawWindowCount: number }> | null {
  const rawWindows = list(value);
  if (rawWindows === null) return null;
  const windows: ParsedWindow[] = [];
  const seen = new Set<number>();
  for (const raw of rawWindows) {
    const window = record(raw);
    if (window === null || !exactKeys(window, LAUNCH_WINDOW_RECORD_KEYS)) return null;
    const windowId = positiveInteger(window["window_id"]);
    const windowPid = positiveInteger(window["pid"]);
    const appName = exactSemanticLabel(window["app_name"]);
    const semanticTitle = label(window["title"]);
    const title = typeof window["title"] === "string" && window["title"].trim().length === 0 ? "Untitled window" : semanticTitle;
    const bounds = parseLaunchBounds(window["bounds"]);
    const layer = signedInteger(window["layer"]);
    if (windowId === undefined || windowPid !== pid || appName === undefined || title === undefined || bounds === null || layer !== 0
      || nonnegativeInteger(window["z_index"]) === undefined || typeof window["is_on_screen"] !== "boolean"
      || !nullableNonnegativeInteger(window["current_space_id"]) || (window["on_current_space"] !== null && typeof window["on_current_space"] !== "boolean")
      || (window["space_ids"] !== null && (!Array.isArray(window["space_ids"]) || !window["space_ids"].every((id) => nonnegativeInteger(id) !== undefined)) ) || seen.has(windowId)) return null;
    seen.add(windowId);
    windows.push({
      windowId, pid: windowPid, appName: returnedName, title, bounds, layer,
      zIndex: window["z_index"] as number, onScreen: window["is_on_screen"],
      appWindowCandidate: bounds.width > 0 && bounds.height > 0
        && isLocatedWindowSurface(
          window["is_on_screen"],
          window["on_current_space"],
          window["space_ids"] as readonly unknown[] | null,
        ),
    });
  }
  return { windows: windows.filter((window) => window.appWindowCandidate), rawWindowCount: windows.length };
}

function parseLaunch(result: CuaContextToolResult, expected: Readonly<{ bundleId: string }>): ParsedLaunch {
  const data = result.structuredContent;
  if (!result.isError) {
    if (data === null || !exactKeys(data, Object.hasOwn(data, "self_activation_suppressed")
      ? ["pid", "bundle_id", "name", "windows", "launch_state", "self_activation_suppressed"]
      : ["pid", "bundle_id", "name", "windows", "launch_state"])) return { kind: "malformed" };
    const pid = positiveInteger(data["pid"]);
    const bundleId = bundleIdentifier(data["bundle_id"]);
    const name = exactSemanticLabel(data["name"]);
    const progress = parseLaunchProgress(data["launch_state"]);
    if (pid === undefined || bundleId === undefined || name === undefined || bundleId !== expected.bundleId || progress === null
      || (data["self_activation_suppressed"] !== undefined && typeof data["self_activation_suppressed"] !== "boolean")) return { kind: "malformed" };
    const parsedWindows = parseLaunchWindows(data["windows"], pid, name);
    if (parsedWindows === null || progress.requested !== true || progress.processRunning !== true
      || progress.windowReady !== (parsedWindows.rawWindowCount > 0)) return { kind: "malformed" };
    return {
      kind: "success", pid, bundleId, name, windows: parsedWindows.windows,
      rawWindowCount: parsedWindows.rawWindowCount,
      // Provider window_ready only proves a raw layer-zero surface appeared.
      // Public readiness means at least one app-scoped candidate survived the
      // conservative title/geometry admission boundary.
      progress: { ...progress, windowReady: parsedWindows.windows.length > 0 },
    };
  }
  if (data === null) return { kind: "unknown" };
  const error = data["error"];
  if (error === "APP_NOT_INSTALLED") {
    if (!exactKeys(data, ["error", "bundle_id"]) || data["bundle_id"] !== expected.bundleId) return { kind: "malformed" };
    return { kind: "refused" };
  }
  if (error === "PROTECTED_HOST_ENTRYPOINT") return exactKeys(data, ["error"]) ? { kind: "refused" } : { kind: "malformed" };
  if (["NSWORKSPACE_LAUNCH_FAILED", "LAUNCH_RESULT_MISSING", "LAUNCH_CALLBACK_TIMEOUT", "APP_URL_INVALID", "LAUNCH_FAILED"].includes(String(error))) {
    if (!exactKeys(data, ["error", "launch_state"])) return { kind: "malformed" };
    const progress = parseLaunchProgress(data["launch_state"]);
    return progress === null ? { kind: "malformed" } : { kind: "failed", progress };
  }
  // FILE_NOT_FOUND is impossible through our bundle-only seam but remains a
  // checked closed provider envelope so drift cannot become arbitrary output.
  if (error === "FILE_NOT_FOUND") {
    return exactKeys(data, ["error", "url", "path"]) && typeof data["url"] === "string" && typeof data["path"] === "string"
      ? { kind: "refused" } : { kind: "malformed" };
  }
  return { kind: "malformed" };
}

type ParsedWindowState =
  | { readonly kind: "success"; readonly degraded: false; readonly bounds?: NonNullable<ComputerUseTargetEvidence["bounds"]>; readonly screenshot?: Readonly<{ bytes: Buffer; width: number; height: number }> }
  | { readonly kind: "success"; readonly degraded: true; readonly degradedKind: "ax_tree_empty" | "ax_window_unresolved"; readonly bounds?: NonNullable<ComputerUseTargetEvidence["bounds"]>; readonly screenshot?: Readonly<{ bytes: Buffer; width: number; height: number }> }
  | { readonly kind: "capture_unavailable" }
  | { readonly kind: "stale" }
  | { readonly kind: "unknown" }
  | { readonly kind: "malformed" };

function parseWindowState(
  result: CuaContextToolResult,
  expected: Readonly<{ pid: number; windowId: number }>,
  capture = false,
  capturePng: Uint8Array | null = null,
): ParsedWindowState {
  const data = result.structuredContent;
  if (result.isError) {
    if (data === null) return { kind: "unknown" };
    if (data["code"] === "window_id_not_found") {
      return exactKeys(data, ["code", "pid", "window_id", "suggestion"])
        && data["pid"] === expected.pid && data["window_id"] === expected.windowId && typeof data["suggestion"] === "string"
        ? { kind: "stale" } : { kind: "malformed" };
    }
    if (data["code"] === "window_owner_pid_mismatch") {
      return exactKeys(data, ["code", "pid", "window_id", "owner_pid", "owner_app_name", "suggestion"])
        && data["pid"] === expected.pid && data["window_id"] === expected.windowId && positiveInteger(data["owner_pid"]) !== undefined
        && typeof data["owner_app_name"] === "string" && typeof data["suggestion"] === "string"
        ? { kind: "stale" } : { kind: "malformed" };
    }
    return { kind: "malformed" };
  }
  if (data === null) return { kind: "malformed" };
  const required = ["window_id", "pid", "element_count", "total_element_count", "returned_element_count", "elements_complete", "tree_markdown", "elements", "_note"];
  const screenshotKeys = ["screenshot_width", "screenshot_height", "screenshot_mime_type", "window_bounds", "screenshot_scale", "screenshot_frame_valid", "screenshot_error", "screenshot_file_path"];
  if (!required.every((key) => Object.hasOwn(data, key))
    || data["pid"] !== expected.pid || data["window_id"] !== expected.windowId
    || nonnegativeInteger(data["element_count"]) === undefined || nonnegativeInteger(data["total_element_count"]) === undefined
    || nonnegativeInteger(data["returned_element_count"]) === undefined || data["elements_complete"] !== false
    || typeof data["tree_markdown"] !== "string" || !Array.isArray(data["elements"]) || typeof data["_note"] !== "string") return { kind: "malformed" };
  const elementCount = data["element_count"] as number;
  const totalElementCount = data["total_element_count"] as number;
  const returnedElementCount = data["returned_element_count"] as number;
  // The only checked call fixes include_screenshot:false. A returned capture
  // field is provider drift, not an optional detail we may accidentally retain.
  if ((!capture && screenshotKeys.some((key) => Object.hasOwn(data, key)))
    || elementCount !== totalElementCount || returnedElementCount > totalElementCount || data["elements"].length !== returnedElementCount
    || (data["filtered_element_count"] !== undefined && data["filtered_element_count"] !== returnedElementCount)
    || (data["filtered_element_count"] !== undefined && nonnegativeInteger(data["filtered_element_count"]) === undefined)
    || (data["snapshot_id"] !== undefined && (typeof data["snapshot_id"] !== "string" || data["snapshot_id"].length === 0))
    || (data["escalation"] !== undefined && record(data["escalation"]) === null)
    || (data["background_input"] !== undefined && record(data["background_input"]) === null)
    || (data["browser_chrome_capture_coverage"] !== undefined && record(data["browser_chrome_capture_coverage"]) === null)) return { kind: "malformed" };
  const degraded = data["degraded"] === true;
  if (data["degraded"] !== undefined && typeof data["degraded"] !== "boolean") return { kind: "malformed" };
  const degradedReason = data["degraded_reason"];
  if (degradedReason !== undefined && (typeof degradedReason !== "string"
    || !["ax_tree_empty:", "ax_window_unresolved:"].some((prefix) => degradedReason.startsWith(prefix)))) return { kind: "malformed" };
  if (degraded !== (degradedReason !== undefined)) return { kind: "malformed" };
  const degradedKind = typeof degradedReason === "string"
    ? degradedReason.startsWith("ax_window_unresolved:") ? "ax_window_unresolved" as const : "ax_tree_empty" as const
    : null;
  if (!capture) return degradedKind === null
    ? { kind: "success", degraded: false }
    : { kind: "success", degraded: true, degradedKind };
  const screenshotError = record(data["screenshot_error"]);
  const captureUnavailable = screenshotError !== null
    && exactKeys(screenshotError, ["code", "reason", "suggestion", "window_id"])
    && screenshotError["code"] === "px_capture_unavailable"
    && typeof screenshotError["reason"] === "string"
    && typeof screenshotError["suggestion"] === "string"
    && screenshotError["window_id"] === expected.windowId;
  if (data["screenshot_frame_valid"] === false) {
    const successOnlyScreenshotKeys = ["screenshot_width", "screenshot_height", "screenshot_mime_type", "window_bounds", "screenshot_scale", "screenshot_file_path"];
    const textBlocks = result.content.filter((entry) => entry["type"] === "text");
    if (!degraded || !captureUnavailable || successOnlyScreenshotKeys.some((key) => Object.hasOwn(data, key))
      || result.content.length !== 1 || textBlocks.length !== 1) return { kind: "malformed" };
    return { kind: "capture_unavailable" };
  }
  const width = positiveInteger(data["screenshot_width"]);
  const height = positiveInteger(data["screenshot_height"]);
  const textBlocks = result.content.filter((entry) => entry["type"] === "text");
  const bounds = record(data["window_bounds"]);
  if (result.content.length !== 1 || textBlocks.length !== 1 || capturePng === null
    || width === undefined || height === undefined || data["screenshot_mime_type"] !== "image/png"
    || data["screenshot_frame_valid"] !== true || data["screenshot_error"] !== undefined || data["screenshot_file_path"] !== undefined
    || bounds === null || !exactKeys(bounds, ["height", "width", "x", "y"])
    || !["x", "y", "width", "height"].every((key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]))
    || typeof data["screenshot_scale"] !== "number" || !Number.isFinite(data["screenshot_scale"]) || data["screenshot_scale"] <= 0) return { kind: "malformed" };
  const parsedDimensions = parseBoundedPngDimensions(capturePng);
  if ("kind" in parsedDimensions || parsedDimensions.width !== width || parsedDimensions.height !== height) return { kind: "malformed" };
  const bytes = Buffer.from(capturePng);
  const windowBounds = { x: bounds["x"] as number, y: bounds["y"] as number, width: bounds["width"] as number, height: bounds["height"] as number };
  if (windowBounds.width <= 0 || windowBounds.height <= 0) return { kind: "malformed" };
  return degradedKind === null
    ? { kind: "success", degraded: false, bounds: windowBounds, screenshot: { bytes, width, height } }
    : { kind: "success", degraded: true, degradedKind, bounds: windowBounds, screenshot: { bytes, width, height } };
}

type WindowSemanticMatchRole = string;

type ParsedWindowSemanticQuery = Readonly<{
  query: string;
  effort?: CuaWindowTraversalEffort;
  exhaustive: false;
  matched: number;
  returned: number;
  omitted: number;
  matches: readonly Readonly<{
    role: WindowSemanticMatchRole;
    label?: string;
    value?: string;
    labelTruncated: boolean;
    valueTruncated: boolean;
  }>[];
}>;

const MAX_WINDOW_SEMANTIC_SNIPPET_CODE_POINTS = 240;

const WINDOW_SEMANTIC_ROLE: Readonly<Record<string, WindowSemanticMatchRole>> = {
  AXWindow: "window",
  AXStaticText: "text",
  AXTextField: "text_field",
  AXTextArea: "text_area",
  AXCheckBox: "checkbox",
  AXSlider: "slider",
  AXButton: "button",
  AXMenuItem: "menu_item",
  AXLink: "link",
  AXRow: "row",
  AXCell: "cell",
  AXImage: "image",
  AXWebArea: "web_area",
};

function normalizeSemanticText(value: string): string | undefined {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    safe += codePoint <= 31 || codePoint === 127 || codePoint === 0x2028 || codePoint === 0x2029 ? " " : character;
  }
  const normalized = safe.replace(/\s+/gu, " ").trim();
  return normalized.length === 0 ? undefined : normalized;
}

function boundedSemanticSnippet(value: string, query: string): Readonly<{ text: string; truncated: boolean }> | null {
  const normalized = normalizeSemanticText(value);
  if (normalized === undefined) return null;
  const source = Array.from(normalized);
  if (source.length <= MAX_WINDOW_SEMANTIC_SNIPPET_CODE_POINTS) return { text: normalized, truncated: false };
  const normalizedQuery = normalizeSemanticText(query) ?? query;
  const matchIndex = normalized.toLocaleLowerCase().indexOf(normalizedQuery.toLocaleLowerCase());
  const queryCodePoints = Array.from(normalizedQuery).length;
  const center = matchIndex < 0 ? 0 : Array.from(normalized.slice(0, matchIndex)).length + Math.floor(queryCodePoints / 2);
  const start = Math.max(0, Math.min(source.length - MAX_WINDOW_SEMANTIC_SNIPPET_CODE_POINTS, center - Math.floor(MAX_WINDOW_SEMANTIC_SNIPPET_CODE_POINTS / 2)));
  return { text: source.slice(start, start + MAX_WINDOW_SEMANTIC_SNIPPET_CODE_POINTS).join(""), truncated: true };
}

/**
 * Cua query output contains positive matches plus their ancestor chain. Keep
 * only rows whose own normalized label/value contains the exact query and map
 * provider roles into the reviewed semantic vocabulary. Native indices,
 * tokens, parent links, geometry and unrelated ancestors remain private.
 */
function parseWindowSemanticQuery(
  result: CuaContextToolResult,
  query: string,
  effort?: CuaWindowTraversalEffort,
): ParsedWindowSemanticQuery | null {
  const data = result.structuredContent;
  if (data === null || typeof data["tree_markdown"] !== "string" || !Array.isArray(data["elements"])) return null;
  const needle = normalizeSemanticText(query)?.toLocaleLowerCase();
  if (needle === undefined) return null;
  const matches: Array<ParsedWindowSemanticQuery["matches"][number]> = [];
  const seen = new Set<string>();
  const append = (match: ParsedWindowSemanticQuery["matches"][number]): void => {
    const key = JSON.stringify([match.role, match.label ?? null, match.value ?? null]);
    if (!seen.has(key)) {
      seen.add(key);
      matches.push(match);
    }
  };
  for (const raw of data["elements"]) {
    const element = record(raw);
    if (element === null || typeof element["role"] !== "string"
      || (element["label"] !== undefined && element["label"] !== null && typeof element["label"] !== "string")
      || (element["value"] !== undefined && element["value"] !== null && typeof element["value"] !== "string")) return null;
    const label = typeof element["label"] === "string" ? normalizeSemanticText(element["label"]) : undefined;
    const value = typeof element["value"] === "string" ? normalizeSemanticText(element["value"]) : undefined;
    if (!(label?.toLocaleLowerCase().includes(needle) || value?.toLocaleLowerCase().includes(needle))) continue;
    const labelSnippet = label === undefined ? null : boundedSemanticSnippet(label, query);
    const valueSnippet = value === undefined ? null : boundedSemanticSnippet(value, query);
    append({
      role: clickControlRole(element["role"]) ?? "other",
      ...(labelSnippet === null ? {} : { label: labelSnippet.text }),
      ...(valueSnippet === null ? {} : { value: valueSnippet.text }),
      labelTruncated: labelSnippet?.truncated ?? false,
      valueTruncated: valueSnippet?.truncated ?? false,
    });
  }
  // Cua intentionally indexes actionable rows only, while its documented
  // stable tree_markdown also carries untokenized AXStaticText. Supplement
  // structured matches from only those unindexed rows; never expose native
  // indices, actions, help text, menu ids, hierarchy, or the raw line.
  for (const line of data["tree_markdown"].split("\n")) {
    const row = /^\s*-\s+(?!\[)(AX[A-Za-z0-9]+)(.*)$/u.exec(line);
    if (row === null) continue;
    const role = clickControlRole(row[1]!) ?? "other";
    const rest = row[2]!;
    const quoted = [...rest.matchAll(/"(?:\\.|[^"\\])*"/gu)].flatMap((match) => {
      try {
        const parsed = JSON.parse(match[0]) as unknown;
        return typeof parsed === "string" ? [parsed] : [];
      } catch {
        return [];
      }
    });
    const assignment = /^\s*=\s*/u.test(rest);
    const parenthetical = /\(([^()]*)\)(?:\s+\[|\s*$)/u.exec(rest)?.[1];
    const rawValue = assignment ? quoted[0] : undefined;
    const rawLabel = assignment ? parenthetical : quoted[0] ?? parenthetical;
    const semanticLabel = rawLabel === undefined ? undefined : normalizeSemanticText(rawLabel);
    const semanticValue = rawValue === undefined ? undefined : normalizeSemanticText(rawValue);
    if (!(semanticLabel?.toLocaleLowerCase().includes(needle) || semanticValue?.toLocaleLowerCase().includes(needle))) continue;
    const labelSnippet = semanticLabel === undefined ? null : boundedSemanticSnippet(semanticLabel, query);
    const valueSnippet = semanticValue === undefined ? null : boundedSemanticSnippet(semanticValue, query);
    if (labelSnippet === null && valueSnippet === null) continue;
    append({
      role,
      ...(labelSnippet === null ? {} : { label: labelSnippet.text }),
      ...(valueSnippet === null ? {} : { value: valueSnippet.text }),
      labelTruncated: labelSnippet?.truncated ?? false,
      valueTruncated: valueSnippet?.truncated ?? false,
    });
  }
  return {
    query,
    ...(effort === undefined ? {} : { effort }),
    // Cua's bounded AX walk deliberately does not claim an exhaustive app
    // surface, even when every projected row fit. Absence is therefore never
    // promoted into proof that another window cannot match.
    exhaustive: false,
    matched: matches.length,
    returned: matches.length,
    omitted: 0,
    matches,
  };
}


/** Normalize the actual provider role, without filtering it through a list of
 * roles supported by an early fixture. Existing public aliases stay stable. */
function clickControlRole(role: unknown): string | null {
  if (typeof role !== "string" || !/^AX[A-Za-z0-9]+$/u.test(role)) return null;
  const alias = WINDOW_SEMANTIC_ROLE[role];
  if (alias !== undefined) return alias;
  if (role === "AXPopUpButton") return "popup_button";
  return role.slice(2).replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

/**
 * Select one exact snapshot-bound native element for the requested operation.
 * Role, content, geometry and advisory actions do not establish writability.
 * Cua attempts the operation and reports the actual effect. An exact label is a
 * model-supplied disambiguator only. Selected control content is published only
 * in the fresh observation, never retained in action authority or receipts.
 */
function parseNativeElementSelection(
  result: CuaContextToolResult,
  selector: Readonly<{ role: string; labelEquals?: string }>,
): Readonly<{ disposition: "zero" | "ambiguous" | "incomplete" }>
  | Readonly<{ disposition: "unique"; elementToken: string; enabled?: boolean; observedValue?: boolean; value?: string; state: ComputerNativeControlState }> {
  const data = result.structuredContent;
  const elements = data === null ? null : list(data["elements"]);
  if (elements === null) return { disposition: "incomplete" };
  const matches: Readonly<Record<string, unknown>>[] = [];
  for (const raw of elements) {
    const element = record(raw);
    if (element === null) return { disposition: "incomplete" };
    if (clickControlRole(element["role"]) !== selector.role) continue;
    if (selector.labelEquals !== undefined) {
      const label = element["label"];
      if (label !== undefined && label !== null && typeof label !== "string") return { disposition: "incomplete" };
      if (label !== selector.labelEquals) continue;
    }
    matches.push(element);
  }
  if (matches.length === 0) return { disposition: "zero" };
  if (matches.length !== 1) return { disposition: "ambiguous" };
  const sole = matches[0]!;
  const token = sole["element_token"];
  const enabled = sole["enabled"];
  const value = sole["value"];
  const selected = sole["selected"];
  if (typeof token !== "string" || token.length < 1
    || (enabled !== undefined && typeof enabled !== "boolean") || enabled === false
    || (value !== undefined && value !== null && typeof value !== "string")
    || (selected !== undefined && typeof selected !== "boolean")) {
    return { disposition: "incomplete" };
  }
  const normalizedValue = typeof selected === "boolean"
    ? selected
    : typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
      ? true
      : typeof value === "string" && ["0", "false", "no", "off"].includes(value.trim().toLowerCase())
        ? false
        : undefined;
  const state = nativeControlState(sole);
  return {
    disposition: "unique", elementToken: token, state,
    ...(enabled === undefined ? {} : { enabled }),
    ...(typeof value === "string" ? { value } : {}),
    ...(normalizedValue === undefined ? {} : { observedValue: normalizedValue }),
  };
}

function nativeControlState(element: Readonly<Record<string, unknown>>): ComputerNativeControlState {
  const value = element["value"];
  const selected = element["selected"];
  const minimum = element["min"];
  const maximum = element["max"];
  // The public state projection preserves typed provider attributes without
  // coercion, placeholder inference, or first-N text truncation. Unknown
  // optional metadata does not retire the driver session.
  return {
    completeness: "partial",
    ...(typeof value === "string" ? { value } : {}),
    ...(typeof element["value_description"] === "string" ? { valueDescription: element["value_description"] } : {}),
    ...(typeof selected === "boolean" ? { selected } : {}),
    ...(typeof minimum === "number" && Number.isFinite(minimum)
      && typeof maximum === "number" && Number.isFinite(maximum) && maximum > minimum
      ? { range: { minimum, maximum } } : {}),
  };
}

function nativeControlCollection(result: CuaContextToolResult, provider: ComputerUseProviderTarget) {
  const rows = list(result.structuredContent?.["elements"]) ?? [];
  const tokenCounts = new Map<string, number>();
  const indexCounts = new Map<number, number>();
  for (const raw of rows) {
    const row = record(raw);
    if (typeof row?.["element_token"] === "string") {
      const token = row["element_token"];
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
    if (typeof row?.["element_index"] === "number") {
      const index = row["element_index"];
      indexCounts.set(index, (indexCounts.get(index) ?? 0) + 1);
    }
  }
  const collection: ComputerNativeControlCollection = { completeness: "partial", received: rows.length, omitted: 0, controls: [] };
  const elements: Array<{ evidence: ComputerUseTargetEvidence; providerTarget: ComputerUseProviderTarget }> = [];
  const bindings: Array<{ controlIndex: number; elementIndex: number }> = [];
  const parents = new Map<number, string>();
  for (const raw of rows) {
    const row = record(raw);
    const role = clickControlRole(row?.["role"]);
    if (row === null || role === null) { collection.omitted++; continue; }
    const id = `c${collection.controls.length}`;
    const parent = typeof row["parent_index"] === "number" ? parents.get(row["parent_index"]) : undefined;
    const label = typeof row["label"] === "string" ? normalizeSemanticText(row["label"]) : undefined;
    const enabled = typeof row["enabled"] === "boolean" ? row["enabled"] : undefined;
    const control = { id, role, state: nativeControlState(row),
      ...(label === undefined ? {} : { label }), ...(enabled === undefined ? {} : { enabled }),
      ...(parent === undefined ? {} : { parent }),
    };
    const token = row["element_token"];
    if (typeof token === "string" && token.length > 0 && tokenCounts.get(token) === 1
      && (row["enabled"] === undefined || enabled === true)) {
      bindings.push({ controlIndex: collection.controls.length, elementIndex: elements.length });
      elements.push({ evidence: { kind: "element", role }, providerTarget: {
        ...provider, operation: "element", elementToken: token,
        // No label-based post-read identity: a same-labelled sibling can
        // replace this control when Cua rebuilds the tree. Trust only the
        // driver's exact action evidence or explicit fresh task verification.
      } });
    }
    collection.controls.push(control);
    const index = row["element_index"];
    if (typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && indexCounts.get(index) === 1) parents.set(index, id);
  }
  return { collection, elements, bindings };
}

function outcome(
  phase: ComputerUseOperationOutcome["phase"],
  rest: Omit<ComputerUseOperationOutcome, "version" | "phase">,
): ComputerUseOperationOutcome {
  return { version: 1, phase, ...rest };
}

function registryError(code: string): string {
  switch (code) {
    case "capacity_exhausted": return "Computer use has retained its maximum number of live desktop contexts. Existing target references remain valid; this observation was not sent to a provider.";
    case "expired": return "The desktop observation expired. Observe again before acting.";
    case "scope_mismatch": return "This desktop reference belongs to a different authorized run.";
    case "replay_forbidden": return "The prior desktop action may have completed. Observe again; do not replay it.";
    default: return "This desktop reference is no longer available. Observe again before acting.";
  }
}

function observationFailure(code: string, error: string, result: ComputerUseOperationOutcome): ComputerObserveResult {
  return { ok: false, code, error, outcome: result };
}

function targetEnvelope(context: string, target: RegisteredComputerTarget) {
  return { target: { version: 1 as const, context, reference: target.reference }, evidence: target.evidence };
}

function receiptEvidence(evidence: ComputerUseTargetEvidence): ComputerUseTargetEvidence {
  const { windowLabel: _windowLabel, ...safe } = evidence;
  return safe;
}

function focusFailureReceipt(
  request: ComputerDoFocusRequest,
  evidence: CuaComputerMutationReceipt["resolvedTarget"],
  certainty: "not_completed" | "unknown_completion",
  result: ComputerUseOperationOutcome,
): CuaComputerMutationReceipt {
  return {
    version: 1, timing: "immediate", action: "focus",
    target: { version: 1, context: request.operation.target.context, reference: request.operation.target.reference },
    resolvedTarget: receiptEvidence(evidence), provider: "cua",
    deliveryMode: certainty === "not_completed" ? "not_delivered" : "unknown",
    completionCertainty: certainty, verification: "unavailable",
    unexecutedRemainder: { count: 1, reason: certainty === "not_completed" ? "failed" : "unknown_completion" },
    outcome: result,
  };
}

function clickFailureReceipt(
  request: CuaComputerDoClickRequest,
  evidence: CuaComputerMutationReceipt["resolvedTarget"],
  certainty: "not_completed" | "unknown_completion",
  result: ComputerUseOperationOutcome,
): CuaComputerMutationReceipt {
  return {
    version: 1, timing: "immediate", action: "click",
    target: { version: 1, context: request.operation.target.context, reference: request.operation.target.reference },
    resolvedTarget: evidence, provider: "cua",
    deliveryMode: certainty === "not_completed" ? "not_delivered" : "unknown",
    completionCertainty: certainty, verification: "unavailable",
    unexecutedRemainder: { count: 1, reason: certainty === "not_completed" ? "failed" : "unknown_completion" },
    outcome: result,
  };
}

type CuaElementClickRequest = CuaComputerDoClickRequest & Readonly<{
  operation: Extract<CuaComputerDoClickRequest["operation"], { axAction?: string }>;
}>;

type CuaWindowMutationRequest = CuaComputerDoSemanticTypeTextRequest | CuaComputerDoSetValueRequest | CuaComputerDoElementScrollRequest
  | CuaComputerDoSemanticPressKeyRequest | CuaElementClickRequest;

type CuaInputMutationRequest = CuaComputerDoSemanticTypeTextRequest | CuaComputerDoCoordinateTypeTextRequest
  | CuaComputerDoSemanticPressKeyRequest | CuaComputerDoCoordinatePressKeyRequest;

function windowMutationFailureReceipt(
  request: CuaWindowMutationRequest | CuaInputMutationRequest,
  evidence: CuaComputerMutationReceipt["resolvedTarget"],
  certainty: "not_completed" | "unknown_completion",
  result: ComputerUseOperationOutcome,
): CuaComputerMutationReceipt {
  const textDelivery = request.operation.kind === "type_text"
    ? {
      requestedCharacters: [...request.operation.text].length,
      // Only an upstream pre-actuator refusal proves that zero characters
      // arrived. Any post-boundary failure intentionally remains unknown.
      deliveredCharacters: result.phase === "pre_effect_dispatch" || result.phase === "resolve_target" ? 0 : null,
    }
    : undefined;
  return {
    version: 1, timing: "immediate", action: request.operation.kind,
    target: { version: 1, context: request.operation.target.context, reference: request.operation.target.reference },
    resolvedTarget: receiptEvidence(evidence), provider: "cua",
    deliveryMode: certainty === "not_completed" ? "not_delivered" : "unknown",
    completionCertainty: certainty, verification: "unavailable",
    ...(textDelivery === undefined ? {} : { textDelivery }), providerAction: null,
    unexecutedRemainder: {
      count: request.operation.kind === "type_text" ? [...request.operation.text].length : 1,
      reason: certainty === "not_completed" ? "failed" : "unknown_completion",
    }, outcome: result,
  };
}

function observationOutcome(coverage: ComputerUseObservationCoverage | null): ComputerUseOperationOutcome {
  return outcome("observe", {
    retrySafety: coverage === null ? "safe" : "never",
    stateChangeCertainty: "not_applicable",
    providerCondition: "ready",
    targetCondition: "current",
    recovery: coverage === null ? ["retry_same_request"] : [],
    ...(coverage === null ? {} : { requiredCapability: "provider_narrowing_or_cursor" as const }),
  });
}

function toolFailureOutcome(code: string): ComputerUseOperationOutcome {
  return outcome("observe", {
    retrySafety: code === "cancelled" ? "safe" : "observe_before_retry",
    stateChangeCertainty: "not_applicable",
    providerCondition: code === "cancelled" ? "cancelled" : "unknown",
    recovery: code === "cancelled" ? ["retry_same_request"] : ["observe_again"],
  });
}

type CuaTextOrKeyEffect =
  | { readonly kind: "completed"; readonly providerAction: NonNullable<CuaComputerMutationReceipt["providerAction"]> }
  /** The actuator boundary was crossed, but Cua could not prove the operation. */
  | { readonly kind: "unverifiable"; readonly providerAction: NonNullable<CuaComputerMutationReceipt["providerAction"]> }
  | { readonly kind: "refused_foreground"; readonly code: "off_space_or_ax_unresolved" | "SCREEN_SHARING_REQUIRES_FOREGROUND_HID" }
  | { readonly kind: "refused"; readonly code: "window_not_found" | "owner_pid_mismatch" | "minimized_or_hidden_window" | "same_pid_keyboard_ambiguity"; readonly advice: "get_window_state" | "accessibility" | "none" }
  /** Exact element resolver/background gate refusal before an element action. */
  | { readonly kind: "refused_element" }
  | { readonly kind: "chunk_refusal"; readonly maxChunkCharacters: number }
  | { readonly kind: "partial"; readonly delivered: number; readonly delivery: "background" | "foreground" | "unknown"; readonly synthesizedInput: boolean }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "provider_failure" }
  | { readonly kind: "malformed" };

type CuaTextOrKeyExpectation = Readonly<{
  requestedCharacters: number | null;
}> & (Readonly<{ pid: number; windowId: number; deliveryMode: "background" | "foreground" }>
  | Readonly<{ pid?: never; windowId?: never; deliveryMode: "not_applicable" }>);

function u32(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function validSynthesisBudgetBase(
  data: Readonly<Record<string, unknown>>,
  expected: CuaTextOrKeyExpectation,
): boolean {
  const escalation = record(data["escalation"]);
  return expected.requestedCharacters !== null
    && data["code"] === "type_text_synthesis_budget_exceeded"
    && data["requested_chars"] === expected.requestedCharacters
    && data["path"] === (expected.deliveryMode === "not_applicable" ? "hid" : expected.deliveryMode === "background" ? "key_events" : "key_events_fg")
    && nonnegativeInteger(data["estimated_duration_ms"]) !== undefined
    && nonnegativeInteger(data["synthesis_budget_ms"]) !== undefined
    && nonnegativeInteger(data["per_character_ms"]) !== undefined
    && u32(data["max_chunk_chars"])
    && data["max_chunk_chars"] > 0
    && data["max_chunk_chars"] < expected.requestedCharacters
    && data["synthesized_chars"] === 0
    && escalation !== null
    && exactVerifyKeys(escalation, ["reason", "recommended"])
    && typeof escalation["reason"] === "string";
}

/**
 * Literal pinned macOS `type_text` / `press_key` structuredContent parser.
 * It deliberately ignores `content` (which can include typed text) and never
 * projects Cua's provider prose or opaque delivery paths.
 */
function parseTextOrKeyEffect(
  result: CuaContextToolResult,
  expected: CuaTextOrKeyExpectation,
  keyboardTool: "press_key" | "hotkey" = "press_key",
): CuaTextOrKeyEffect {
  const data = result.structuredContent;
  // Pinned ToolResult permits an operational isError with no structured
  // payload. It proves neither protocol drift nor pre-effect safety.
  if (data === null) return result.isError ? { kind: "provider_failure" } : { kind: "malformed" };
  const effect = data["effect"];
  // Element-token resolution happens before the AX actuator. The token is
  // nevertheless consumed; recover with a fresh exact selection, not replay.
  if (result.isError && exactVerifyKeys(data, ["refusal", "status"]) && data["status"] === "refused") {
    const refusal = record(data["refusal"]);
    if (refusal !== null && exactVerifyKeys(refusal, ["code", "message"])
      && typeof refusal["message"] === "string"
      && (refusal["code"] === "stale_element_token" || refusal["code"] === "generation_mismatch"
        || refusal["code"] === "invalid_element_token" || refusal["code"] === "conflicting_element_target")) return { kind: "refused_element" };
    return { kind: "malformed" };
  }
  if (!result.isError && validActionResult(data)) {
    const providerAction = actionProjection(data)!;
    const expectedKeyRoute = expected.deliveryMode === "background" ? "synthetic_events" : "global_input";
    const textRouteMatches = expected.requestedCharacters !== null
      && (expected.deliveryMode === "background"
        ? providerAction.route === "accessibility" || providerAction.route === "synthetic_events"
        : providerAction.route === "global_input");
    if (providerAction.delivery === null || providerAction.delivery.mode !== expected.deliveryMode
      || (expected.requestedCharacters === null && (providerAction.route !== expectedKeyRoute || providerAction.delivery.deliveredCount !== undefined))
      || (expected.requestedCharacters !== null && !textRouteMatches)
      || effect === "suspected_noop") return { kind: "malformed" };
    if (effect === "confirmed") {
      if (keyboardTool === "hotkey") return { kind: "malformed" };
      if (expected.deliveryMode === "not_applicable") return { kind: "malformed" };
      // Exact text receipts must account for every character. Unlike a key
      // action, a confirmed type_text result from the pinned 0.22 producer
      // therefore requires its literal delivered_count; do not synthesize a
      // count from private value-readback or from the request text.
      if ((expected.requestedCharacters !== null
          && providerAction.delivery.deliveredCount !== expected.requestedCharacters)
        || providerAction.evidenceKinds.length !== 1 || providerAction.evidenceKinds[0] !== "value_readback"
        || providerAction.escalation !== null) return { kind: "malformed" };
      return { kind: "completed", providerAction };
    }
    if (effect === "unverifiable") {
      // press_key publishes native_api_result for an attempted post, not proof
      // that the application consumed it. Preserve that evidence without
      // withdrawing the provider or upgrading semantic verification.
      const attemptedKeyPost = expected.requestedCharacters === null
        && providerAction.evidenceKinds.length === 1 && providerAction.evidenceKinds[0] === "native_api_result";
      if (providerAction.evidenceKinds.length !== 0 && !attemptedKeyPost) return { kind: "malformed" };
      if (expected.requestedCharacters === null) {
        // hotkey's pinned producer advises foreground after an unverified
        // background post. Advice is not proof of non-delivery or replay authority.
        const hotkeyAdvice = keyboardTool === "hotkey" && expected.deliveryMode === "background"
          && providerAction.escalation?.target === "foreground" && providerAction.escalation.reason === "delivery_failed";
        if (providerAction.delivery.deliveredCount !== undefined || providerAction.escalation !== null && !hotkeyAdvice) return { kind: "malformed" };
      } else {
        // Synthesis can accurately report the completed requested character
        // run even while semantic landing remains unverified. A shorter run
        // is emitted as an isError partial result, never a successful
        // ActionResult. Preserve the exact provider fact without treating it
        // as a replay grant; the unknown-completion fence remains below.
        if (providerAction.delivery.deliveredCount !== undefined
          && providerAction.delivery.deliveredCount !== expected.requestedCharacters) return { kind: "malformed" };
        const pinnedEscalation = (providerAction.escalation?.target === "foreground" && providerAction.escalation.reason === "delivery_failed")
          || ((providerAction.escalation?.target === "pixel" || providerAction.escalation?.target === "page")
            && providerAction.escalation.reason === "effect_unconfirmed");
        if (!textRouteMatches
          || (expected.deliveryMode === "background" && !pinnedEscalation)
          || (expected.deliveryMode !== "background" && providerAction.escalation !== null)) return { kind: "malformed" };
      }
      return { kind: "unverifiable", providerAction };
    }
    return { kind: "malformed" };
  }
  if (result.isError && expected.deliveryMode !== "not_applicable" && data["code"] === "type_text_incomplete" && effect === "partial"
    && exactVerifyKeys(data, ["code", "delivered_chars", "effect", "path", "requested_chars", "retry_from_character", "retryable"])
    && expected.requestedCharacters !== null && data["requested_chars"] === expected.requestedCharacters
    && u32(data["delivered_chars"]) && data["delivered_chars"] < expected.requestedCharacters
    && data["retryable"] === true && data["retry_from_character"] === data["delivered_chars"]) {
    if ((expected.deliveryMode === "background" && data["path"] !== "key_events" && data["path"] !== "ax")
      || (expected.deliveryMode === "foreground" && data["path"] !== "key_events_fg" && data["path"] !== "key_events")) return { kind: "malformed" };
    return {
      kind: "partial", delivered: data["delivered_chars"],
      synthesizedInput: data["path"] !== "ax",
      delivery: data["path"] === "key_events_fg" ? "foreground" : data["path"] === "key_events" || data["path"] === "ax" ? "background" : "unknown",
    };
  }
  if (result.isError && effect === "refused"
    && exactVerifyKeys(data, [
      "atomic_ax_effect", "code", "delivered_chars", "effect", "escalation", "estimated_duration_ms", "max_chunk_chars",
      "path", "per_character_ms", "requested_chars", "retry_from_character", "retryable", "synthesis_budget_ms", "synthesized_chars",
    ])
    && validSynthesisBudgetBase(data, expected)
    && data["delivered_chars"] === 0 && data["retry_from_character"] === 0 && data["retryable"] === true
    && (expected.deliveryMode !== "background"
      ? data["atomic_ax_effect"] === "not_attempted"
      : ["not_attempted", "rejected", "unchanged"].includes(data["atomic_ax_effect"] as string))
    && record(data["escalation"])?.["recommended"] === "chunk") {
    return { kind: "chunk_refusal", maxChunkCharacters: data["max_chunk_chars"] as number };
  }
  if (result.isError && expected.deliveryMode === "background" && effect === "indeterminate"
    && exactVerifyKeys(data, [
      "atomic_ax_effect", "code", "effect", "escalation", "estimated_duration_ms", "max_chunk_chars", "path", "per_character_ms",
      "requested_chars", "retryable", "synthesis_budget_ms", "synthesized_chars",
    ])
    && validSynthesisBudgetBase(data, expected)
    && data["retryable"] === false && data["atomic_ax_effect"] === "unverifiable"
    && record(data["escalation"])?.["recommended"] === "verify_state") return { kind: "indeterminate" };
  if (result.isError && expected.deliveryMode === "background" && effect === "refused"
    && exactVerifyKeys(data, ["code", "effect", "escalation"])
    && data["code"] === "SCREEN_SHARING_REQUIRES_FOREGROUND_HID"
    && (expected.requestedCharacters !== null || keyboardTool === "hotkey")) {
    const escalation = record(data["escalation"]);
    if (escalation !== null && exactVerifyKeys(escalation, ["reason", "recommended", "requires"])
      && escalation["recommended"] === "foreground" && typeof escalation["reason"] === "string"
      && Array.isArray(escalation["requires"]) && escalation["requires"].length === 1
      && escalation["requires"][0] === "window_id") return { kind: "refused_foreground", code: "SCREEN_SHARING_REQUIRES_FOREGROUND_HID" };
    return { kind: "malformed" };
  }
  // Closed pinned background-refusal matrix. Only the exact off-space/AX
  // refusal earns the one automatic foreground delivery escalation. Other
  // advice changes recovery truth, never causes a blind same-request replay.
  if (result.isError && expected.deliveryMode === "background" && effect === "refused") {
    const escalation = record(data["escalation"]);
    const keys = escalation === null ? ["code", "effect", "pid", "reason", "window_id"] : ["code", "effect", "escalation", "pid", "reason", "window_id"];
    if (!exactVerifyKeys(data, keys) || data["pid"] !== expected.pid || data["window_id"] !== expected.windowId
      || typeof data["reason"] !== "string"
      || (escalation !== null && (!exactVerifyKeys(escalation, ["reason", "recommended"])
        || escalation["reason"] !== data["reason"]))) return { kind: "malformed" };
    const matrix = {
      off_space_or_ax_unresolved: "foreground",
      window_not_found: "none",
      owner_pid_mismatch: "none",
      minimized_or_hidden_window: "accessibility",
      same_pid_keyboard_ambiguity: "accessibility",
      element_outside_target_window: "get_window_state",
    } as const;
    const code = data["code"];
    if (typeof code !== "string" || !(code in matrix)) return { kind: "malformed" };
    const recommended = matrix[code as keyof typeof matrix];
    if ((recommended === "none" && escalation !== null)
      || (recommended !== "none" && escalation?.["recommended"] !== recommended)) return { kind: "malformed" };
    if (code === "element_outside_target_window") return { kind: "refused_element" };
    return code === "off_space_or_ax_unresolved"
      ? { kind: "refused_foreground", code }
      : { kind: "refused", code: code as Exclude<keyof typeof matrix, "off_space_or_ax_unresolved" | "element_outside_target_window">, advice: recommended as "get_window_state" | "accessibility" | "none" };
  }
  // `type_text_synthesis_budget_exceeded` with an unverifiable atomic AX
  // attempt is deliberately indeterminate, not a safe re-delivery.
  if (result.isError && (data["code"] === "type_text_incomplete"
    || data["code"] === "type_text_synthesis_budget_exceeded"
    || effect === "refused" || effect === "partial" || effect === "indeterminate")) return { kind: "malformed" };
  return result.isError ? { kind: "provider_failure" } : { kind: "malformed" };
}

/** Pinned move_cursor desktop success proves posting, not a hover effect. */
function parseDesktopPointerEffect(result: CuaContextToolResult): CuaTextOrKeyEffect {
  if (result.isError) return { kind: "provider_failure" };
  const data = result.structuredContent;
  if (data === null || !validActionResult(data)) return { kind: "malformed" };
  const providerAction = actionProjection(data)!;
  if (providerAction.effect !== "unverifiable" || providerAction.route !== "global_input"
    || providerAction.delivery?.mode !== "not_applicable" || providerAction.delivery.deliveredCount !== undefined
    || providerAction.evidenceKinds.length !== 0 || providerAction.escalation !== null) return { kind: "malformed" };
  return { kind: "unverifiable", providerAction };
}

type CuaSetValueEffect =
  | { readonly kind: "completed"; readonly providerAction: NonNullable<CuaComputerMutationReceipt["providerAction"]> }
  | { readonly kind: "unverifiable"; readonly providerAction: NonNullable<CuaComputerMutationReceipt["providerAction"]> }
  | { readonly kind: "refused_element" }
  | { readonly kind: "refused_element_scope" }
  | { readonly kind: "provider_failure" }
  | { readonly kind: "malformed" };

/** Exact pinned Cua 0.23.2 `set_value` public ActionResult/refusal parser. */
function parseSetValueEffect(
  result: CuaContextToolResult,
  expected: Readonly<{ pid: number; windowId: number }>,
): CuaSetValueEffect {
  const data = result.structuredContent;
  if (data === null) return result.isError ? { kind: "provider_failure" } : { kind: "malformed" };
  if (result.isError && exactVerifyKeys(data, ["refusal", "status"]) && data["status"] === "refused") {
    const refusal = record(data["refusal"]);
    if (refusal !== null && exactVerifyKeys(refusal, ["code", "message"])
      && typeof refusal["message"] === "string"
      && (refusal["code"] === "stale_element_token" || refusal["code"] === "generation_mismatch"
        || refusal["code"] === "invalid_element_token" || refusal["code"] === "conflicting_element_target")) {
      return { kind: "refused_element" };
    }
    return { kind: "malformed" };
  }
  if (!result.isError && validActionResult(data)) {
    const providerAction = actionProjection(data)!;
    if (providerAction.route !== "accessibility" || providerAction.delivery?.mode !== "background"
      || providerAction.delivery.deliveredCount !== undefined) return { kind: "malformed" };
    if (providerAction.effect === "confirmed") {
      return providerAction.evidenceKinds.length === 1 && providerAction.evidenceKinds[0] === "value_readback"
        && providerAction.escalation === null
        ? { kind: "completed", providerAction }
        : { kind: "malformed" };
    }
    if (providerAction.effect === "unverifiable") {
      const allowedEscalation = providerAction.escalation === null
        || (providerAction.escalation.target === "pixel" && providerAction.escalation.reason === "effect_unconfirmed");
      return providerAction.evidenceKinds.length === 0 && allowedEscalation
        ? { kind: "unverifiable", providerAction }
        : { kind: "malformed" };
    }
    return { kind: "malformed" };
  }
  if (result.isError && data["effect"] === "refused") {
    const escalation = record(data["escalation"]);
    const keys = escalation === null ? ["code", "effect", "pid", "reason", "window_id"] : ["code", "effect", "escalation", "pid", "reason", "window_id"];
    if (!exactVerifyKeys(data, keys) || data["pid"] !== expected.pid || data["window_id"] !== expected.windowId
      || typeof data["reason"] !== "string"
      || (escalation !== null && (!exactVerifyKeys(escalation, ["reason", "recommended"]) || escalation["reason"] !== data["reason"]))) {
      return { kind: "malformed" };
    }
    const code = data["code"];
    if (code === "element_outside_target_window"
      && escalation?.["recommended"] === "get_window_state") return { kind: "refused_element_scope" };
    if ((code === "window_not_found" || code === "owner_pid_mismatch") && escalation === null) return { kind: "refused_element" };
    return { kind: "malformed" };
  }
  return result.isError ? { kind: "provider_failure" } : { kind: "malformed" };
}

type CuaScrollEffect =
  | { readonly kind: "unverifiable"; readonly providerAction: NonNullable<CuaComputerMutationReceipt["providerAction"]> }
  | { readonly kind: "synthetic_unverifiable"; readonly providerAction: NonNullable<CuaComputerMutationReceipt["providerAction"]> }
  | { readonly kind: "refused_element" }
  | { readonly kind: "background_unavailable" }
  | { readonly kind: "background_refusal" }
  | { readonly kind: "provider_failure" }
  | { readonly kind: "malformed" };

/** Exact CUA-LAB-0037 background scroll result/refusal parser. */
function parseScrollEffect(
  result: CuaContextToolResult,
  expected: Readonly<{ pid?: number; windowId?: number; deliveryMode?: "background" | "foreground"; desktop?: boolean }>,
): CuaScrollEffect {
  const data = result.structuredContent;
  if (data === null) return result.isError ? { kind: "provider_failure" } : { kind: "malformed" };
  if (result.isError && exactVerifyKeys(data, ["refusal", "status"]) && data["status"] === "refused") {
    const refusal = record(data["refusal"]);
    if (refusal !== null && exactVerifyKeys(refusal, ["code", "message"])
      && typeof refusal["message"] === "string"
      && (refusal["code"] === "stale_element_token" || refusal["code"] === "generation_mismatch"
        || refusal["code"] === "invalid_element_token" || refusal["code"] === "conflicting_element_target")) return { kind: "refused_element" };
    return { kind: "malformed" };
  }
  if (!result.isError && exactVerifyKeys(data, ["delivery", "effect", "route"]) && validActionResult(data)) {
    const providerAction = actionProjection(data)!;
    if (providerAction.effect === "unverifiable" && providerAction.route === "accessibility"
      && !expected.desktop && (providerAction.delivery?.mode === "background" || expected.deliveryMode === "foreground" && providerAction.delivery?.mode === "foreground") && providerAction.delivery.deliveredCount === undefined
      && providerAction.evidenceKinds.length === 0 && providerAction.escalation === null
    ) return { kind: "unverifiable", providerAction };
    if (providerAction.effect === "unverifiable"
      && (expected.desktop ? providerAction.route === "global_input" && providerAction.delivery?.mode === "not_applicable"
        : providerAction.route === "synthetic_events" && providerAction.delivery?.mode === "background"
          || expected.deliveryMode === "foreground" && providerAction.route === "global_input" && providerAction.delivery?.mode === "foreground")
      && providerAction.delivery?.deliveredCount === undefined
      && providerAction.evidenceKinds.length === 0 && providerAction.escalation === null
    ) return { kind: "synthetic_unverifiable", providerAction };
    return { kind: "malformed" };
  }
  if (result.isError && exactVerifyKeys(data, ["code"]) && data["code"] === "background_unavailable") return { kind: "background_unavailable" };
  if (result.isError && data["effect"] === "refused") {
    const escalation = record(data["escalation"]);
    const keys = escalation === null ? ["code", "effect", "pid", "reason", "window_id"] : ["code", "effect", "escalation", "pid", "reason", "window_id"];
    if (!exactVerifyKeys(data, keys) || data["pid"] !== expected.pid || data["window_id"] !== expected.windowId || typeof data["reason"] !== "string"
      || (escalation !== null && (!exactVerifyKeys(escalation, ["reason", "recommended"]) || escalation["reason"] !== data["reason"]))) return { kind: "malformed" };
    if (data["code"] === "element_outside_target_window" && escalation?.["recommended"] === "get_window_state") return { kind: "background_refusal" };
    if ((data["code"] === "window_not_found" || data["code"] === "owner_pid_mismatch") && escalation === null) return { kind: "background_refusal" };
    if (data["code"] === "off_space_or_ax_unresolved" && escalation?.["recommended"] === "foreground") return { kind: "background_refusal" };
    if (data["code"] === "minimized_or_hidden_window" && escalation?.["recommended"] === "accessibility") return { kind: "background_refusal" };
    return { kind: "malformed" };
  }
  return result.isError ? { kind: "provider_failure" } : { kind: "malformed" };
}

type CuaElementClickEffect =
  | { readonly kind: "completed"; readonly providerAction: NonNullable<CuaComputerMutationReceipt["providerAction"]> }
  | { readonly kind: "unverifiable"; readonly providerAction: NonNullable<CuaComputerMutationReceipt["providerAction"]> }
  | { readonly kind: "suspected_noop"; readonly providerAction: NonNullable<CuaComputerMutationReceipt["providerAction"]> }
  | { readonly kind: "refused_element" }
  | { readonly kind: "provider_failure" }
  | { readonly kind: "malformed" };

/** Pinned token click routes, including foreground and middle-button delivery. */
function parseElementClickEffect(
  result: CuaContextToolResult,
  expected: Readonly<{ pid: number; windowId: number; deliveryMode: "background" | "foreground" }>,
): CuaElementClickEffect {
  const data = result.structuredContent;
  if (data === null) return result.isError ? { kind: "provider_failure" } : { kind: "malformed" };
  if (result.isError && exactVerifyKeys(data, ["refusal", "status"]) && data["status"] === "refused") {
    const refusal = record(data["refusal"]);
    if (refusal !== null && exactVerifyKeys(refusal, ["code", "message"])
      && typeof refusal["message"] === "string"
      && (refusal["code"] === "stale_element_token" || refusal["code"] === "generation_mismatch"
        || refusal["code"] === "invalid_element_token" || refusal["code"] === "conflicting_element_target")) {
      return { kind: "refused_element" };
    }
    return { kind: "malformed" };
  }
  if (!result.isError && validActionResult(data)) {
    const providerAction = actionProjection(data)!;
    if ((providerAction.route !== "accessibility" && providerAction.route !== "synthetic_events" && providerAction.route !== "global_input")
      || (providerAction.delivery?.mode !== "background" && !(expected.deliveryMode === "foreground" && providerAction.delivery?.mode === "foreground"))
      || (providerAction.route === "global_input" && providerAction.delivery?.mode !== "foreground")
      || providerAction.delivery.deliveredCount !== undefined) return { kind: "malformed" };
    if (providerAction.effect === "confirmed") {
      return providerAction.evidenceKinds.length === 1 && providerAction.evidenceKinds[0] === "value_readback"
        && providerAction.escalation === null
        ? { kind: "completed", providerAction }
        : { kind: "malformed" };
    }
    // Cua's collection-item fallback can confirm AXSelected after a pointer
    // click. Its public projection is synthetic_events + value_readback;
    // route alone must not discard that confirmed semantic evidence.
    if (providerAction.effect === "unverifiable") {
      return providerAction.evidenceKinds.length === 0 && providerAction.escalation === null
        ? { kind: "unverifiable", providerAction }
        : { kind: "malformed" };
    }
    if (providerAction.effect === "suspected_noop") {
      return providerAction.route === "accessibility" && providerAction.evidenceKinds.length === 0
        && providerAction.escalation?.target === "pixel"
        && providerAction.escalation.reason === "suspected_noop"
        ? { kind: "suspected_noop", providerAction }
        : { kind: "malformed" };
    }
    return { kind: "malformed" };
  }
  if (result.isError && data["code"] === "background_unavailable"
    && parseWindowPixelClickEffect(result, expected).kind === "not_delivered") return { kind: "refused_element" };
  if (result.isError && data["effect"] === "refused") {
    const escalation = record(data["escalation"]);
    const keys = escalation === null ? ["code", "effect", "pid", "reason", "window_id"] : ["code", "effect", "escalation", "pid", "reason", "window_id"];
    if (!exactVerifyKeys(data, keys) || data["pid"] !== expected.pid || data["window_id"] !== expected.windowId
      || typeof data["reason"] !== "string"
      || (escalation !== null && (!exactVerifyKeys(escalation, ["reason", "recommended"]) || escalation["reason"] !== data["reason"]))) {
      return { kind: "malformed" };
    }
    const code = data["code"];
    if (code === "element_outside_target_window"
      && escalation?.["recommended"] === "get_window_state") return { kind: "refused_element" };
    if ((code === "window_not_found" || code === "owner_pid_mismatch") && escalation === null) return { kind: "refused_element" };
    return { kind: "malformed" };
  }
  return result.isError ? { kind: "provider_failure" } : { kind: "malformed" };
}

/**
 * Cua 0.23.2 normalizes legacy specialized clicks using the requested delivery
 * branch: foreground publishes global_input/foreground. Retain the older
 * synthetic_events/unknown result too; neither proves the semantic effect.
 */
function parseElementSpecializedClickEffect(
  result: CuaContextToolResult,
  expected: Readonly<{ pid: number; windowId: number; deliveryMode: "background" | "foreground" }>,
): CuaElementClickEffect {
  const data = result.structuredContent;
  if (data === null) return result.isError ? { kind: "provider_failure" } : { kind: "malformed" };
  if (result.isError && exactVerifyKeys(data, ["refusal", "status"]) && data["status"] === "refused") {
    const refusal = record(data["refusal"]);
    if (refusal !== null && exactVerifyKeys(refusal, ["code", "message"])
      && typeof refusal["message"] === "string"
      && (refusal["code"] === "stale_element_token" || refusal["code"] === "generation_mismatch"
        || refusal["code"] === "invalid_element_token" || refusal["code"] === "conflicting_element_target")) {
      return { kind: "refused_element" };
    }
    return { kind: "malformed" };
  }
  if (!result.isError && validActionResult(data)) {
    const providerAction = actionProjection(data)!;
    return providerAction.effect === "unverifiable"
      && ((providerAction.route === "synthetic_events" && providerAction.delivery?.mode === "unknown")
        || (expected.deliveryMode === "foreground" && providerAction.route === "global_input" && providerAction.delivery?.mode === "foreground"))
      && providerAction.delivery?.deliveredCount === undefined
      && providerAction.evidenceKinds.length === 0
      && providerAction.escalation === null
      ? { kind: "unverifiable", providerAction }
      : { kind: "malformed" };
  }
  if (result.isError && data["effect"] === "refused") {
    const escalation = record(data["escalation"]);
    const keys = escalation === null ? ["code", "effect", "pid", "reason", "window_id"] : ["code", "effect", "escalation", "pid", "reason", "window_id"];
    if (!exactVerifyKeys(data, keys) || data["pid"] !== expected.pid || data["window_id"] !== expected.windowId
      || typeof data["reason"] !== "string"
      || (escalation !== null && (!exactVerifyKeys(escalation, ["reason", "recommended"]) || escalation["reason"] !== data["reason"]))) {
      return { kind: "malformed" };
    }
    const code = data["code"];
    if (code === "element_outside_target_window" && escalation?.["recommended"] === "get_window_state") return { kind: "refused_element" };
    if ((code === "window_not_found" || code === "owner_pid_mismatch") && escalation === null) return { kind: "refused_element" };
    return { kind: "malformed" };
  }
  return result.isError ? { kind: "provider_failure" } : { kind: "malformed" };
}

function actionProjection(data: Readonly<Record<string, unknown>>): NonNullable<CuaComputerMutationReceipt["providerAction"]> | null {
  if (!validActionResult(data)) return null;
  const delivery = data["delivery"] === undefined ? null : record(data["delivery"]);
  const evidence = data["evidence"] === undefined ? [] : data["evidence"] as readonly Readonly<Record<string, unknown>>[];
  const escalation = data["escalation"] === undefined ? null : record(data["escalation"]);
  return {
    effect: data["effect"] as NonNullable<CuaComputerMutationReceipt["providerAction"]>["effect"],
    route: data["route"] as NonNullable<CuaComputerMutationReceipt["providerAction"]>["route"],
    delivery: delivery === null ? null : { mode: delivery["mode"] as NonNullable<CuaComputerMutationReceipt["providerAction"]>["delivery"] extends Readonly<infer Delivery> | null ? Delivery extends { mode: infer Mode } ? Mode : never : never, ...(delivery["delivered_count"] === undefined ? {} : { deliveredCount: delivery["delivered_count"] as number }) },
    evidenceKinds: evidence.map((item) => item["kind"] as "value_readback" | "window_change" | "native_api_result"),
    escalation: escalation === null ? null : { target: escalation["target"] as "pixel" | "foreground" | "page" | "session", reason: escalation["reason"] as "route_unavailable" | "delivery_failed" | "effect_unconfirmed" | "suspected_noop" | "permission_required" },
  };
}

function parseDragAction(result: CuaContextToolResult, desktop: boolean): NonNullable<CuaComputerMutationReceipt["providerAction"]> | null {
  const data = result.structuredContent;
  const delivery = data === null ? null : record(data["delivery"]);
  if (result.isError || data === null || !exactKeys(data, ["delivery", "effect", "route"])
    || data["effect"] !== "unverifiable" || data["route"] !== "global_input"
    || data["evidence"] !== undefined || data["escalation"] !== undefined
    || delivery === null || !exactKeys(delivery, ["mode"]) || delivery["mode"] !== (desktop ? "not_applicable" : "foreground")
    || delivery["delivered_count"] !== undefined
    || result.content.length !== 1 || result.content[0]?.["type"] !== "text" || typeof result.content[0]?.["text"] !== "string") return null;
  return { effect: "unverifiable", route: "global_input", delivery: { mode: desktop ? "not_applicable" : "foreground" }, evidenceKinds: [], escalation: null };
}

type CuaWindowPixelClickEffect =
  | { readonly kind: "delivered"; readonly providerAction: NonNullable<CuaComputerMutationReceipt["providerAction"]> }
  | { readonly kind: "not_delivered"; readonly foregroundRequired?: boolean }
  | { readonly kind: "provider_failure" }
  | { readonly kind: "malformed" };

/** Pinned window-local pixel result; foreground assist may report background
 * delivery if activation was unavailable. Preserve the actual route. */
function parseWindowPixelClickEffect(
  result: CuaContextToolResult,
  expected: Readonly<{ pid: number; windowId: number; deliveryMode?: "background" | "foreground" }>,
): CuaWindowPixelClickEffect {
  const data = result.structuredContent;
  if (data === null) return result.isError ? { kind: "provider_failure" } : { kind: "malformed" };
  if (!result.isError && exactVerifyKeys(data, ["delivery", "effect", "route"]) && validActionResult(data)) {
    const providerAction = actionProjection(data)!;
    return (providerAction.effect === "unverifiable" || providerAction.effect === "confirmed")
      && (providerAction.route === "accessibility" || providerAction.route === "synthetic_events"
        || expected.deliveryMode === "foreground" && providerAction.route === "global_input")
      && (providerAction.delivery?.mode === "background" || expected.deliveryMode === "foreground" && providerAction.delivery?.mode === "foreground")
      && providerAction.delivery.deliveredCount === undefined
      && providerAction.escalation === null
      ? { kind: "delivered", providerAction }
      : { kind: "malformed" };
  }
  if (result.isError && exactVerifyKeys(data, ["code"]) && data["code"] === "background_unavailable"
    && data["effect"] === undefined && data["escalation"] === undefined) {
    return { kind: "not_delivered" };
  }
  if (result.isError && exactVerifyKeys(data, ["code", "effect", "escalation"])
    && data["code"] === "background_unavailable" && data["effect"] === "refused") {
    const escalation = record(data["escalation"]);
    if (escalation !== null && exactVerifyKeys(escalation, ["reason", "recommended"])
      && escalation["recommended"] === "foreground" && typeof escalation["reason"] === "string") {
      return { kind: "not_delivered", foregroundRequired: true };
    }
    return { kind: "malformed" };
  }
  if (result.isError && data["effect"] === "refused") {
    const escalation = record(data["escalation"]);
    const keys = escalation === null
      ? ["code", "effect", "pid", "reason", "window_id"]
      : ["code", "effect", "escalation", "pid", "reason", "window_id"];
    if (!exactVerifyKeys(data, keys) || data["pid"] !== expected.pid || data["window_id"] !== expected.windowId
      || typeof data["reason"] !== "string"
      || (escalation !== null && (!exactVerifyKeys(escalation, ["reason", "recommended"])
        || escalation["reason"] !== data["reason"]))) return { kind: "malformed" };
    const code = data["code"];
    if ((code === "window_not_found" || code === "owner_pid_mismatch") && escalation === null) return { kind: "not_delivered" };
    if (code === "off_space_or_ax_unresolved" && escalation?.["recommended"] === "foreground") return { kind: "not_delivered", foregroundRequired: true };
    if (code === "minimized_or_hidden_window" && escalation?.["recommended"] === "accessibility") return { kind: "not_delivered" };
    return { kind: "malformed" };
  }
  return result.isError ? { kind: "provider_failure" } : { kind: "malformed" };
}

/** Exact Cua 0.23.2 `invoke_menu` refusal. Its message stays provider-private. */
function isMenuPathUnavailable(result: CuaContextToolResult): boolean {
  const data = result.structuredContent;
  const refusal = data === null ? null : record(data["refusal"]);
  return result.isError && data !== null && exactVerifyKeys(data, ["refusal", "status"])
    && data["status"] === "refused" && refusal !== null
    && exactVerifyKeys(refusal, ["code", "message"])
    && refusal["code"] === "menu_path_unavailable" && typeof refusal["message"] === "string";
}

/**
 * Exact Cua 0.23.2 ActionResult admitted for a native-menu
 * create-window boundary. Generic ActionResult validation is intentionally insufficient:
 * a different route/delivery can never establish the semantic set handoff.
 */
function exactInvokeMenuAction(data: Readonly<Record<string, unknown>>): boolean {
  if (!exactVerifyKeys(data, ["delivery", "effect", "route"])
    || data["effect"] !== "unverifiable" || data["route"] !== "accessibility"
    || data["evidence"] !== undefined || data["escalation"] !== undefined) return false;
  const delivery = record(data["delivery"]);
  if (delivery === null || !exactVerifyKeys(delivery, ["mode"]) || delivery["mode"] !== "foreground"
    || delivery["delivered_count"] !== undefined) return false;
  return true;
}

/** Exact confirmed result returned by Cua 0.23 for set_window_frame. */
function setWindowFrameAction(result: CuaContextToolResult): NonNullable<CuaComputerMutationReceipt["providerAction"]> | null {
  const data = result.structuredContent;
  if (result.isError || data === null || !exactVerifyKeys(data, ["delivery", "effect", "evidence", "route"])
    || !validActionResult(data)) return null;
  const action = actionProjection(data);
  return action?.effect === "confirmed"
    && action.route === "accessibility"
    && action.delivery?.mode === "not_applicable"
    && action.delivery.deliveredCount === undefined
    && action.evidenceKinds.length === 1
    && action.evidenceKinds[0] === "value_readback"
    && action.escalation === null
    ? action
    : null;
}

/** Exact closed ActionResult emitted by the pinned daemon after a successful action. */
function validActionResult(data: Readonly<Record<string, unknown>>): boolean {
  if (typeof data["effect"] !== "string" || !["confirmed", "unverifiable", "suspected_noop"].includes(data["effect"])
    || typeof data["route"] !== "string" || !["accessibility", "synthetic_events", "global_input", "system_api", "dom", "trusted_input"].includes(data["route"])) return false;
  const delivery = data["delivery"];
  if (delivery !== undefined) {
    const parsed = record(delivery);
    if (parsed === null || !["background", "foreground", "not_applicable", "unknown"].includes(parsed["mode"] as string)
      || (parsed["delivered_count"] !== undefined && (!Number.isSafeInteger(parsed["delivered_count"])
        || (parsed["delivered_count"] as number) < 0 || (parsed["delivered_count"] as number) > 0xffff_ffff))) return false;
  }
  const evidence = data["evidence"];
  if (evidence !== undefined && (!Array.isArray(evidence) || evidence.length === 0 || evidence.some((raw) => {
    const item = record(raw);
    return item === null || !exactVerifyKeys(item, ["kind"]) || (item["kind"] !== "value_readback" && item["kind"] !== "window_change" && item["kind"] !== "native_api_result");
  }))) return false;
  if (data["effect"] === "confirmed" && (!Array.isArray(evidence) || evidence.length === 0)) return false;
  const escalation = data["escalation"];
  if (escalation !== undefined) {
    const parsed = record(escalation);
    if (parsed === null || !exactVerifyKeys(parsed, ["reason", "target"])
      || !["pixel", "foreground", "page", "session"].includes(parsed["target"] as string)
      || !["route_unavailable", "delivery_failed", "effect_unconfirmed", "suspected_noop", "permission_required"].includes(parsed["reason"] as string)) return false;
  }
  return true;
}

/**
 * Stable, content-free fingerprint for a fenced mutation response.  This is
 * intentionally only a schema stage: no response values, provider prose,
 * native identifiers, or requested text can reach a Genie or a receipt.
 */
function actionResultShapeDiagnostic(result: CuaContextToolResult):
  | "missing_structured_content"
  | "legacy_action_projection"
  | "action_result_contract"
  | "action_result_incompatible" {
  const data = result.structuredContent;
  if (data === null) return "missing_structured_content";
  // The pre-ActionResult macOS implementation emitted this legacy trio. It
  // is deliberately not accepted as success by the reviewed 0.19.3 contract.
  if (Object.hasOwn(data, "path") || Object.hasOwn(data, "verified")) return "legacy_action_projection";
  return validActionResult(data) ? "action_result_incompatible" : "action_result_contract";
}

const VERIFY_UNKNOWN_REASONS = new Set([
  "invalid_predicate", "unsupported_predicate", "untrusted_source", "multi_match",
  "target_missing", "observation_unavailable", "stability_unproven",
]);


const CUA_PROTOCOL_CLOSE_TAGS = new Set([
  "text", "parameter", "invoke", "function_calls", "function_call", "tool_use", "tool_call",
  "antml:parameter", "antml:invoke", "antml:function_calls",
]);

/** Literal pinned text_sanitize.rs projection; used only to detect mutation. */
function cuaSanitizedText(text: string): string {
  let kept = text.trimEnd();
  let strippedAny = false;
  for (;;) {
    const close = /<\/([A-Za-z0-9_:]+)>$/i.exec(kept);
    if (close === null) return strippedAny ? kept : text;
    const name = close[1]!.toLowerCase();
    if (!CUA_PROTOCOL_CLOSE_TAGS.has(name)) return strippedAny ? kept : text;
    const prefix = kept.slice(0, close.index);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`<${escaped}(?:>|\\s|$)`, "i").test(prefix)) return strippedAny ? kept : text;
    strippedAny = true;
    kept = prefix.trimEnd();
  }
}

const normalizeCuaKey = normalizeCuaMacosKey;

function parseVerifyState(
  result: CuaContextToolResult,
  target: Readonly<{ context: string; reference: string }>,
  expectedPredicateCount: number,
): CuaVerificationReceipt | null {
  const data = structured(result);
  if (data === null || !exactVerifyKeys(data, ["elapsed_ms", "predicates", "samples", "stable", "status"])
    || (data["status"] !== "satisfied" && data["status"] !== "unsatisfied" && data["status"] !== "unknown")
    || typeof data["stable"] !== "boolean"
    || !Number.isSafeInteger(data["samples"]) || (data["samples"] as number) < 1
    || !Number.isSafeInteger(data["elapsed_ms"]) || (data["elapsed_ms"] as number) < 0
    || !Array.isArray(data["predicates"])) return null;
  const predicates: { index: number; status: "satisfied" | "unsatisfied" | "unknown"; unknownReason: CuaVerificationReceipt["predicates"][number]["unknownReason"] }[] = [];
  for (const raw of data["predicates"]) {
    const predicate = record(raw);
    if (predicate === null || !exactVerifyKeys(predicate, ["index", "observed_json", "status", "unknown_reason"])
      || !Number.isSafeInteger(predicate["index"]) || (predicate["index"] as number) < 0
      || (predicate["status"] !== "satisfied" && predicate["status"] !== "unsatisfied" && predicate["status"] !== "unknown")
      || (predicate["unknown_reason"] !== null && (typeof predicate["unknown_reason"] !== "string" || !VERIFY_UNKNOWN_REASONS.has(predicate["unknown_reason"])))
      || (predicate["status"] === "unknown" && predicate["unknown_reason"] === null)
      || (predicate["status"] !== "unknown" && predicate["unknown_reason"] !== null)
      || (predicate["observed_json"] !== null && typeof predicate["observed_json"] !== "string")) return null;
    // observed_json is intentionally validated then discarded: it can contain
    // the very text a Human entered into the target UI.
    predicates.push({ index: predicate["index"] as number, status: predicate["status"], unknownReason: predicate["unknown_reason"] as CuaVerificationReceipt["predicates"][number]["unknownReason"] });
  }
  if (predicates.length !== expectedPredicateCount || predicates.length === 0
    || !predicates.every((predicate, index) => predicate.index === index)
    || data["stable"] !== (data["status"] === "satisfied")
    || (data["status"] === "satisfied" && (data["samples"] as number) < 2)
    || (data["status"] === "satisfied" && (!data["stable"] || predicates.some((predicate) => predicate.status !== "satisfied")))
    || (data["status"] === "unsatisfied" && predicates.every((predicate) => predicate.status !== "unsatisfied"))
    || (data["status"] === "unknown" && (predicates.some((predicate) => predicate.status === "unsatisfied")
      || predicates.every((predicate) => predicate.status !== "unknown")))) return null;
  return {
    version: 1,
    target: { version: 1, context: target.context, reference: target.reference },
    provider: "cua",
    status: data["status"],
    stable: data["stable"],
    elapsedMs: data["elapsed_ms"] as number,
    samples: data["samples"] as number,
    predicates,
    outcome: outcome("post_effect_verification", {
      retrySafety: "never", stateChangeCertainty: "not_applicable", providerCondition: "ready", targetCondition: "current", recovery: [],
    }),
  };
}

function exactVerifyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  // Provider envelopes are intentionally forward-compatible: validate every
  // required field and its pinned meaning, but ignore additive private fields.
  return keys.every((key) => Object.hasOwn(value, key));
}

/** Converts only the public camelCase predicate projection into Cua's pinned wire keys. */
function cuaVerifyExpect(expect: readonly Readonly<Record<string, unknown>>[]): readonly Readonly<Record<string, unknown>>[] | null {
  const converted: Readonly<Record<string, unknown>>[] = [];
  for (const raw of expect) {
    const predicate = record(raw);
    if (predicate === null || Object.keys(predicate).length !== 1
      || !Object.keys(predicate).every((key) => key === "window" || key === "element")) return null;
    const next: Record<string, unknown> = {};
    if (predicate["window"] !== undefined) {
      const window = record(predicate["window"]);
      if (window === null || !Object.keys(window).every((key) => key === "exists" || key === "bounds")) return null;
      const out: Record<string, unknown> = {};
      if (window["exists"] !== undefined) {
        if (typeof window["exists"] !== "boolean") return null;
        out["exists"] = window["exists"];
      }
      if (window["bounds"] !== undefined) {
        const bounds = record(window["bounds"]);
        if (bounds === null || !Object.keys(bounds).every((key) => ["x", "y", "width", "height", "tolerancePx"].includes(key))
          || !["x", "y", "width", "height"].every((key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]))) return null;
        if (bounds["tolerancePx"] !== undefined && (typeof bounds["tolerancePx"] !== "number" || !Number.isFinite(bounds["tolerancePx"]) || bounds["tolerancePx"] < 0 || bounds["tolerancePx"] > 100)) return null;
        out["bounds"] = { x: bounds["x"], y: bounds["y"], width: bounds["width"], height: bounds["height"], ...(bounds["tolerancePx"] === undefined ? {} : { tolerance_px: bounds["tolerancePx"] }) };
      }
      if (Object.keys(out).length === 0) return null;
      next["window"] = out;
    }
    if (predicate["element"] !== undefined) {
      const element = record(predicate["element"]);
      const selector = element === null ? null : record(element["selector"]);
      if (element === null || selector === null || !Object.keys(element).every((key) => ["selector", "exists", "valueEquals", "enabled", "selected"].includes(key))
        || !Object.keys(selector).every((key) => key === "role" || key === "labelContains")) return null;
      if ((selector["role"] !== undefined && (typeof selector["role"] !== "string" || selector["role"].length === 0))
        || (selector["labelContains"] !== undefined && (typeof selector["labelContains"] !== "string" || selector["labelContains"].length === 0))
        || Object.keys(selector).length === 0
        || (element["exists"] !== undefined && element["exists"] !== true)
        || (element["valueEquals"] !== undefined && typeof element["valueEquals"] !== "string")
        || (element["enabled"] !== undefined && typeof element["enabled"] !== "boolean")
        || (element["selected"] !== undefined && typeof element["selected"] !== "boolean")) return null;
      // Public semantic selector names never leak AX vocabulary. Convert only
      // the closed semantic roles admitted by the public Computer Use grammar.
      const semanticRoles = {
        text_area: "AXTextArea",
        text_field: "AXTextField",
        combo_box: "AXComboBox",
        slider: "AXSlider",
        button: "AXButton",
        checkbox: "AXCheckBox",
        menu_item: "AXMenuItem",
        status_text: "AXStaticText",
      } as const;
      const publicRole = selector["role"];
      const role = typeof publicRole === "string" && publicRole in semanticRoles
        ? semanticRoles[publicRole as keyof typeof semanticRoles]
        : publicRole;
      next["element"] = {
        selector: { ...(role === undefined ? {} : { role }), ...(selector["labelContains"] === undefined ? {} : { label_contains: selector["labelContains"] }) },
        ...(element["exists"] === undefined ? {} : { exists: true }),
        ...(element["valueEquals"] === undefined ? {} : { value_equals: element["valueEquals"] }),
        ...(element["enabled"] === undefined ? {} : { enabled: element["enabled"] }),
        ...(element["selected"] === undefined ? {} : { selected: element["selected"] }),
      };
    }
    if (Object.keys(next).length === 0) return null;
    converted.push(next);
  }
  return converted;
}

/**
 * A semantic adapter for Cua's reviewed inventory, focus, and snapshot-click subset. It owns no
 * daemon lifecycle and has no route admission: the caller must pass a readiness-checked port.
 * Committed capability contexts own one session lease until their retirement.
 */
export class CuaComputerUseAdapter {
  readonly registry: ComputerUseContextRegistry;
  private readonly port: CuaCheckedContextPort;
  private readonly maxWindows: number;
  private readonly readHidIdleNanoseconds: CuaReadHidIdleNanoseconds | null;
  private readonly clock: () => number;
  private readonly monotonicMilliseconds: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: CuaComputerUseAdapterOptions) {
    this.port = options.port;
    this.registry = options.registry ?? new ComputerUseContextRegistry();
    this.maxWindows = options.maxWindows ?? DEFAULT_MAX_WINDOWS;
    // Production construction explicitly injects the host HID reader. Keeping
    // this optional here lets isolated semantic adapters remain deterministic;
    // absent instrumentation is never misrepresented as a human takeover.
    this.readHidIdleNanoseconds = options.readHidIdleNanoseconds ?? null;
    this.clock = options.clock ?? performance.now.bind(performance);
    this.monotonicMilliseconds = options.monotonicMilliseconds ?? performance.now.bind(performance);
    this.sleep = options.sleep ?? ((milliseconds, signal) => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("cancelled"));
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      }, { once: true });
    }));
    if (!Number.isSafeInteger(this.maxWindows) || this.maxWindows < 1 || this.maxWindows > MAX_WINDOWS) {
      throw new Error("computer-use maxWindows must be between 1 and 100");
    }
  }

  private async call(
    leases: Lease[],
    scope: ComputerUseContextScope,
    name: CuaContextToolName,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    onProviderDispatch?: () => boolean | Promise<boolean>,
  ): Promise<CuaContextToolCallResult> {
    const result = await this.port.callContextTool(scope, name, args, signal, onProviderDispatch);
    if (result.ok) leases.push({ generation: result.generation, sessionId: result.sessionId });
    return result;
  }

  private async launch(
    leases: Lease[], scope: ComputerUseContextScope, bundleId: string, signal?: AbortSignal,
  ): Promise<CuaContextToolCallResult> {
    const result = await this.port.launchApplication(scope, bundleId, signal);
    if (result.ok) leases.push({ generation: result.generation, sessionId: result.sessionId });
    return result;
  }

  private async windowState(
    leases: Lease[], scope: ComputerUseContextScope, context: string, pid: number, windowId: number, query?: string, effort?: CuaWindowTraversalEffort, signal?: AbortSignal,
  ): Promise<Exclude<CuaContextToolCallResult, { ok: true }> | (Extract<CuaContextToolCallResult, { ok: true }> & { readTicket: ComputerUseWindowReadTicket })> {
    if (signal?.aborted) return { ok: false, code: "cancelled", stage: "tool" };
    const read = this.registry.beginWindowRead(context, scope, pid, windowId);
    if (!read.ok) return { ok: false, code: "context_fenced", stage: "tool" };
    const result = await this.port.getWindowState(scope, pid, windowId, query, signal, effort);
    if (result.ok) leases.push({ generation: result.generation, sessionId: result.sessionId });
    return result.ok ? { ...result, readTicket: read.data } : result;
  }

  private async windowCapture(
    leases: Lease[], scope: ComputerUseContextScope, context: string, pid: number, windowId: number, effort?: CuaWindowTraversalEffort, signal?: AbortSignal,
  ): Promise<Exclude<CuaWindowCaptureResult, { ok: true }> | (Extract<CuaWindowCaptureResult, { ok: true }> & { readTicket: ComputerUseWindowReadTicket })> {
    if (signal?.aborted) return { ok: false, code: "cancelled" };
    const read = this.registry.beginWindowRead(context, scope, pid, windowId);
    if (!read.ok) return { ok: false, code: "context_fenced" };
    const result = await this.port.captureWindowState(scope, pid, windowId, signal, effort);
    if (result.ok) leases.push({ generation: result.generation, sessionId: result.sessionId });
    return result.ok ? { ...result, readTicket: read.data } : result;
  }

  private async release(scope: ComputerUseContextScope, leases: readonly Lease[]): Promise<void> {
    // A lease carries both generation and session id, so cleanup from an old
    // checked port cannot end a later session. Cleanup has no retry or timer.
    await Promise.allSettled(leases.map((lease) => this.port.endContextLease(scope, lease.generation, lease.sessionId)));
  }

  /** Transfer one acquired lease only after a complete context commit. */
  private retain(context: string, scope: ComputerUseContextScope, leases: Lease[]): boolean {
    const lease = leases[0];
    if (lease === undefined || !this.registry.retainContextLease(context, scope,
      () => this.port.endContextLease(scope, lease.generation, lease.sessionId))) return false;
    leases.shift();
    return true;
  }

  /** Fence capabilities synchronously, then drain their exact-session leases. */
  close(): Promise<void> {
    return this.registry.close();
  }

  /** Check/advance the private HID fence associated with an attributed dctx_. */
  private async assertContextHumanControl(
    context: string,
    scope: ComputerUseContextScope,
  ): Promise<"current" | "external_interference" | "unavailable"> {
    if (this.readHidIdleNanoseconds === null) return "current";
    try {
      const epoch = await this.readHumanInputEpoch();
      const advanced = this.registry.advanceHumanInputEpoch(
        context,
        scope,
        epoch,
        HUMAN_INPUT_EPOCH_TOLERANCE_MILLISECONDS,
      );
      if (advanced.ok) return "current";
      return advanced.code === "external_interference" ? "external_interference" : "unavailable";
    } catch {
      // A failed local HID observation fails closed but does not claim the
      // Human acted. Only a measured epoch advance receives that marker.
      return "unavailable";
    }
  }

  /** Midpoint sampling makes the IOHID idle duration a monotonic epoch in ms. */
  private async readHumanInputEpoch(): Promise<number> {
    // The production main process always injects the monitor. Isolated
    // semantic adapters use this inert private baseline so they neither make
    // host-process HID calls nor manufacture an external-interference claim.
    if (this.readHidIdleNanoseconds === null) return 0;
    let firstFailure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const beforeMilliseconds = this.monotonicMilliseconds();
      try {
        const idleNanoseconds = await this.readHidIdleNanoseconds();
        const afterMilliseconds = this.monotonicMilliseconds();
        const epoch = (beforeMilliseconds + afterMilliseconds) / 2 - idleNanoseconds / 1_000_000;
        if (!Number.isFinite(epoch)) throw new Error("macOS human-input epoch was unavailable");
        return epoch;
      } catch (error) {
        firstFailure ??= error;
      }
    }
    // Re-reading the host's idle clock is observational and cannot replay a
    // Cua mutation. A successful fresh sample still exposes any Human input
    // since the retained context baseline; only two failed host reads withdraw
    // authority as unavailable.
    throw firstFailure;
  }

  /** A minted context is trustworthy only if no local input occurred during its source read. */
  private async requireStableHumanInputEpoch(beforeMilliseconds: number): Promise<number> {
    const afterMilliseconds = await this.readHumanInputEpoch();
    if (afterMilliseconds > beforeMilliseconds + HUMAN_INPUT_EPOCH_TOLERANCE_MILLISECONDS) {
      throw new CuaExternalInterferenceError();
    }
    return afterMilliseconds;
  }

  /** Semantic wire drift withdraws the Check token synchronously. */
  private invalidateMalformedProvider(): void {
    this.port.invalidateCheckedGeneration?.();
  }

  private launchReceipt(
    name: string,
    options: Omit<CuaComputerLaunchReceipt, "version" | "timing" | "action" | "app"> & { readonly appTarget: CuaComputerLaunchReceipt["app"]["target"] },
  ): CuaComputerLaunchReceipt {
    return {
      version: 1, timing: "immediate", action: "launch_app",
      app: { name, target: options.appTarget }, window: options.window,
      launchProgress: options.launchProgress, windowSelection: options.windowSelection,
      completionCertainty: options.completionCertainty, verification: options.verification, outcome: options.outcome,
    };
  }

  /**
   * Resolve a semantic application name before the mutation boundary. Cua's
   * name launch is first-match, so it is categorically not used here.
   */
  async launchApp(request: CuaComputerLaunchRequest): Promise<CuaComputerLaunchResult> {
    const name = request.operation.app.name;
    const preEffect = (providerCondition: "ready" | "cancelled" | "unknown" | "malformed_response", retrySafety: "safe" | "observe_before_retry" | "never", recovery: ComputerUseOperationOutcome["recovery"]) =>
      outcome("pre_effect_dispatch", { retrySafety, stateChangeCertainty: "not_changed", providerCondition, targetCondition: "unavailable", recovery });
    const knownNotStarted = (result: ComputerUseOperationOutcome) => this.launchReceipt(name, {
      appTarget: null, window: null, launchProgress: { requested: false, processRunning: false, windowReady: false },
      windowSelection: "none", completionCertainty: "not_completed", verification: "not_applicable", outcome: result,
    });
    const unknown = () => {
      const result = outcome("post_effect_verification", {
        retrySafety: "never", stateChangeCertainty: "unknown", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"],
      });
      return this.launchReceipt(name, { appTarget: null, window: null, launchProgress: null, windowSelection: "unknown", completionCertainty: "unknown_completion", verification: "not_applicable", outcome: result });
    };
    if (request.signal?.aborted) {
      const result = preEffect("cancelled", "safe", ["retry_same_request"]);
      return { ok: false, receipt: knownNotStarted(result), error: "Application launch was cancelled before discovery.", outcome: result };
    }
    const reserved = this.registry.reserveContext(request.scope);
    if (!reserved.ok) {
      const result = preEffect("ready", "never", []);
      return { ok: false, receipt: knownNotStarted(result), error: registryError(reserved.code), outcome: result };
    }
    const leases: Lease[] = [];
    let crossedBoundary = false;
    try {
      const acquisitionEpoch = await this.readHumanInputEpoch();
      const inventoryResult = await this.call(leases, request.scope, "list_apps", {}, request.signal);
      if (!inventoryResult.ok) {
        const result = preEffect(inventoryResult.code === "cancelled" ? "cancelled" : "unknown", inventoryResult.code === "cancelled" ? "safe" : "observe_before_retry", inventoryResult.code === "cancelled" ? ["retry_same_request"] : ["observe_again"]);
        return { ok: false, receipt: knownNotStarted(result), error: inventoryResult.code === "cancelled" ? "Application launch was cancelled before it began." : "Installed applications could not be resolved.", outcome: result };
      }
      if (inventoryResult.result.isError) {
        const result = preEffect("unknown", "observe_before_retry", ["observe_again"]);
        return { ok: false, receipt: knownNotStarted(result), error: "Installed applications could not be resolved.", outcome: result };
      }
      const inventory = parseInstalledApplications(inventoryResult.result);
      if (inventory === null) {
        this.invalidateMalformedProvider();
        const result = preEffect("malformed_response", "observe_before_retry", ["observe_again"]);
        return { ok: false, receipt: knownNotStarted(result), error: "Installed applications did not match the checked Cua contract.", outcome: result };
      }
      // list_all_apps may report several NSRunningApplication rows for one
      // bundle. Treat that exact private identity as one idempotent app, but
      // never collapse distinct or unknown (null-bundle) identities.
      const matches = inventory.filter((candidate) => candidate.name === name).reduce<ParsedInstalledApplication[]>((unique, candidate) => {
        if (candidate.bundleId !== undefined && unique.some((existing) => existing.bundleId === candidate.bundleId)) return unique;
        unique.push(candidate);
        return unique;
      }, []);
      if (matches.length !== 1) {
        const result = preEffect("ready", "safe", []);
        return { ok: false, receipt: knownNotStarted(result), error: matches.length === 0 ? "That application is unavailable on this desktop." : "That application name is ambiguous on this desktop.", outcome: result };
      }
      const matchedApplication = matches[0]!;
      if (matchedApplication.bundleId === undefined) {
        const result = preEffect("ready", "safe", []);
        return { ok: false, receipt: knownNotStarted(result), error: "That application is unavailable on this desktop.", outcome: result };
      }
      if (request.signal?.aborted) {
        const result = preEffect("cancelled", "safe", ["retry_same_request"]);
        return { ok: false, receipt: knownNotStarted(result), error: "Application launch was cancelled before it began.", outcome: result };
      }
      // Discovery is read-only but it is not an attribution-free gap: sample
      // again immediately before launch_app so Human input during list_apps
      // prevents this mutation from starting.
      const launchEpoch = await this.requireStableHumanInputEpoch(acquisitionEpoch);
      crossedBoundary = true;
      const launched = await this.launch(leases, request.scope, matchedApplication.bundleId, request.signal);
      if (!launched.ok || request.signal?.aborted || launched.generation !== inventoryResult.generation || launched.sessionId !== inventoryResult.sessionId) {
        const receipt = unknown();
        return { ok: false, receipt, error: "Application launch completion is unknown. Observe again; do not replay it.", outcome: receipt.outcome };
      }
      const parsed = parseLaunch(launched.result, { bundleId: matchedApplication.bundleId });
      if (parsed.kind === "malformed") {
        this.invalidateMalformedProvider();
        const receipt = unknown();
        return { ok: false, receipt, error: "Application launch completion is unknown. Observe again; do not replay it.", outcome: receipt.outcome };
      }
      if (parsed.kind === "unknown") {
        const receipt = unknown();
        return { ok: false, receipt, error: "Application launch completion is unknown. Observe again; do not replay it.", outcome: receipt.outcome };
      }
      if (parsed.kind === "refused") {
        const result = preEffect("ready", "safe", []);
        return { ok: false, receipt: knownNotStarted(result), error: "The requested application is unavailable for launch.", outcome: result };
      }
      if (parsed.kind === "failed") {
        const result = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
        const receipt = this.launchReceipt(name, { appTarget: null, window: null, launchProgress: parsed.progress, windowSelection: "none", completionCertainty: "not_completed", verification: "not_applicable", outcome: result });
        return { ok: false, receipt, error: "The application did not start.", outcome: result };
      }

      // Preserve the provider's full discovered count privately while retaining
      // only the established 100 window capabilities. The later semantic
      // app-window observation reports the difference exactly.
      const targets = parsed.windows.map((window) => ({
        evidence: { kind: "window" as const, appLabel: name, windowLabel: window.title, bounds: window.bounds },
        providerTarget: { provider: "cua" as const, operation: "focus" as const, app: name, pid: parsed.pid, windowId: window.windowId, bundleId: parsed.bundleId },
      }));
      // A launch receipt mints durable authority. Bind its private Human-input
      // epoch at the commit boundary so a later create_window cannot silently
      // attribute a document created after a local interaction.
      const humanInputEpochMilliseconds = await this.requireStableHumanInputEpoch(launchEpoch);
      const committed = this.registry.createReservedLaunch(reserved.data.reservation, request.scope, {
        evidence: { kind: "app", appLabel: name, focused: false },
        providerTarget: { provider: "cua", operation: "observe_only", app: name, pid: parsed.pid, bundleId: parsed.bundleId },
      }, targets, parsed.windows.length, humanInputEpochMilliseconds);
      if (!committed.ok) {
        const receipt = unknown();
        return { ok: false, receipt, error: "Application launch completion is unknown. Observe again; do not replay it.", outcome: receipt.outcome };
      }
      if (!this.retain(committed.data.context, request.scope, leases)) {
        const receipt = unknown();
        return { ok: false, receipt, error: "Application launch authority could not be retained. Observe again; do not replay it.", outcome: receipt.outcome };
      }
      const appTarget = { version: 1 as const, context: committed.data.context, reference: committed.data.app.reference };
      const unique = parsed.windows.length === 1 ? committed.data.windows[0] : null;
      const result = outcome("post_effect_verification", {
        retrySafety: "observe_before_retry", stateChangeCertainty: "changed", providerCondition: "ready", targetCondition: "current",
        recovery: ["observe_again"],
      });
      const receipt = this.launchReceipt(name, {
        appTarget, window: unique === undefined || unique === null ? null : { version: 1, context: committed.data.context, reference: unique.reference },
        launchProgress: parsed.progress, windowSelection: parsed.windows.length === 0 ? "none" : unique === null ? "ambiguous" : "unique",
        completionCertainty: "completed", verification: parsed.progress.windowReady ? "required" : "not_applicable", outcome: result,
      });
      return { ok: true, receipt };
    } catch (error) {
      const receipt = crossedBoundary ? unknown() : knownNotStarted(preEffect("unknown", "observe_before_retry", ["observe_again"]));
      const external = error instanceof CuaExternalInterferenceError;
      const classified = external ? { ...receipt.outcome, externalInterference: "user_input" as const } : receipt.outcome;
      return {
        ok: false,
        receipt: external ? { ...receipt, outcome: classified } : receipt,
        error: external ? "Local input interrupted the desktop operation. Observe again before acting." : crossedBoundary ? "Application launch completion is unknown. Observe again; do not replay it." : "Installed applications could not be resolved.",
        outcome: classified,
      };
    } finally {
      this.registry.releaseContextReservation(reserved.data.reservation);
      await this.release(request.scope, leases);
    }
  }

  /**
   * Freshly observe windows for one opaque launched-app capability.  Launch
   * can correctly return process_running before AppKit publishes a window;
   * returning that original launch set here would permanently report zero.
   */
  async observeApplicationWindows(request: CuaApplicationWindowsObserveRequest): Promise<CuaApplicationWindowsObserveResult> {
    const unavailable = (
      condition: "stale" | "unknown",
      providerCondition: "ready" | "cancelled" | "unknown" | "malformed_response",
      error: string,
    ): CuaApplicationWindowsObserveResult => {
      const result = outcome("observe", {
        retrySafety: providerCondition === "cancelled" ? "safe" : "observe_before_retry",
        stateChangeCertainty: "not_applicable", providerCondition, targetCondition: condition,
        recovery: providerCondition === "cancelled" ? ["retry_same_request"] : ["observe_again"],
      });
      return { ok: false, error, outcome: result };
    };
    const interrupted = (): CuaApplicationWindowsObserveResult => {
      const result = outcome("observe", {
        retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "unknown", targetCondition: "unknown",
        recovery: ["observe_again"], externalInterference: "user_input",
      });
      return { ok: false, error: "Local input interrupted the desktop operation. Observe again before acting.", outcome: result };
    };
    // A CAS loser did not observe a stale application or cross a mutation
    // boundary: a newer read of this same stable app capability has already
    // committed.  Report that explicitly rather than falsely withdrawing the
    // still-current app reference.
    const superseded = (): CuaApplicationWindowsObserveResult => {
      const result = outcome("observe", {
        retrySafety: "safe", stateChangeCertainty: "not_applicable", providerCondition: "ready", targetCondition: "current",
        recovery: ["retry_same_request"],
      });
      return { ok: false, error: "A newer app-window observation won; repeat if needed.", outcome: result };
    };
    // Capture the current revision before any provider await. The registry CAS
    // below prevents a slower concurrent refresh from withdrawing references
    // minted by the newer one.
    const prior = this.registry.resolveApplicationWindows(request.target.context, request.scope, request.target.reference);
    if (!prior.ok) return unavailable(prior.code === "replay_forbidden" ? "unknown" : "stale", "ready", registryError(prior.code));
    const app = this.registry.resolveObservationTarget(request.target.context, request.scope, request.target.reference);
    if (!app.ok) return unavailable(app.code === "replay_forbidden" ? "unknown" : "stale", "ready", registryError(app.code));
    const provider = app.data.providerTarget;
    if (app.data.evidence.kind !== "app" || provider.provider !== "cua" || provider.operation !== "observe_only"
      || provider.pid === undefined || provider.bundleId === undefined || provider.app !== app.data.evidence.appLabel) {
      return unavailable("stale", "ready", "This launched application is no longer available.");
    }
    const pid = provider.pid;
    const bundleId = provider.bundleId;
    const appLabel = app.data.evidence.appLabel;
    if (appLabel === undefined) return unavailable("stale", "ready", "This launched application is no longer available.");
    if (request.signal?.aborted) return unavailable("unknown", "cancelled", "Application-window observation was cancelled before it began.");
    const entryHumanControl = await this.assertContextHumanControl(request.target.context, request.scope);
    if (entryHumanControl !== "current") return entryHumanControl === "external_interference"
      ? interrupted()
      : unavailable("unknown", "unknown", "Desktop human-input state could not be read. Observe again before acting.");
    const leases: Lease[] = [];
    try {
      const appsResult = await this.call(leases, request.scope, "list_apps", {}, request.signal);
      if (!appsResult.ok || request.signal?.aborted) {
        return unavailable("unknown", !appsResult.ok && appsResult.code === "cancelled" || request.signal?.aborted ? "cancelled" : "unknown", "Application-window observation could not complete. Observe again.");
      }
      if (appsResult.result.isError) return unavailable("unknown", "unknown", "Cua could not return the launched application observation.");
      const installed = parseInstalledApplications(appsResult.result);
      if (installed === null) {
        this.invalidateMalformedProvider();
        return unavailable("unknown", "malformed_response", "Cua application-window observation did not match the checked Cua contract.");
      }
      // This capability is bound to the launch's exact process and bundle. A
      // same-named replacement process is not silently substituted.
      const current = installed.some((candidate) => candidate.running && candidate.pid === pid && candidate.bundleId === bundleId);
      if (!current) return unavailable("stale", "ready", "This launched application is no longer available.");
      // Pinned Cua supports this exact pid filter. It keeps a delayed-launch
      // refresh app-scoped at the provider boundary rather than treating an
      // unfiltered desktop inventory as a local filtering exercise.
      const windowsResult = await this.call(leases, request.scope, "list_windows", { pid }, request.signal);
      if (!windowsResult.ok || request.signal?.aborted) {
        return unavailable("unknown", !windowsResult.ok && windowsResult.code === "cancelled" || request.signal?.aborted ? "cancelled" : "unknown", "Application-window observation could not complete. Observe again.");
      }
      if (windowsResult.generation !== appsResult.generation || windowsResult.sessionId !== appsResult.sessionId) {
        this.invalidateMalformedProvider();
        return unavailable("unknown", "malformed_response", "Cua changed the checked application-window observation session unexpectedly.");
      }
      if (windowsResult.result.isError) return unavailable("unknown", "unknown", "Cua could not return the launched application windows.");
      const parsed = parseWindows(windowsResult.result);
      if (parsed === null) {
        this.invalidateMalformedProvider();
        return unavailable("unknown", "malformed_response", "Cua application-window observation did not match the checked Cua contract.");
      }
      // The checked `{pid}` Cua request promises one process only. PID and the
      // separately revalidated bundle identify the app; WindowServer's
      // `app_name` remains a presentation label and may legitimately differ
      // from `list_apps.name` for that same process.
      if (parsed.windows.some((window) => window.pid !== pid)) {
        this.invalidateMalformedProvider();
        return unavailable("unknown", "malformed_response", "Cua application-window observation did not match the checked Cua contract.");
      }
      // Cua's pid-scoped list is still raw layer-zero WindowServer inventory.
      // Keep helpers private and preserve off-Space ordinary candidates; exact
      // AX resolution remains the next, separate observation step.
      const windows = parsed.windows.filter((window) => window.appWindowCandidate);
      const retained = windows.map((window) => ({
        evidence: { kind: "window" as const, appLabel, windowLabel: window.title, bounds: window.bounds },
        providerTarget: { provider: "cua" as const, operation: "focus" as const, app: appLabel, pid, windowId: window.windowId, bundleId },
      }));
      const semanticEvidence: Array<
        | Readonly<{ kind: "inspected"; result: ParsedWindowSemanticQuery }>
        | Readonly<{ kind: "unavailable"; recovery: "focus_target" | "observe_again" }>
      > = [];
      const windowReads: ComputerUseWindowReadTicket[] = [];
      if (request.query !== undefined) {
        for (const window of windows) {
          const state = await this.windowState(leases, request.scope, request.target.context, pid, window.windowId, request.query, request.effort, request.signal);
          if (!state.ok || request.signal?.aborted) {
            return unavailable(
              "unknown",
              !state.ok && state.code === "cancelled" || request.signal?.aborted ? "cancelled" : "unknown",
              "Application-window semantic query could not complete. Observe again.",
            );
          }
          if (state.generation !== appsResult.generation || state.sessionId !== appsResult.sessionId) {
            this.invalidateMalformedProvider();
            return unavailable("unknown", "malformed_response", "Cua changed the checked application-window query session unexpectedly.");
          }
          windowReads.push(state.readTicket);
          const parsedState = parseWindowState(state.result, { pid, windowId: window.windowId });
          if (parsedState.kind === "stale") return unavailable("stale", "ready", "An application window changed during semantic query. Observe again.");
          if (parsedState.kind === "unknown") return unavailable("unknown", "unknown", "Cua could not return one application-window semantic query.");
          if (parsedState.kind === "capture_unavailable" || parsedState.kind === "malformed") {
            this.invalidateMalformedProvider();
            return unavailable("unknown", "malformed_response", "Cua application-window semantic query did not match the checked contract.");
          }
          if (parsedState.degraded) {
            semanticEvidence.push({
              kind: "unavailable",
              recovery: parsedState.degradedKind === "ax_window_unresolved" ? "focus_target" : "observe_again",
            });
            continue;
          }
          // Aggregate effort is echoed once on the application-level query;
          // duplicating it into every positive candidate adds no evidence.
          const semantic = parseWindowSemanticQuery(state.result, request.query);
          if (semantic === null) {
            this.invalidateMalformedProvider();
            return unavailable("unknown", "malformed_response", "Cua application-window semantic query did not match the checked contract.");
          }
          semanticEvidence.push({ kind: "inspected", result: {
            ...semantic,
            // Application-window discrimination needs one positive example
            // per candidate, not a duplicate dump of every occurrence inside
            // that candidate. Full exact-window queries return every provider
            // match; this projection preserves exact match accounting.
            returned: semantic.matched === 0 ? 0 : 1,
            omitted: semantic.matched === 0 ? 0 : semantic.matched - 1,
            matches: semantic.matched === 0 ? [] : [semantic.matches[0]!],
          } });
        }
      }
      // The refresh mints successor window references.  It must bind the
      // same persistent Human-input epoch that governed the source read.
      const refreshHumanControl = await this.assertContextHumanControl(request.target.context, request.scope);
      if (request.signal?.aborted) return unavailable("unknown", "cancelled", "Application-window observation was cancelled before publication. Observe again.");
      if (refreshHumanControl !== "current") return refreshHumanControl === "external_interference"
        ? interrupted()
        : unavailable("unknown", "unknown", "Desktop human-input state could not be read. Observe again before acting.");
      if (windowReads.some((read) => !this.registry.isCurrentWindowRead(request.target.context, request.scope, read).ok)) return superseded();
      const refreshed = this.registry.refreshApplicationWindows(
        request.target.context, request.scope, request.target.reference, retained, prior.data.revision, windows.length,
      );
      if (!refreshed.ok && refreshed.code === "refresh_conflict") return superseded();
      if (!refreshed.ok) return unavailable(refreshed.code === "replay_forbidden" ? "unknown" : "stale", "ready", registryError(refreshed.code));
      const allCandidates = refreshed.data.targets.map((target) => targetEnvelope(request.target.context, target));
      // A literal content query never changes the app-window inventory. Return
      // every freshly minted window target so callers can use the current
      // identity directly, including when no accessible label/value matches.
      // Per-candidate query results describe the separate non-exhaustive AX
      // search and therefore legitimately carry zero matches.
      const candidates = request.query === undefined
        ? allCandidates
        : allCandidates.map((candidate, index) => ({
          ...candidate,
          ...(semanticEvidence[index]?.kind === "inspected"
            ? { semanticQuery: semanticEvidence[index].result }
            : { semanticQueryUnavailable: {
              query: request.query!, status: "unavailable" as const,
              recovery: semanticEvidence[index]?.recovery ?? "observe_again",
            } }),
        }));
      const discovered = refreshed.data.discovered;
      const omitted = discovered - candidates.length;
      const result = outcome("observe", {
        retrySafety: omitted === 0 ? "safe" : "never", stateChangeCertainty: "not_applicable", providerCondition: "ready", targetCondition: "current",
        recovery: omitted === 0 ? ["retry_same_request"] : [],
      });
      return {
        ok: true,
        observation: {
          version: 1, operation: "application_windows", target: { version: 1, context: request.target.context, reference: request.target.reference },
          completeness: omitted === 0 ? "complete" : "partial", discovered, returned: candidates.length, omitted, candidates,
          ...(request.query === undefined ? {} : { semanticQuery: {
            query: request.query,
            ...(request.effort === undefined ? {} : { effort: request.effort }),
            exhaustive: false as const,
            inspected: semanticEvidence.filter((entry) => entry.kind === "inspected").length,
            uninspected: semanticEvidence.filter((entry) => entry.kind === "unavailable").length,
          } }),
          outcome: result,
        },
      };
    } finally {
      await this.release(request.scope, leases);
    }
  }

  /**
   * Fresh, exact window state. Query evidence, an optional selected control,
   * and an optional PNG are derived and committed from this one provider read;
   * raw AX, tokens, screenshot internals and diagnostics remain private.
   */
  async observeWindowState(request: CuaWindowStateObserveRequest): Promise<CuaWindowStateObserveResult> {
    const target = this.registry.resolveObservationTarget(request.target.context, request.scope, request.target.reference);
    const unavailable = (condition: "stale" | "unknown", providerCondition: "ready" | "cancelled" | "unknown" | "malformed_response", error: string): CuaWindowStateObserveResult => {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition, targetCondition: condition, recovery: ["observe_again"] });
      return { ok: false, error, outcome: result };
    };
    const interrupted = (): CuaWindowStateObserveResult => {
      const result = outcome("resolve_target", {
        retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "unknown", targetCondition: "unknown",
        recovery: ["observe_again"], externalInterference: "user_input",
      });
      return { ok: false, error: "Local input interrupted the desktop operation. Observe again before acting.", outcome: result };
    };
    if (!target.ok) return unavailable(target.code === "replay_forbidden" ? "unknown" : "stale", "ready", registryError(target.code));
    const provider = target.data.providerTarget;
    if (provider.provider !== "cua" || provider.operation !== "focus" || provider.pid === undefined || provider.windowId === undefined) {
      return unavailable("stale", "ready", "This desktop window is no longer available.");
    }
    if (request.signal?.aborted) return unavailable("unknown", "cancelled", "Window observation was cancelled before it began.");
    // Every requested read reaches Cua. The read boundary retires obsolete
    // same-window tokens; successful current state can mint their replacements.
    const entryHumanControl = await this.assertContextHumanControl(request.target.context, request.scope);
    if (entryHumanControl !== "current") return entryHumanControl === "external_interference"
      ? interrupted()
      : unavailable("unknown", "unknown", "Desktop human-input state could not be read. Observe again before acting.");
    const leases: Lease[] = [];
    let captureBytes: Uint8Array | null = null;
    let unreturnedImage: Uint8Array | null = null;
    try {
      const captureWindow = request.capture === "window_snapshot";
      // Cua's capture response contains the same AX state used below. Never
      // issue a second tree read when query or selector accompanies capture.
      const capturedState = captureWindow
        ? await this.windowCapture(leases, request.scope, request.target.context, provider.pid, provider.windowId, request.effort, request.signal)
        : null;
      if (capturedState?.ok === true) captureBytes = capturedState.png;
      const state = capturedState ?? await this.windowState(
        leases, request.scope, request.target.context, provider.pid, provider.windowId, request.query, request.effort, request.signal,
      );
      if (!state.ok || request.signal?.aborted) return unavailable("unknown", state.ok ? "cancelled" : state.code === "cancelled" ? "cancelled" : "unknown", "Window observation could not complete. Observe again.");
      const postReadHumanControl = await this.assertContextHumanControl(request.target.context, request.scope);
      if (request.signal?.aborted) return unavailable("unknown", "cancelled", "Window observation was cancelled before publication. Observe again.");
      if (postReadHumanControl !== "current") return postReadHumanControl === "external_interference"
        ? interrupted()
        : unavailable("unknown", "unknown", "Desktop human-input state could not be read. Observe again before acting.");
      if (!this.registry.isCurrentWindowRead(request.target.context, request.scope, state.readTicket).ok) {
        return unavailable("stale", "ready", "A newer window observation superseded this read. Use its current targets or observe again.");
      }
      const parsed = parseWindowState(
        state.result,
        { pid: provider.pid, windowId: provider.windowId },
        captureWindow,
        capturedState?.ok === true ? capturedState.png : null,
      );
      if (parsed.kind === "malformed") {
        this.invalidateMalformedProvider();
        return unavailable("unknown", "malformed_response", "Window observation did not match the checked Cua contract.");
      }
      if (parsed.kind === "stale") return unavailable("stale", "ready", "This desktop window is no longer available.");
      if (parsed.kind === "unknown") return unavailable("unknown", "unknown", "Window observation could not complete. Observe again.");
      if (parsed.kind === "capture_unavailable") {
        const result = outcome("observe", {
          retrySafety: "never", stateChangeCertainty: "not_applicable", providerCondition: "ready", targetCondition: "current",
          recovery: ["focus_target"],
        });
        return {
          ok: true,
          observation: {
            version: 1, operation: "window_state", target: { version: 1, context: request.target.context, reference: request.target.reference },
            evidence: target.data.evidence, completeness: "partial", degraded: true, verification: "indeterminate", outcome: result,
          },
        };
      }
      unreturnedImage = parsed.screenshot?.bytes ?? null;
      const semanticQuery = request.query === undefined ? null : parseWindowSemanticQuery(state.result, request.query, request.effort);
      if (request.query !== undefined && semanticQuery === null) {
        this.invalidateMalformedProvider();
        return unavailable("unknown", "malformed_response", "Window semantic query did not match the checked Cua contract.");
      }
      const result = outcome("observe", {
        // Repeating an unresolved off-Space read is futile. The caller must
        // focus this exact target once and then acquire a new observation.
        // `observe_before_retry` is reserved for states whose recovery is
        // actually `observe_again`; the public outcome schema enforces that
        // relationship at the Host boundary.
        retrySafety: parsed.degraded
          ? parsed.degradedKind === "ax_window_unresolved" ? "never" : "observe_before_retry"
          : "safe",
        stateChangeCertainty: "not_applicable", providerCondition: "ready", targetCondition: "current",
        recovery: parsed.degraded
          ? parsed.degradedKind === "ax_window_unresolved" ? ["focus_target"] : ["observe_again"]
          : ["retry_same_request"],
      });
      const snapshotInput = parsed.screenshot === undefined ? undefined : {
          pngBytes: parsed.screenshot.bytes,
          metadata: { format: "png" as const, dimensions: { width: parsed.screenshot.width, height: parsed.screenshot.height }, coordinateSpace: "window_snapshot_pixels" as const },
          providerSnapshot: { provider: "cua" as const, kind: "window" as const, pid: provider.pid, windowId: provider.windowId, width: parsed.screenshot.width, height: parsed.screenshot.height },
      };
      if (captureWindow && snapshotInput === undefined) {
        return unavailable("unknown", "unknown", "The exact window screenshot could not be retained. Observe again.");
      }
      const currentWindow = this.registry.resolveObservationTarget(request.target.context, request.scope, request.target.reference);
      if (!currentWindow.ok) return unavailable("stale", "ready", "This window observation was superseded. Observe again.");
      const selectedRole = request.selector?.role;
      const action = request.selector?.action ?? (selectedRole === "text_area" ? "type_text"
        : selectedRole === "text_field" || selectedRole === "combo_box" || selectedRole === "slider" ? "set_value" : "click");
      const selectedOperation: "type_text" | "set_value" | "scroll" | "click" | "right_click" | "double_click" | "press_key" = action === "click" ? request.selector?.interaction ?? "click" : action;
      const selection = selectedRole === undefined ? null : parsed.degraded
        ? { disposition: "incomplete" as const }
        : parseNativeElementSelection(state.result, {
          role: selectedRole,
          ...(request.selector?.labelEquals === undefined ? {} : { labelEquals: request.selector.labelEquals }),
        });
      const elementInput = selection?.disposition === "unique" && selectedRole !== undefined ? {
        evidence: {
          kind: "element" as const, role: selectedRole, action: selectedOperation,
          ...(selection.enabled === undefined ? {} : { enabled: selection.enabled }),
        },
        providerTarget: {
          provider: "cua" as const, operation: selectedOperation, pid: provider.pid, windowId: provider.windowId,
          ...(provider.app === undefined ? {} : { app: provider.app }),
          ...(provider.bundleId === undefined ? {} : { bundleId: provider.bundleId }),
          elementToken: selection.elementToken,
          semanticRole: selectedRole,
          ...(request.selector?.labelEquals === undefined ? {} : { semanticLabelEquals: request.selector.labelEquals }),
          ...(selection.observedValue === undefined ? {} : { observedValue: selection.observedValue }),
        },
      } : null;
      const controls = request.selector === undefined && !parsed.degraded ? nativeControlCollection(state.result, provider) : null;
      const committed = this.registry.registerWindowObservation(request.target.context, request.scope, state.readTicket, {
        ...(parsed.bounds === undefined ? {} : { bounds: parsed.bounds }),
        ...(elementInput === null ? {} : { element: elementInput }),
        ...(controls === null ? {} : { elements: controls.elements }),
        ...(snapshotInput === undefined ? {} : { snapshot: snapshotInput }),
      });
      if (!committed.ok) return unavailable("stale", "ready", "This window observation could not publish current targets. Observe again.");
      const mintedElement = committed.data.element;
      const windowSnapshot = committed.data.snapshot;
      if (controls !== null) {
        for (const binding of controls.bindings) {
          const target = committed.data.elements![binding.elementIndex]!;
          controls.collection.controls[binding.controlIndex]!.target = { version: 1, context: request.target.context, reference: target.reference };
        }
      }
      const element = selection === null || selectedRole === undefined ? undefined : {
        selector: {
          role: selectedRole,
          ...(request.selector?.interaction === undefined ? {} : { interaction: request.selector.interaction }),
          ...(request.selector?.action === undefined ? {} : { action: request.selector.action }),
        },
        disposition: mintedElement !== null ? "unique" as const : selection.disposition === "unique" ? "incomplete" as const : selection.disposition,
        ...(mintedElement !== null ? {
          target: { version: 1 as const, context: request.target.context, reference: mintedElement.reference },
          evidence: elementInput!.evidence,
          ...(selection?.disposition === "unique" ? { state: selection.state } : {}),
        } : {}),
      };
      // A deliberate fresh read replaces old tokens; it never replays an effect.
      const observationOutcome = result;
      unreturnedImage = null;
      return {
        ok: true,
        observation: {
          version: 1, operation: "window_state", target: { version: 1, context: request.target.context, reference: request.target.reference },
          evidence: { ...target.data.evidence, ...(parsed.bounds === undefined ? {} : { bounds: parsed.bounds }) }, completeness: parsed.degraded ? "partial" : "sufficient", degraded: parsed.degraded,
          verification: parsed.degraded ? "indeterminate" : "supported", ...(element === undefined ? {} : { element }),
          ...(controls === null ? {} : { controlCollection: controls.collection }),
          ...(windowSnapshot !== null ? {
            windowSnapshot: {
              target: { version: 1 as const, context: request.target.context, reference: windowSnapshot.reference },
              evidence: windowSnapshot.evidence,
              metadata: windowSnapshot.metadata as { format: "png"; dimensions: { width: number; height: number }; coordinateSpace: "window_snapshot_pixels" },
            },
          } : {}),
          ...(semanticQuery === null ? {} : { semanticQuery }),
          outcome: observationOutcome,
        },
        ...(parsed.screenshot === undefined ? {} : { visionImage: { mime: "image/png" as const, bytes: parsed.screenshot.bytes } }),
      };
    } finally {
      captureBytes?.fill(0);
      unreturnedImage?.fill(0);
      await this.release(request.scope, leases);
    }
  }

  /**
   * Isolate an exact region from the currently retained window image while
   * preserving a private mapping back to Cua's full-window pixel frame.
   * Replacing the parent dsnap_ keeps the visual authority one-shot without
   * depending on Cua's daemon-session-scoped from_zoom state.
   */
  async observeWindowRegion(request: CuaWindowRegionObserveRequest): Promise<CuaWindowRegionObserveResult> {
    const source = { version: 1 as const, context: request.target.context, reference: request.target.reference };
    const failed = (error: string, targetCondition: "stale" | "unavailable" | "unknown", providerCondition: "ready" | "cancelled" | "unknown" = "ready"): CuaWindowRegionObserveResult => {
      const result = outcome("observe", {
        retrySafety: "observe_before_retry",
        stateChangeCertainty: "not_applicable",
        providerCondition,
        targetCondition,
        recovery: ["observe_again"],
      });
      return { ok: false, error, outcome: result };
    };
    const snapshot = this.registry.resolveScreenSnapshot(request.target.context, request.scope, request.target.reference);
    if (!snapshot.ok) return failed(registryError(snapshot.code), "stale");
    const frame = windowSnapshotFrame(snapshot.data.metadata, snapshot.data.providerSnapshot);
    const { x, y, width, height } = request.region;
    if (frame === null || request.coordinateSpace !== frame.coordinateSpace
      || !Number.isSafeInteger(x) || x < 0
      || !Number.isSafeInteger(y) || y < 0
      || !Number.isSafeInteger(width) || width <= 0
      || !Number.isSafeInteger(height) || height <= 0
      || x + width > frame.width || y + height > frame.height) {
      snapshot.data.pngBytes.fill(0);
      return failed("The requested precision region is outside this exact snapshot.", "unavailable");
    }
    if (request.signal?.aborted) {
      snapshot.data.pngBytes.fill(0);
      return failed("Precision observation was cancelled before it began.", "unknown", "cancelled");
    }
    const entryHumanControl = await this.assertContextHumanControl(request.target.context, request.scope);
    if (entryHumanControl !== "current") {
      snapshot.data.pngBytes.fill(0);
      return failed(
        entryHumanControl === "external_interference"
          ? "Local input interrupted the desktop operation. Observe again before acting."
          : "Desktop human-input state could not be read. Observe again before acting.",
        "unknown",
        "unknown",
      );
    }
    let cropped: Uint8Array;
    try {
      const image = await Jimp.read(Buffer.from(snapshot.data.pngBytes));
      if (image.bitmap.width !== frame.width || image.bitmap.height !== frame.height) {
        return failed("The retained screenshot dimensions no longer match its checked authority.", "unavailable");
      }
      image.crop({ x, y, w: width, h: height });
      cropped = new Uint8Array(await image.getBuffer(JimpMime.png));
    } catch {
      return failed("The retained screenshot could not produce a precision view.", "unknown", "unknown");
    } finally {
      snapshot.data.pngBytes.fill(0);
    }
    if (request.signal?.aborted) {
      cropped.fill(0);
      return failed("Precision observation was cancelled before it completed.", "unknown", "cancelled");
    }
    if (cropped.byteLength > COMPUTER_USE_HOST_PNG_MAX_BYTES) {
      cropped.fill(0);
      return failed("The precision image exceeds the checked attachment transport.", "unavailable");
    }
    let published = false;
    try {
      const postReadHumanControl = await this.assertContextHumanControl(request.target.context, request.scope);
      if (request.signal?.aborted) {
        return failed("Precision observation was cancelled before publication.", "unknown", "cancelled");
      }
      if (postReadHumanControl !== "current") {
        cropped.fill(0);
        return failed(
          postReadHumanControl === "external_interference"
            ? "Local input interrupted the desktop operation. Observe again before acting."
            : "Desktop human-input state could not be read. Observe again before acting.",
          "unknown",
          "unknown",
        );
      }
      const absoluteOrigin = { x: frame.origin.x + x, y: frame.origin.y + y };
      const registered = this.registry.registerWindowRegionSnapshot(
        request.target.context,
        request.scope,
        request.target.reference,
        {
          pngBytes: cropped,
          metadata: {
            format: "png",
            dimensions: { width, height },
            coordinateSpace: "presented_snapshot_pixels",
          },
          providerSnapshot: {
            provider: "cua",
            kind: "window_region",
            pid: frame.pid,
            windowId: frame.windowId,
            windowWidth: frame.windowWidth,
            windowHeight: frame.windowHeight,
            origin: absoluteOrigin,
            width,
            height,
          },
        },
      );
      if (!registered.ok) {
        cropped.fill(0);
        return failed("The precision view could not replace its source authority.", "stale");
      }
      const result = outcome("observe", {
        retrySafety: "never",
        stateChangeCertainty: "not_applicable",
        providerCondition: "ready",
        targetCondition: "current",
        recovery: [],
      });
      const response: CuaWindowRegionObserveResult = {
        ok: true,
        observation: {
          version: 1,
          operation: "window_region",
          source,
          regionSnapshot: {
            target: { version: 1, context: request.target.context, reference: registered.data.reference },
            evidence: registered.data.evidence,
            metadata: registered.data.metadata as {
              format: "png";
              dimensions: { width: number; height: number };
              coordinateSpace: "presented_snapshot_pixels";
            },
          },
          outcome: result,
        },
        visionImage: { mime: "image/png", bytes: cropped },
      };
      published = true;
      return response;
    } finally {
      if (!published) cropped.fill(0);
    }
  }

  /**
   * Re-reads Cua's exact process/window inventory immediately before a
   * window-targeted key or text mutation.  The retained opaque observation is
   * authority, never a substitute for this liveness preflight.
   */
  private async preflightExactWindow(
    scope: ComputerUseContextScope,
    provider: Readonly<{ pid?: number; windowId?: number; app?: string; bundleId?: string }> | undefined,
    signal: AbortSignal | undefined,
    leases: Lease[],
  ): Promise<"current" | "cancelled" | "unavailable" | "malformed" | "provider_failed" | "session_failed"> {
    if (provider?.pid === undefined || provider.windowId === undefined || provider.app === undefined) return "unavailable";
    const appsResult = await this.call(leases, scope, "list_apps", {}, signal);
    if (!appsResult.ok) return appsResult.code === "cancelled" ? "cancelled" : "session_failed";
    if (appsResult.result.isError) return "provider_failed";
    const apps = parseApplications(appsResult.result);
    if (apps === null) return "malformed";
    const windowsResult = await this.call(leases, scope, "list_windows", {}, signal);
    if (!windowsResult.ok || windowsResult.generation !== appsResult.generation || windowsResult.sessionId !== appsResult.sessionId) {
      return !windowsResult.ok && windowsResult.code === "cancelled" ? "cancelled" : "session_failed";
    }
    if (windowsResult.result.isError) return "provider_failed";
    const windows = parseWindows(windowsResult.result, new Map(apps.applications.map((app) => [app.pid, app])));
    if (windows === null) return "malformed";
    if (signal?.aborted) return "cancelled";
    const app = apps.applications.find((candidate) => candidate.pid === provider.pid && candidate.name === provider.app
      && (provider.bundleId === undefined || candidate.bundleId === provider.bundleId));
    const window = windows.windows.find((candidate) => candidate.pid === provider.pid && candidate.windowId === provider.windowId && candidate.appName === provider.app);
    return app === undefined || window === undefined ? "unavailable" : "current";
  }

  async observe(request: ComputerObserveRequest): Promise<ComputerObserveResult> {
    if (request.signal?.aborted) {
      return observationFailure("cancelled", "Desktop observation was cancelled before it began.", toolFailureOutcome("cancelled"));
    }
    const limit = request.maxWindows ?? this.maxWindows;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WINDOWS) {
      return observationFailure("invalid_request", "desktop_state maxWindows must be between 1 and 100", outcome("observe", { retrySafety: "never", stateChangeCertainty: "not_applicable", recovery: [] }));
    }
    if (request.continuation !== undefined) {
      if (request.continuation.version !== 1) {
        return observationFailure("invalid_request", "desktop_state continuation version is unsupported", outcome("observe", { retrySafety: "never", stateChangeCertainty: "not_applicable", recovery: [] }));
      }
      const continuationRequest = request.continuation;
      const continuationHumanControl = await this.assertContextHumanControl(continuationRequest.context, request.scope);
      if (continuationHumanControl !== "current") return observationFailure(
        continuationHumanControl === "external_interference" ? "external_interference" : "human_input_unavailable",
        continuationHumanControl === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.",
        outcome("observe", {
          retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "unknown", targetCondition: "unknown",
          recovery: ["observe_again"], ...(continuationHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}),
        }),
      );
      const retained = this.registry.redeemContinuation(continuationRequest.context, request.scope, continuationRequest.reference);
      if (!retained.ok) return observationFailure(retained.code, registryError(retained.code), outcome("observe", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", targetCondition: "stale", recovery: ["observe_again"] }));
      const targets = retained.data.targets.slice(0, limit);
      const omitted = retained.data.targets.length - targets.length;
      const minted = omitted === 0 ? null : this.registry.mintContinuation(continuationRequest.context, request.scope, retained.data.targets.slice(limit).map((target) => target.reference));
      if (minted !== null && !minted.ok) return observationFailure(minted.code, registryError(minted.code), outcome("observe", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", targetCondition: "stale", recovery: ["observe_again"] }));
      const coverage = retained.data.coverage;
      return {
        ok: true,
        observation: {
          version: 1, operation: "desktop_state", context: continuationRequest.context,
          completeness: omitted === 0 && coverage === null ? "complete" : "partial",
          discovered: retained.data.targets.length, returned: targets.length, omitted,
          boundary: coverage !== null ? { kind: "provider_limit", retryable: false } : omitted > 0 ? { kind: "response_limit", retryable: true } : { kind: "none", retryable: false },
          uninspected: coverage === null ? null : { applications: coverage.uninspectedApplications, knownWindows: coverage.knownUninspectedWindows, windowCountExact: coverage.windowCountExact },
          continuation: minted?.ok ? { version: 1, reference: minted.data.reference } : null,
          alternatives: [{ kind: "observe_again", available: coverage === null }, { kind: "request_access", available: false }, { kind: "focus_target", available: targets.length > 0 }],
          targets: targets.map((target) => targetEnvelope(continuationRequest.context, target)),
          applicationTargets: { discovered: 0, returned: 0, omitted: 0, targets: [] },
          outcome: observationOutcome(coverage),
        },
      };
    }

    const reserved = this.registry.reserveContext(request.scope);
    if (!reserved.ok) return observationFailure(reserved.code, registryError(reserved.code), outcome("observe", { retrySafety: "never", stateChangeCertainty: "not_applicable", recovery: [] }));
    const leases: Lease[] = [];
    try {
      let acquisitionEpoch: number;
      try { acquisitionEpoch = await this.readHumanInputEpoch(); } catch {
        return observationFailure("human_input_unavailable", "Desktop human-input state could not be read. Observe again before acting.", outcome("observe", {
          retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
        }));
      }
      const appsResult = await this.call(leases, request.scope, "list_apps", {}, request.signal);
      if (!appsResult.ok) return observationFailure(appsResult.code, "Cua could not return a desktop application observation.", toolFailureOutcome(appsResult.code));
      if (request.signal?.aborted) return observationFailure("cancelled", "Desktop observation was cancelled before it completed.", toolFailureOutcome("cancelled"));
      if (appsResult.result.isError) return observationFailure("provider_error", "Cua could not return a desktop application observation.", toolFailureOutcome("provider_error"));
      const apps = parseApplications(appsResult.result);
      if (apps === null) {
        this.invalidateMalformedProvider();
        return observationFailure("provider_malformed", "Cua did not return the pinned structured application observation.", outcome("observe", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "malformed_response", recovery: ["observe_again"] }));
      }

      const windowsResult = await this.call(leases, request.scope, "list_windows", {}, request.signal);
      if (!windowsResult.ok) return observationFailure(windowsResult.code, "Cua could not return a desktop window observation.", toolFailureOutcome(windowsResult.code));
      if (windowsResult.generation !== appsResult.generation || windowsResult.sessionId !== appsResult.sessionId) {
        this.invalidateMalformedProvider();
        return observationFailure("provider_malformed", "Cua changed the checked observation session unexpectedly.", outcome("observe", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "malformed_response", recovery: ["observe_again"] }));
      }
      if (windowsResult.result.isError) return observationFailure("provider_error", "Cua could not return a desktop window observation.", toolFailureOutcome("provider_error"));
      const applicationsByPid = new Map(apps.applications.map((app) => [app.pid, app]));
      const windows = parseWindows(windowsResult.result, applicationsByPid);
      if (windows === null) {
        this.invalidateMalformedProvider();
        return observationFailure("provider_malformed", "Cua did not return the pinned structured window observation.", outcome("observe", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "malformed_response", recovery: ["observe_again"] }));
      }

      const capture = await this.port.captureDesktopState(request.scope, request.signal);
      if (!capture.ok) {
        // A malformed snapshot response is the same class of failure as a
        // malformed list_apps/list_windows parse: provider incompatibility,
        // recoverable by observing again. It does not infer an authority
        // revocation; provider readiness is reconciled separately.
        if (capture.code === "provider_malformed") {
          this.invalidateMalformedProvider();
          return observationFailure("provider_malformed", "Cua did not return the pinned structured desktop snapshot.", outcome("observe", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "malformed_response", recovery: ["observe_again"] }));
        }
        return observationFailure(capture.code, "Cua could not return a bounded desktop snapshot.", toolFailureOutcome(capture.code));
      }
      leases.push({ generation: capture.generation, sessionId: capture.sessionId });
      if (capture.generation !== appsResult.generation || capture.sessionId !== appsResult.sessionId) {
        this.invalidateMalformedProvider();
        return observationFailure("provider_malformed", "Cua changed the checked observation session unexpectedly.", outcome("observe", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "malformed_response", recovery: ["observe_again"] }));
      }
      if (request.signal?.aborted) return observationFailure("cancelled", "Desktop observation was cancelled before it completed.", toolFailureOutcome("cancelled"));

      const coverage: ComputerUseObservationCoverage | null = apps.uninspectedApplications > 0 || windows.uninspectedWindows > 0
        ? { uninspectedApplications: apps.uninspectedApplications, knownUninspectedWindows: windows.uninspectedWindows, windowCountExact: windows.uninspectedWindows === 0 }
        : null;
      // Raw layer-zero inventory includes unlocated retained/helper surfaces.
      // Use the same geometry/location evidence as app-scoped discovery, never
      // a title or size heuristic. A candidate is not proof of input readiness.
      const semanticWindows = windows.windows.filter((window) => window.appWindowCandidate);
      const omitted = Math.max(0, semanticWindows.length - limit);
      const targets: readonly { readonly evidence: ComputerUseTargetEvidence; readonly providerTarget: ComputerUseProviderTarget }[] = [
        ...semanticWindows.map((window) => {
          const application = applicationsByPid.get(window.pid)!;
          return {
            // list_windows proves exact identity and geometry, not that this
            // particular window is focused. An active application can own
            // several windows, so preserve that uncertainty for focus receipts.
            evidence: { kind: "window" as const, appLabel: window.appName, windowLabel: window.title, bounds: window.bounds },
            providerTarget: { provider: "cua" as const, operation: "focus" as const, app: window.appName, pid: window.pid, windowId: window.windowId, ...(application.bundleId === undefined ? {} : { bundleId: application.bundleId }) },
          };
        }),
        ...apps.applications.map((app) => ({
          // Cua list_apps proves the active application but not hidden/visible
          // state; do not manufacture a visibility fact for this observation.
          evidence: { kind: "app" as const, appLabel: app.name, focused: app.active },
          providerTarget: { provider: "cua" as const, operation: "observe_only" as const, app: app.name, pid: app.pid, ...(app.bundleId === undefined ? {} : { bundleId: app.bundleId }) },
        })),
      ];
      let humanInputEpochMilliseconds: number;
      try {
        humanInputEpochMilliseconds = await this.requireStableHumanInputEpoch(acquisitionEpoch);
      } catch (error) {
        const external = error instanceof CuaExternalInterferenceError;
        return observationFailure(external ? "external_interference" : "human_input_unavailable",
          external ? "Local input interrupted the desktop observation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.",
          outcome("observe", {
            retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
            ...(external ? { externalInterference: "user_input" as const } : {}),
          }));
      }
      const created = this.registry.createReservedDesktopState(
        reserved.data.reservation,
        request.scope,
        targets,
        {
          pngBytes: capture.png,
          metadata: {
            format: "png",
            nativeDimensions: { width: capture.nativeWidth, height: capture.nativeHeight },
            presentedDimensions: { width: capture.nativeWidth, height: capture.nativeHeight },
            display: { coordinateSpace: "desktop_pixels", origin: { x: 0, y: 0 } },
          },
          providerSnapshot: {
            provider: "cua",
            kind: "desktop",
            nativeWidth: capture.nativeWidth,
            nativeHeight: capture.nativeHeight,
            screenWidth: capture.screenWidth,
            screenHeight: capture.screenHeight,
            scaleFactor: capture.scaleFactor,
          },
        },
        coverage,
        omitted === 0 ? null : { start: limit, end: semanticWindows.length },
        humanInputEpochMilliseconds,
      );
      if (!created.ok) return observationFailure(created.code, registryError(created.code), outcome("observe", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", targetCondition: "stale", recovery: ["observe_again"] }));
      if (!this.retain(created.data.context, request.scope, leases)) return observationFailure("context_fenced", "Desktop observation authority could not be retained. Observe again.", outcome("observe", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", targetCondition: "stale", recovery: ["observe_again"] }));
      const registeredWindows = created.data.targets.filter((target) => target.evidence.kind === "window");
      const registeredApps = created.data.targets.filter((target) => target.evidence.kind === "app");
      const visible = registeredWindows.slice(0, limit);
      return {
        ok: true,
        observation: {
          version: 1, operation: "desktop_state", context: created.data.context,
          completeness: omitted === 0 && coverage === null ? "complete" : "partial",
          discovered: registeredWindows.length, returned: visible.length, omitted,
          boundary: coverage !== null ? { kind: "provider_limit", retryable: false } : omitted > 0 ? { kind: "response_limit", retryable: true } : { kind: "none", retryable: false },
          uninspected: coverage === null ? null : { applications: coverage.uninspectedApplications, knownWindows: coverage.knownUninspectedWindows, windowCountExact: coverage.windowCountExact },
          continuation: created.data.continuation === null ? null : { version: 1, reference: created.data.continuation.reference },
          alternatives: [{ kind: "observe_again", available: coverage === null }, { kind: "request_access", available: false }, { kind: "focus_target", available: visible.length > 0 }],
          targets: visible.map((target) => targetEnvelope(created.data.context, target)),
          applicationTargets: { discovered: registeredApps.length, returned: registeredApps.length, omitted: 0, targets: registeredApps.map((target) => targetEnvelope(created.data.context, target)) },
          ...(created.data.screenSnapshot === null ? {} : {
            screenSnapshot: {
              target: { version: 1, context: created.data.context, reference: created.data.screenSnapshot.reference },
              evidence: created.data.screenSnapshot.evidence,
              metadata: created.data.screenSnapshot.metadata as Extract<ComputerUseScreenSnapshotMetadata, { readonly display: unknown }>,
            },
          }),
          outcome: observationOutcome(coverage),
        },
        visionImage: { mime: "image/png", bytes: capture.png.slice() },
      };
    } finally {
      this.registry.releaseContextReservation(reserved.data.reservation);
      await this.release(request.scope, leases);
    }
  }

  async focus(request: ComputerDoFocusRequest): Promise<CuaComputerDoResult> {
    const { context, reference } = request.operation.target;
    const target = this.registry.resolveTarget(context, request.scope, reference);
    if (!target.ok) {
      const evidence: ComputerUseTargetEvidence = { kind: "window", role: "unavailable" };
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", targetCondition: "stale", recovery: ["observe_again"] });
      return { ok: false, receipt: focusFailureReceipt(request, evidence, "not_completed", result), error: registryError(target.code), outcome: result };
    }
    const provider = target.data.providerTarget;
    if (provider.provider !== "cua" || provider.operation !== "focus" || provider.pid === undefined || provider.windowId === undefined || provider.app === undefined) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
      return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "not_completed", result), error: "This target cannot be focused by the selected desktop provider.", outcome: result };
    }
    if (request.signal?.aborted) {
      const result = outcome("pre_effect_dispatch", { retrySafety: "safe", stateChangeCertainty: "not_changed", providerCondition: "cancelled", targetCondition: "current", recovery: ["retry_same_request"] });
      return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "not_completed", result), error: "Desktop focus was cancelled before it began.", outcome: result };
    }
    const entryHumanControl = await this.assertContextHumanControl(context, request.scope);
    if (entryHumanControl !== "current") {
      const result = outcome("resolve_target", {
        retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
        ...(entryHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}),
      });
      return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "not_completed", result), error: entryHumanControl === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: result };
    }
    const leases: Lease[] = [];
    let mutationBoundaryCrossed = false;
    try {
      const preflightApps = await this.call(leases, request.scope, "list_apps", {}, request.signal);
      if (!preflightApps.ok) {
        const result = outcome("pre_effect_dispatch", { retrySafety: preflightApps.code === "cancelled" ? "safe" : "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: preflightApps.code === "cancelled" ? "cancelled" : "unknown", targetCondition: "unavailable", recovery: preflightApps.code === "cancelled" ? ["retry_same_request"] : ["observe_again"] });
        return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "not_completed", result), error: "Cua could not preflight the exact desktop target.", outcome: result };
      }
      if (preflightApps.result.isError) {
        const result = outcome("pre_effect_dispatch", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"] });
        return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "not_completed", result), error: "Cua could not preflight the exact desktop target.", outcome: result };
      }
      const currentApps = parseApplications(preflightApps.result);
      if (currentApps === null || request.signal?.aborted) {
        if (currentApps === null) this.invalidateMalformedProvider();
        const result = outcome("pre_effect_dispatch", { retrySafety: request.signal?.aborted ? "safe" : "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: request.signal?.aborted ? "cancelled" : "malformed_response", targetCondition: "unknown", recovery: request.signal?.aborted ? ["retry_same_request"] : ["observe_again"] });
        return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "not_completed", result), error: request.signal?.aborted ? "Desktop focus was cancelled before it began." : "Cua did not return the pinned structured application observation.", outcome: result };
      }
      // The opaque target already binds an exact PID. Re-read only that
      // application's windows so the provider returns the smallest exact
      // identity set. The same-session list_apps read below still independently
      // verifies the PID/name/bundle binding.
      const preflightWindows = await this.call(leases, request.scope, "list_windows", { pid: provider.pid }, request.signal);
      if (!preflightWindows.ok || preflightWindows.generation !== preflightApps.generation || preflightWindows.sessionId !== preflightApps.sessionId) {
        if (preflightWindows.ok) this.invalidateMalformedProvider();
        const result = outcome("pre_effect_dispatch", { retrySafety: !preflightWindows.ok && preflightWindows.code === "cancelled" ? "safe" : "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: !preflightWindows.ok && preflightWindows.code === "cancelled" ? "cancelled" : "unknown", targetCondition: "unavailable", recovery: !preflightWindows.ok && preflightWindows.code === "cancelled" ? ["retry_same_request"] : ["observe_again"] });
        return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "not_completed", result), error: "Cua could not preflight the exact desktop target.", outcome: result };
      }
      if (preflightWindows.result.isError) {
        const result = outcome("pre_effect_dispatch", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"] });
        return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "not_completed", result), error: "Cua could not preflight the exact desktop target.", outcome: result };
      }
      const currentWindows = parseWindows(
        preflightWindows.result,
        new Map(currentApps.applications.map((app) => [app.pid, app])),
      );
      const currentApp = currentApps.applications.find((app) => app.pid === provider.pid && app.name === provider.app && (provider.bundleId === undefined || app.bundleId === provider.bundleId));
      const current = currentWindows?.windows.find((window) => window.pid === provider.pid && window.windowId === provider.windowId && window.appName === provider.app);
      if (current === undefined || request.signal?.aborted) {
        if (currentWindows === null) this.invalidateMalformedProvider();
        const result = outcome("pre_effect_dispatch", { retrySafety: request.signal?.aborted ? "safe" : "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: request.signal?.aborted ? "cancelled" : currentWindows === null ? "malformed_response" : "ready", targetCondition: currentWindows === null ? "unknown" : "unavailable", recovery: request.signal?.aborted ? ["retry_same_request"] : ["observe_again"] });
        return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "not_completed", result), error: request.signal?.aborted ? "Desktop focus was cancelled before it began." : "The exact desktop target is no longer available.", outcome: result };
      }
      if (currentApp === undefined) {
        const result = outcome("pre_effect_dispatch", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
        return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "not_completed", result), error: "The exact desktop target is no longer available.", outcome: result };
      }
      const postPreflightHumanControl = await this.assertContextHumanControl(context, request.scope);
      if (postPreflightHumanControl !== "current") {
        const result = outcome("pre_effect_dispatch", {
          retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
          ...(postPreflightHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}),
        });
        return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "not_completed", result), error: postPreflightHumanControl === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: result };
      }
      mutationBoundaryCrossed = true;
      const mutation = await this.call(leases, request.scope, "bring_to_front", { pid: provider.pid, window_id: provider.windowId }, request.signal);
      // The supervisor reports a session-stage failure before it has sent the
      // reviewed tool request, and releases any session lease itself. This is
      // not a mutation boundary despite this adapter having attempted to enter
      // one; a tool-stage failure remains conservatively uncertain below.
      if (!mutation.ok && mutation.stage === "session") {
        const result = outcome("pre_effect_dispatch", {
          retrySafety: mutation.code === "cancelled" ? "safe" : "observe_before_retry",
          stateChangeCertainty: "not_changed",
          providerCondition: mutation.code === "cancelled" ? "cancelled" : "unknown",
          targetCondition: "unavailable",
          recovery: mutation.code === "cancelled" ? ["retry_same_request"] : ["observe_again"],
        });
        return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "not_completed", result), error: "Cua could not begin the exact desktop focus.", outcome: result };
      }
      if (mutation.ok && typedFocusRefusal(mutation.result, provider.pid, provider.windowId)) {
        const result = outcome("pre_effect_dispatch", { retrySafety: "never", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
        return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "not_completed", result), error: "Cua refused the exact desktop focus before delivery.", outcome: result };
      }
      const postDispatchHumanControl = await this.assertContextHumanControl(context, request.scope);
      if (postDispatchHumanControl !== "current") {
        this.registry.markUnknownCompletion(context, request.scope);
        const result = outcome("post_effect_verification", {
          retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"],
          ...(postDispatchHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}),
        });
        return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "unknown_completion", result), error: postDispatchHumanControl === "external_interference" ? "Local input interrupted the desktop operation. Observe again; do not replay it." : "Desktop human-input state could not be read. Observe again; do not replay it.", outcome: result };
      }
      let focusVerified = mutation.ok && verifiedExactFocus(mutation.result, provider.pid, provider.windowId);
      let focusReadSuperseded = false;
      if (mutation.ok && !focusVerified && exactFocusedWindowWithFrontmostSurfaceUnverified(mutation.result, provider.pid, provider.windowId)) {
        // Cua's own transparent cursor-overlay NSWindow is a layer-zero
        // surface. It can make the provider's stricter z-order verifier return
        // partial even while that exact app/process/window is focused. Require
        // a second, same-session exact state read and another Human-input fence
        // before accepting the narrower product focus postcondition.
        const state = await this.windowState(leases, request.scope, context, provider.pid, provider.windowId, undefined, undefined, request.signal);
        if (state.ok && state.generation === mutation.generation && state.sessionId === mutation.sessionId) {
          const parsedState = parseWindowState(state.result, { pid: provider.pid, windowId: provider.windowId });
          if (parsedState.kind === "malformed") this.invalidateMalformedProvider();
          if (parsedState.kind === "success" && !parsedState.degraded) {
            const postReadHumanControl = await this.assertContextHumanControl(context, request.scope);
            if (postReadHumanControl !== "current") {
              this.registry.markUnknownCompletion(context, request.scope);
              const result = outcome("post_effect_verification", {
                retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"],
                ...(postReadHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}),
              });
              return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "unknown_completion", result), error: postReadHumanControl === "external_interference" ? "Local input interrupted the desktop operation. Observe again; do not replay it." : "Desktop human-input state could not be read. Observe again; do not replay it.", outcome: result };
            }
            focusVerified = this.registry.isCurrentWindowRead(context, request.scope, state.readTicket).ok;
            focusReadSuperseded = !focusVerified;
          }
        }
      }
      if (request.signal?.aborted || !mutation.ok || !focusVerified) {
        this.registry.markUnknownCompletion(context, request.scope);
        if (mutation.ok && !mutation.result.isError && !focusReadSuperseded) this.invalidateMalformedProvider();
        const result = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "unknown_completion", result), error: "Desktop focus completion is unknown. Observe again; do not replay it.", outcome: result };
      }
      const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: "changed", providerCondition: "ready", targetCondition: "current", recovery: [] });
      return {
        ok: true,
        receipt: {
          version: 1, timing: "immediate", action: "focus",
          target: { version: 1, context, reference }, resolvedTarget: receiptEvidence(target.data.evidence), provider: "cua",
          deliveryMode: target.data.evidence.focused === true ? "foreground" : "foreground_escalated",
          completionCertainty: "completed", verification: "verified", unexecutedRemainder: { count: 0, reason: "none" }, outcome: result,
        },
      };
    } catch (error) {
      const external = error instanceof CuaExternalInterferenceError;
      if (!mutationBoundaryCrossed) {
        const result = outcome("pre_effect_dispatch", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: external ? "unknown" : "unavailable", recovery: ["observe_again"], ...(external ? { externalInterference: "user_input" as const } : {}) });
        return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "not_completed", result), error: external ? "Local input interrupted the desktop operation. Observe again before acting." : "Cua could not preflight the exact desktop target.", outcome: result };
      }
      this.registry.markUnknownCompletion(context, request.scope);
      const result = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"], ...(external ? { externalInterference: "user_input" as const } : {}) });
      return { ok: false, receipt: focusFailureReceipt(request, target.data.evidence, "unknown_completion", result), error: external ? "Local input interrupted the desktop operation. Observe again; do not replay it." : "Desktop focus completion is unknown. Observe again; do not replay it.", outcome: result };
    } finally {
      await this.release(request.scope, leases);
    }
  }

  private async mutateExactWindow(request: CuaWindowMutationRequest, keyboardTool: "press_key" | "hotkey" = "press_key"): Promise<CuaComputerDoResult> {
    const { context, reference } = request.operation.target;
    // The first vertical's AX element capability is single-use.  Retain the
    // established window-scoped text route for historical flows, which have
    // no element authority to claim.
    let resolved = this.registry.resolveTarget(context, request.scope, reference);
    const unavailable: CuaComputerMutationReceipt["resolvedTarget"] = reference.startsWith("detgt_")
      ? { kind: "element", state: "unavailable" }
      : { kind: "window", role: "unavailable" };
    if (!resolved.ok) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", targetCondition: "stale", recovery: ["observe_again"] });
      return { ok: false, receipt: windowMutationFailureReceipt(request, unavailable, "not_completed", result), error: registryError(resolved.code), outcome: result };
    }
    // New collection references select identity; the admitted operation selects
    // semantics. Legacy operation-specific references remain unchanged.
    const bindAction = (data: { evidence: ComputerUseTargetEvidence; providerTarget: ComputerUseProviderTarget }) => {
      if (data.providerTarget.operation !== "element") return data;
      const operation = request.operation.kind;
      return { evidence: { ...data.evidence, action: operation }, providerTarget: { ...data.providerTarget, operation } };
    };
    resolved = { ok: true, data: bindAction(resolved.data) };
    if (request.signal?.aborted) {
      const result = outcome("pre_effect_dispatch", { retrySafety: "safe", stateChangeCertainty: "not_changed", providerCondition: "cancelled", targetCondition: "current", recovery: ["retry_same_request"] });
      return { ok: false, receipt: windowMutationFailureReceipt(request, resolved.data.evidence, "not_completed", result), error: "Desktop input was cancelled before it began.", outcome: result };
    }
    // Fence Human input before consuming a one-shot detgt_.  A takeover must
    // leave the capability intact for a fresh, user-approved observation.
    const entryHumanControl = await this.assertContextHumanControl(context, request.scope);
    if (entryHumanControl !== "current") {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"], ...(entryHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}) });
      return { ok: false, receipt: windowMutationFailureReceipt(request, resolved.data.evidence, "not_completed", result), error: entryHumanControl === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: result };
    }
    let target = resolved;
    let provider = target.data.providerTarget;
    if (provider.provider !== "cua" || provider.pid === undefined || provider.windowId === undefined || provider.app === undefined
      || (request.operation.kind === "type_text"
        ? ((provider.operation !== "type_text" || provider.elementToken === undefined) && provider.operation !== "focus")
        : request.operation.kind === "set_value"
          ? provider.operation !== "set_value" || provider.elementToken === undefined
          : request.operation.kind === "scroll"
            ? provider.operation !== "scroll" || provider.elementToken === undefined
          : request.operation.kind === "click"
            ? (provider.operation !== "click" && provider.operation !== "right_click" && provider.operation !== "double_click") || provider.elementToken === undefined
          : provider.operation !== "focus" && (provider.operation !== "press_key" || provider.elementToken === undefined))) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
      return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result), error: `This target was not selected for ${request.operation.kind}. Observe the window and select a fresh target for the intended action; no input was sent.`, outcome: result };
    }
    const leases: Lease[] = [];
    const requestedCharacters = request.operation.kind === "type_text" ? [...request.operation.text].length : null;
    // The specialized Cua tools encode their button/action in the tool name.
    // Accept matching explicit intent, but do not forward fields absent from
    // those schemas or silently discard a meaningful modifier. In the pinned
    // macOS driver right_click ignores modifiers on its element path, and
    // double_click does not accept them; modified gestures need pixel targeting.
    if (request.operation.kind === "click" && provider.operation !== "click" && (
      (request.operation.button !== undefined && request.operation.button !== (provider.operation === "right_click" ? "right" : "left"))
      || (request.operation.axAction !== undefined && request.operation.axAction !== (provider.operation === "right_click" ? "show_menu" : "open"))
      || (request.operation.modifiers?.length ?? 0) > 0
    )) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
      return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result), error: "The requested options differ from this specialized element gesture. Use a fresh screenshot target for a modified gesture, or select an ordinary click target for another AX action or button.", outcome: result };
    }
    if (request.operation.kind === "type_text" && cuaSanitizedText(request.operation.text) !== request.operation.text) {
      const result = outcome("pre_effect_dispatch", {
        retrySafety: "never", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "current", recovery: [],
      });
      return {
        ok: false,
        receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result),
        error: "Cua would alter this text as a trailing protocol fragment, so Nautilo refused it before delivery.",
        outcome: result,
      };
    }
    let boundaryCrossed = false;
    try {
      const preflight = await this.preflightExactWindow(request.scope, provider, request.signal, leases);
      if (preflight !== "current") {
        const cancelled = preflight === "cancelled";
        const malformed = preflight === "malformed";
        if (malformed) this.invalidateMalformedProvider();
        const result = outcome("pre_effect_dispatch", {
          retrySafety: cancelled ? "safe" : "observe_before_retry", stateChangeCertainty: "not_changed",
          providerCondition: cancelled ? "cancelled" : malformed ? "malformed_response" : preflight === "unavailable" ? "ready" : "unknown",
          targetCondition: malformed || preflight === "session_failed" ? "unknown" : "unavailable",
          recovery: cancelled ? ["retry_same_request"] : ["observe_again"],
        });
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result), error: cancelled ? "Desktop input was cancelled before it began." : "The exact desktop target is no longer available.", outcome: result };
      }
      // list_apps/list_windows are awaited preflight reads. Recheck the
      // persisted host epoch after them and before the detgt_ claim/transport
      // boundary so local input during preflight cannot receive text.
      const postPreflightHumanControl = await this.assertContextHumanControl(context, request.scope);
      if (postPreflightHumanControl !== "current") {
        const result = outcome("pre_effect_dispatch", {
          retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed",
          providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
          ...(postPreflightHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}),
        });
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result), error: postPreflightHumanControl === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: result };
      }
      const name = request.operation.kind;
      const providerName = name === "click" && (provider.operation === "right_click" || provider.operation === "double_click")
        ? provider.operation
        : name === "press_key" ? keyboardTool : name;
      const keyInput = name === "press_key"
        ? normalizeCuaKey(request.operation.key, request.operation.modifiers)
        : null;
      if (name === "press_key" && keyInput === null) {
        const result = outcome("pre_effect_dispatch", { retrySafety: "never", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "current", recovery: [] });
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result), error: "This key or modifier is not in Cua's pinned macOS keyboard contract.", outcome: result };
      }
      const isElementText = name === "type_text" && provider.operation === "type_text";
      const isElementValue = name === "set_value" && provider.operation === "set_value";
      const isElementScroll = name === "scroll" && provider.operation === "scroll";
      const isElementClick = name === "click" && (provider.operation === "click" || provider.operation === "right_click" || provider.operation === "double_click");
      const isElementKey = name === "press_key" && provider.operation === "press_key";
      const isElementMutation = isElementText || isElementValue || isElementScroll || isElementClick || isElementKey;
      // The supervisor awaits this after its session,
      // generation and abort checks, immediately before transport.call.  This
      // is the only point at which detgt_ may be consumed. Only cancellation
      // observed before this supervisor call, or its distinguishable
      // session-stage cancellation, is safely pre-claim; a tool-stage
      // cancellation is ambiguous even when the callback seam was not seen.
      let elementClaimRejected = false;
      let dispatchHuman: "current" | "external_interference" | "unavailable" = "current";
      const claimElementAtProviderDispatch = async (): Promise<boolean> => {
        dispatchHuman = await this.assertContextHumanControl(context, request.scope);
        if (dispatchHuman !== "current") return false;
        if (!isElementMutation) return true;
        const claimed = this.registry.claimElementTarget(context, request.scope, reference);
        if (!claimed.ok) {
          elementClaimRejected = true;
          return false;
        }
        target = { ok: true, data: bindAction(claimed.data) };
        provider = target.data.providerTarget;
        return true;
      };
      let deliveryMode: "background" | "foreground" = "deliveryMode" in request.operation ? request.operation.deliveryMode ?? "background" : "background";
      let escalated = false;
      const baseArgs = name === "type_text"
        ? isElementText
          ? { pid: provider.pid, window_id: provider.windowId, element_token: provider.elementToken!, text: request.operation.text, ...(request.operation.delayMs === undefined ? {} : { delay_ms: request.operation.delayMs }) }
          : { pid: provider.pid, window_id: provider.windowId, scope: "window" as const, text: request.operation.text, ...(request.operation.delayMs === undefined ? {} : { delay_ms: request.operation.delayMs }) }
        : name === "set_value"
          ? { pid: provider.pid, window_id: provider.windowId, element_token: provider.elementToken!, value: request.operation.value }
          : name === "scroll"
            ? {
              pid: provider.pid, window_id: provider.windowId, element_token: provider.elementToken!,
              direction: request.operation.direction, amount: request.operation.amount, by: request.operation.by,
              delivery_mode: deliveryMode,
            }
          : name === "click"
            ? { pid: provider.pid, window_id: provider.windowId, element_token: provider.elementToken!, delivery_mode: deliveryMode,
              ...(providerName !== "click" ? {} : {
                ...(request.operation.axAction === undefined ? {} : { action: request.operation.axAction }),
                ...cuaPixelClickArguments(request.operation),
              }) }
          : { pid: provider.pid, window_id: provider.windowId,
              ...(keyboardTool === "hotkey" ? { keys: [...keyInput!.modifiers, keyInput!.key] } : { key: keyInput!.key, modifiers: [...keyInput!.modifiers] }),
              ...(isElementKey ? { element_token: provider.elementToken! } : { scope: "window" as const }) };
      boundaryCrossed = true;
      let providerResult = await this.call(leases, request.scope, providerName,
        name === "set_value" || name === "scroll" || name === "click" ? baseArgs : { ...baseArgs, delivery_mode: deliveryMode },
        request.signal, claimElementAtProviderDispatch);
      if (!providerResult.ok && dispatchHuman !== "current") {
        const result = outcome("pre_effect_dispatch", {
          retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
          ...(dispatchHuman === "external_interference" ? { externalInterference: "user_input" as const } : {}),
        });
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result),
          error: "Local input authority changed during setup. Observe again before acting.", outcome: result };
      }
      if (!providerResult.ok && providerResult.stage === "session") {
        const result = outcome("pre_effect_dispatch", { retrySafety: providerResult.code === "cancelled" ? "safe" : "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: providerResult.code === "cancelled" ? "cancelled" : "unknown", targetCondition: "unavailable", recovery: providerResult.code === "cancelled" ? ["retry_same_request"] : ["observe_again"] });
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result), error: "Cua could not begin exact desktop input.", outcome: result };
      }
      if (!providerResult.ok && elementClaimRejected) {
        const result = outcome("resolve_target", {
          retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed",
          providerCondition: "ready", targetCondition: "stale", recovery: ["observe_again"],
        });
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result), error: "The one-shot text target is no longer available.", outcome: result };
      }
      if (!providerResult.ok) {
        this.registry.markUnknownCompletion(context, request.scope);
        const result = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: providerResult.code === "cancelled" ? "cancelled" : "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "unknown_completion", result), error: "Desktop input completion is unknown. Observe again; do not replay it.", outcome: result };
      }
      const effectExpectation = { requestedCharacters, pid: provider.pid, windowId: provider.windowId, deliveryMode };
      let effect = name === "set_value"
        ? parseSetValueEffect(providerResult.result, { pid: provider.pid, windowId: provider.windowId })
        : name === "scroll"
          ? parseScrollEffect(providerResult.result, { pid: provider.pid, windowId: provider.windowId, deliveryMode })
        : name === "click"
          ? provider.operation === "right_click" || provider.operation === "double_click"
            ? parseElementSpecializedClickEffect(providerResult.result, { pid: provider.pid, windowId: provider.windowId, deliveryMode })
            : parseElementClickEffect(providerResult.result, { pid: provider.pid, windowId: provider.windowId, deliveryMode })
        : parseTextOrKeyEffect(providerResult.result, effectExpectation, keyboardTool);
      // Specialized clicks may use Cua's pid-routed pointer fallback when the
      // element lacks AXShowMenu/AXOpen. That agent action can advance the
      // host HID epoch, so a post-dispatch sample cannot truthfully
      // distinguish Human input. Its receipt is already unknown/no-replay and
      // the context is fenced below; retain only the pre-dispatch takeover
      // check instead of falsely attributing our own event to the Human.
      const confirmedSelectionPointer = name === "click" && effect.kind === "completed"
        && effect.providerAction.route === "synthetic_events";
      // Background is a delivery mode, not evidence of AX-only input. Cua
      // can post keyboard events to the PID; those events share HIDIdleTime
      // with Human input. Preserve its parsed receipt and fence old actions
      // until a fresh read, just as for foreground input and pointer fallback.
      const synthesizedKeyboard = (name === "type_text" || name === "press_key")
        && (effect.kind === "partial" ? effect.synthesizedInput
          : "providerAction" in effect && effect.providerAction.route === "synthetic_events");
      const postDispatchHumanControl = deliveryMode === "foreground" || provider.operation === "right_click" || provider.operation === "double_click" || confirmedSelectionPointer
        || synthesizedKeyboard
        || (name === "scroll" && effect.kind === "synthetic_unverifiable")
        ? "current"
        : await this.assertContextHumanControl(context, request.scope);
      if (postDispatchHumanControl !== "current") {
        this.registry.markUnknownCompletion(context, request.scope);
        const result = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"], ...(postDispatchHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}) });
        if (name === "scroll" && effect.kind === "unverifiable") {
          return {
            ok: false,
            receipt: {
              version: 1, timing: "immediate", action: "scroll",
              target: { version: 1, context, reference }, resolvedTarget: receiptEvidence(target.data.evidence), provider: "cua",
              deliveryMode: "background", completionCertainty: "unknown_completion", verification: "not_verified",
              providerAction: effect.providerAction, unexecutedRemainder: { count: 1, reason: "unknown_completion" }, outcome: result,
            },
            error: postDispatchHumanControl === "external_interference" ? "Local input interrupted the desktop operation. Observe again; do not replay it." : "Desktop human-input state could not be read. Observe again; do not replay it.", outcome: result,
          };
        }
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "unknown_completion", result), error: postDispatchHumanControl === "external_interference" ? "Local input interrupted the desktop operation. Observe again; do not replay it." : "Desktop human-input state could not be read. Observe again; do not replay it.", outcome: result };
      }
      const canVerifySemanticEffect = effect.kind === "unverifiable"
        && effect.providerAction.escalation === null
        && (name === "set_value" || name === "click" && provider.operation === "click" && provider.semanticRole === "checkbox"
          && (request.operation.axAction === undefined || request.operation.axAction === "press")
          && (request.operation.button === undefined || request.operation.button === "left") && !request.operation.modifiers?.length);
      if (canVerifySemanticEffect) {
        const semanticProviderAction = effect.kind === "unverifiable" ? effect.providerAction : null;
        if (semanticProviderAction === null) throw new Error("semantic verification requires an unverifiable Cua action");
        const postState = await this.windowState(leases, request.scope, context, provider.pid, provider.windowId, undefined, undefined, request.signal);
        const postHumanControl = await this.assertContextHumanControl(context, request.scope);
        if (postHumanControl !== "current") {
          this.registry.markUnknownCompletion(context, request.scope);
          const result = outcome("post_effect_verification", {
            retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: "unknown", targetCondition: "unknown",
            recovery: ["observe_again", "do_not_replay"],
            ...(postHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}),
          });
          return {
            ok: false,
            receipt: {
              version: 1, timing: "immediate", action: name,
              target: { version: 1, context, reference }, resolvedTarget: receiptEvidence(target.data.evidence), provider: "cua",
              deliveryMode: "background", completionCertainty: "unknown_completion", verification: "not_verified",
              providerAction: semanticProviderAction, unexecutedRemainder: { count: 1, reason: "unknown_completion" }, outcome: result,
            },
            error: postHumanControl === "external_interference"
              ? "Local input interrupted semantic verification. Observe again; do not replay the action."
              : "Desktop human-input state could not be read during semantic verification. Observe again; do not replay the action.",
            outcome: result,
          };
        }
        if (postState.ok && (postState.generation !== providerResult.generation || postState.sessionId !== providerResult.sessionId)) {
          this.invalidateMalformedProvider();
          effect = { kind: "malformed" };
        } else if (postState.ok && !request.signal?.aborted && this.registry.isCurrentWindowRead(context, request.scope, postState.readTicket).ok) {
          const parsedPost = parseWindowState(postState.result, { pid: provider.pid, windowId: provider.windowId });
          if (parsedPost.kind === "malformed") {
            this.invalidateMalformedProvider();
            effect = { kind: "malformed" };
          } else if (parsedPost.kind === "success" && !parsedPost.degraded) {
            let verified = false;
            if (name === "set_value" && request.operation.kind === "set_value" && provider.semanticRole !== undefined) {
              const selected = parseNativeElementSelection(postState.result, {
                role: provider.semanticRole,
                ...(provider.semanticLabelEquals === undefined ? {} : { labelEquals: provider.semanticLabelEquals }),
              });
              verified = selected.disposition === "unique" && selected.value === request.operation.value;
            } else if (name === "click" && provider.semanticRole === "checkbox" && provider.observedValue !== undefined) {
              const selected = parseNativeElementSelection(postState.result, {
                role: "checkbox",
                ...(provider.semanticLabelEquals === undefined ? {} : { labelEquals: provider.semanticLabelEquals }),
              });
              verified = selected.disposition === "unique" && selected.observedValue !== undefined
                && selected.observedValue !== provider.observedValue;
            }
            if (verified) effect = { kind: "completed", providerAction: semanticProviderAction };
          }
        }
      }
      if (name === "scroll" && (effect.kind === "synthetic_unverifiable" || effect.kind === "background_refusal")) {
        this.registry.markUnknownCompletion(context, request.scope);
        const result = outcome("post_effect_verification", {
          retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: "ready", targetCondition: "unknown",
          recovery: ["observe_again", "do_not_replay"],
        });
        return {
          ok: false,
          receipt: {
            version: 1, timing: "immediate", action: "scroll",
            target: { version: 1, context, reference }, resolvedTarget: receiptEvidence(target.data.evidence), provider: "cua",
            deliveryMode: effect.kind === "synthetic_unverifiable" ? effect.providerAction.delivery!.mode as "background" | "foreground" : "unknown", completionCertainty: "unknown_completion", verification: "not_verified",
            providerAction: effect.kind === "synthetic_unverifiable" ? effect.providerAction : null,
            unexecutedRemainder: { count: 1, reason: "unknown_completion" }, outcome: result,
          },
          error: "Desktop scroll completion is unknown. Observe again; do not replay it.", outcome: result,
        };
      }
      if (name === "scroll" && effect.kind === "background_unavailable") {
        const result = outcome("pre_effect_dispatch", {
          retrySafety: "never", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "current", recovery: ["observe_again"],
        });
        return {
          ok: false,
          receipt: {
            version: 1, timing: "immediate", action: "scroll",
            target: { version: 1, context, reference }, resolvedTarget: receiptEvidence(target.data.evidence), provider: "cua",
            deliveryMode: "not_delivered", completionCertainty: "not_completed", verification: "unavailable", providerAction: null,
            unexecutedRemainder: { count: 1, reason: "failed" }, outcome: result,
          },
          error: "Cua could not deliver this background scroll. Select the control again and use deliveryMode: foreground, or scroll a fresh screenshot point. Nothing was scrolled.", outcome: result,
        };
      }
      // Only Cua's literal pre-actuator foreground advice can cause the one
      // bounded automatic escalation. Any other error is post-boundary truth.
      if (effect.kind === "refused_foreground" && !isElementMutation) {
        deliveryMode = "foreground";
        escalated = true;
        providerResult = await this.call(leases, request.scope, providerName, { ...baseArgs, delivery_mode: deliveryMode }, request.signal, claimElementAtProviderDispatch);
        if (!providerResult.ok && dispatchHuman !== "current") {
          const result = outcome("pre_effect_dispatch", {
            retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
            ...(dispatchHuman === "external_interference" ? { externalInterference: "user_input" as const } : {}),
          });
          return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result), error: "Local input changed during foreground setup. Observe again before acting. Nothing was typed.", outcome: result };
        }
        if (!providerResult.ok && providerResult.stage === "session") {
          const result = outcome("pre_effect_dispatch", {
            retrySafety: providerResult.code === "cancelled" ? "safe" : "observe_before_retry", stateChangeCertainty: "not_changed",
            providerCondition: providerResult.code === "cancelled" ? "cancelled" : "unknown", targetCondition: "current",
            recovery: providerResult.code === "cancelled" ? ["retry_same_request"] : ["observe_again"],
          });
          return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result), error: "Cua could not begin foreground desktop input after its safe background refusal.", outcome: result };
        }
        if (providerResult.ok) effect = parseTextOrKeyEffect(providerResult.result, { ...effectExpectation, deliveryMode }, keyboardTool);
      }
      // An element is single-use, not background-only. A known refusal permits
      // fresh selection and an explicit foreground request, never token replay.
      if (effect.kind === "refused_foreground" && isElementMutation) {
        const result = outcome("pre_effect_dispatch", {
          retrySafety: "never", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "current", recovery: ["observe_again"],
        });
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result), error: "Cua requires foreground input for this control. Observe and select it again, then use deliveryMode: foreground. Nothing was typed.", outcome: result };
      }
      if (effect.kind === "refused_element_scope") {
        // An app-level inline editor can appear in a window snapshot without
        // Cua being able to prove its AX window ownership. Re-observing that
        // editor does not repair the scope mismatch. Preserve the window and
        // healthy driver for explicit visual recovery; never drop window_id
        // or retry the semantic write automatically.
        const result = outcome("pre_effect_dispatch", {
          retrySafety: "never", stateChangeCertainty: "not_changed",
          providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"],
        });
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result),
          error: "Cua could not establish this control's window ownership. Use a fresh screenshot to address the visible control instead of repeating the semantic write. Nothing was written.", outcome: result };
      }
      if (effect.kind === "refused_element") {
        if (name === "scroll") {
          const result = outcome("resolve_target", {
            retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "stale", recovery: ["observe_again"],
          });
          return {
            ok: false,
            receipt: {
              version: 1, timing: "immediate", action: "scroll",
              target: { version: 1, context, reference }, resolvedTarget: { kind: "element", state: "unavailable" }, provider: "cua",
              deliveryMode: "not_delivered", completionCertainty: "not_completed", verification: "unavailable", providerAction: null,
              unexecutedRemainder: { count: 1, reason: "failed" }, outcome: result,
            },
            error: "Cua refused this one-shot semantic control before delivery. Observe again and select a current control.", outcome: result,
          };
        }
        const result = outcome("pre_effect_dispatch", {
          retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed",
          providerCondition: "ready", targetCondition: "stale",
          recovery: ["observe_again"],
        });
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result), error: "Cua refused this semantic control before delivery. Observe again and select a current control.", outcome: result };
      }
      if (!providerResult.ok) {
        this.registry.markUnknownCompletion(context, request.scope);
        const result = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: providerResult.code === "cancelled" ? "cancelled" : "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "unknown_completion", result), error: "Desktop input completion is unknown. Observe again; do not replay it.", outcome: result };
      }
      if (effect.kind === "refused" || effect.kind === "refused_foreground") {
        const stale = effect.code === "window_not_found" || effect.code === "owner_pid_mismatch";
        const result = outcome("pre_effect_dispatch", {
          retrySafety: "never", stateChangeCertainty: "not_changed", providerCondition: "ready",
          targetCondition: stale ? "stale" : effect.code === "minimized_or_hidden_window" ? "unavailable" : "current",
          recovery: effect.kind === "refused" && (effect.advice === "get_window_state" || stale) ? ["observe_again"] : [],
        });
        const error = effect.kind === "refused" && effect.advice === "accessibility"
          ? "Cua refused this exact desktop input before delivery. Restore Accessibility access before trying a new request."
          : effect.kind === "refused" && effect.advice === "get_window_state"
            ? "Cua refused this stale exact window before delivery. Observe again and choose a current target."
            : "Cua refused this exact desktop input before delivery; the same request must not be replayed unchanged.";
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "not_completed", result), error, outcome: result };
      }
      if (effect.kind === "chunk_refusal") {
        const result = outcome("pre_effect_dispatch", { retrySafety: "never", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "current", recovery: [] });
        return {
          ok: false,
          receipt: {
            version: 1, timing: "immediate", action: "type_text",
            target: { version: 1, context, reference }, resolvedTarget: receiptEvidence(target.data.evidence), provider: "cua",
            deliveryMode: "not_delivered", completionCertainty: "not_completed", verification: "unavailable",
            textDelivery: { requestedCharacters: requestedCharacters!, deliveredCharacters: 0, maxChunkCharacters: effect.maxChunkCharacters }, providerAction: null,
            unexecutedRemainder: { count: requestedCharacters!, reason: "failed" }, outcome: result,
          },
          error: `Cua refused text synthesis before delivery. Submit separate text chunks of at most ${effect.maxChunkCharacters} characters.`, outcome: result,
        };
      }
      if (effect.kind === "partial") {
        if (synthesizedKeyboard) this.registry.retireMutationCapabilities(context, request.scope);
        const result = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "changed", providerCondition: "ready", targetCondition: "current", recovery: ["observe_again"] });
        return {
          ok: false,
          receipt: {
            version: 1, timing: "immediate", action: name,
            target: { version: 1, context, reference }, resolvedTarget: receiptEvidence(target.data.evidence), provider: "cua",
            deliveryMode: effect.delivery, completionCertainty: "partially_completed", verification: "not_verified",
            textDelivery: { requestedCharacters: requestedCharacters!, deliveredCharacters: effect.delivered }, providerAction: null,
            unexecutedRemainder: { count: requestedCharacters! - effect.delivered, reason: "failed" }, outcome: result,
          },
          error: "Cua inserted only a prefix. Observe the target before supplying only its remaining suffix.", outcome: result,
        };
      }
      if (effect.kind === "unverifiable" || effect.kind === "suspected_noop") {
        // The call settled, but its semantic effect needs observation. Consume
        // stale actions while retaining the exact identity needed for recovery.
        this.registry.retireMutationCapabilities(context, request.scope);
        const result = outcome("post_effect_verification", {
          retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: "ready", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"],
        });
        return {
          ok: false,
          receipt: {
            version: 1, timing: "immediate", action: name,
            target: { version: 1, context, reference }, resolvedTarget: receiptEvidence(target.data.evidence), provider: "cua",
            deliveryMode: effect.providerAction.delivery?.mode === "foreground" ? (escalated ? "foreground_escalated" : "foreground")
              : effect.providerAction.delivery?.mode === "background" ? "background"
                : effect.providerAction.delivery?.mode === "not_applicable" ? "not_applicable" : "unknown",
            completionCertainty: "unknown_completion", verification: "not_verified",
            ...(name === "type_text" ? { textDelivery: { requestedCharacters: requestedCharacters!, deliveredCharacters: null } } : {}),
            providerAction: effect.providerAction,
            unexecutedRemainder: { count: name === "type_text" ? requestedCharacters! : 1, reason: "unknown_completion" }, outcome: result,
          },
          error: "Desktop input completion is unknown. Observe again; do not replay it.", outcome: result,
        };
      }
      if (effect.kind === "malformed") {
        this.registry.markUnknownCompletion(context, request.scope);
        this.invalidateMalformedProvider();
        const result = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: "malformed_response", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        const diagnostic = actionResultShapeDiagnostic(providerResult.result);
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "unknown_completion", result), error: `Cua desktop input response was incompatible (${diagnostic}). Observe again; do not replay it.`, outcome: result };
      }
      if (effect.kind === "indeterminate" || effect.kind === "provider_failure" || request.signal?.aborted) {
        this.registry.markUnknownCompletion(context, request.scope);
        const result = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: request.signal?.aborted ? "cancelled" : "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "unknown_completion", result), error: "Desktop input completion is unknown. Observe again; do not replay it.", outcome: result };
      }
      if (!("providerAction" in effect)) {
        this.registry.markUnknownCompletion(context, request.scope);
        const result = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, "unknown_completion", result), error: "Desktop input completion is unknown. Observe again; do not replay it.", outcome: result };
      }
      if (effect.providerAction.delivery?.mode === "foreground") {
        // Global HID necessarily advances the same host signal used for Human
        // takeover. The settled, confirmed action consumes old input authority,
        // not the exact app/window identity needed to observe its result. A
        // fresh read establishes and checks a new epoch before minting targets;
        // it neither replays this action nor reuses pre-input capabilities.
        this.registry.retireMutationCapabilities(context, request.scope);
        const result = outcome("post_effect_verification", {
          retrySafety: "never", stateChangeCertainty: "changed", providerCondition: "ready", targetCondition: "unknown",
          recovery: ["observe_again", "do_not_replay"],
        });
        return {
          ok: false,
          receipt: {
            version: 1, timing: "immediate", action: name,
            target: { version: 1, context, reference }, resolvedTarget: receiptEvidence(target.data.evidence), provider: "cua",
            deliveryMode: "foreground_escalated",
            completionCertainty: "completed", verification: "verified",
            ...(name === "type_text" ? {
              textDelivery: {
                requestedCharacters: requestedCharacters!,
                deliveredCharacters: effect.providerAction.delivery.deliveredCount ?? null,
              },
            } : {}),
            providerAction: effect.providerAction,
            unexecutedRemainder: { count: 0, reason: "none" }, outcome: result,
          },
          error: "Desktop foreground input completed, but its resulting desktop state requires a fresh observation. Do not replay it.",
          outcome: result,
        };
      }
      // Token-addressed selection and background keyboard synthesis can both
      // advance HID. Keep verified effects, but reacquire state instead of
      // attributing that epoch to the Human or reusing pre-gesture targets.
      const requiresFreshRead = confirmedSelectionPointer || synthesizedKeyboard;
      if (requiresFreshRead) this.registry.retireMutationCapabilities(context, request.scope);
      const postconditionOnly = name === "set_value" || name === "click" && effect.providerAction.effect === "confirmed";
      const result = outcome("post_effect_verification", {
        // Readback proves the requested value/selection, not a before/after
        // transition: the control may already have held that value.
        retrySafety: "never", stateChangeCertainty: postconditionOnly ? "unknown" : "changed", providerCondition: "ready",
        targetCondition: requiresFreshRead ? "unknown" : "current",
        recovery: requiresFreshRead ? ["observe_again", "do_not_replay"]
          : postconditionOnly ? ["do_not_replay"] : [],
      });
      return {
        ok: true,
        receipt: {
          version: 1, timing: "immediate", action: name,
          target: { version: 1, context, reference }, resolvedTarget: receiptEvidence(target.data.evidence), provider: "cua",
          // The foreground branch above returns after fencing its context.
          deliveryMode: effect.providerAction.delivery?.mode === "background" ? "background" : "unknown",
          completionCertainty: "completed", verification: "verified",
          ...(name === "type_text" ? {
            textDelivery: {
              requestedCharacters: requestedCharacters!,
              deliveredCharacters: effect.providerAction.delivery?.deliveredCount ?? null,
            },
          } : {}),
          providerAction: effect.providerAction,
          unexecutedRemainder: { count: 0, reason: "none" }, outcome: result,
        },
      };
    } catch {
      const result = outcome(boundaryCrossed ? "post_effect_verification" : "pre_effect_dispatch", {
        retrySafety: "observe_before_retry", stateChangeCertainty: boundaryCrossed ? "unknown" : "not_changed", providerCondition: "unknown",
        targetCondition: boundaryCrossed ? "unknown" : "unavailable", recovery: boundaryCrossed ? ["observe_again", "do_not_replay"] : ["observe_again"],
      });
      if (boundaryCrossed) this.registry.markUnknownCompletion(context, request.scope);
      return { ok: false, receipt: windowMutationFailureReceipt(request, target.data.evidence, boundaryCrossed ? "unknown_completion" : "not_completed", result), error: boundaryCrossed ? "Desktop input completion is unknown. Observe again; do not replay it." : "Cua could not preflight the exact desktop target.", outcome: result };
    } finally {
      await this.release(request.scope, leases);
    }
  }

  /** Window pixels focus first; explicit desktop input uses current focus. */
  private async mutateSnapshotInput(
    request: CuaComputerDoCoordinateTypeTextRequest | CuaComputerDoCoordinatePressKeyRequest
      | CuaComputerDoDesktopTypeTextRequest | CuaComputerDoDesktopPressKeyRequest | CuaComputerDoMovePointerRequest,
    keyboardTool: "press_key" | "hotkey" = "press_key",
  ): Promise<CuaComputerDoResult> {
    const { context, reference } = request.operation.target;
    const name = request.operation.kind;
    const requestedCharacters = name === "type_text" ? [...request.operation.text].length : null;
    const unavailable: ComputerUseTargetEvidence = { kind: "screen", role: "unavailable" };
    const failure = (
      certainty: "not_completed" | "unknown_completion",
      result: ComputerUseOperationOutcome,
      evidence: ComputerUseTargetEvidence = unavailable,
      providerAction: CuaComputerMutationReceipt["providerAction"] = null,
      deliveryMode: CuaComputerMutationReceipt["deliveryMode"] = certainty === "not_completed" ? "not_delivered" : "unknown",
    ): CuaComputerMutationReceipt => ({
      version: 1, timing: "immediate", action: name,
      target: { version: 1, context, reference }, resolvedTarget: evidence, provider: "cua",
      deliveryMode, completionCertainty: certainty,
      verification: certainty === "not_completed" ? "unavailable" : "not_verified",
      ...(name === "type_text" ? { textDelivery: { requestedCharacters: requestedCharacters!, deliveredCharacters: certainty === "not_completed" ? 0 : null } } : {}),
      providerAction,
      unexecutedRemainder: { count: name === "type_text" ? requestedCharacters! : 1, reason: certainty === "not_completed" ? "failed" : "unknown_completion" },
      outcome: result,
    });
    const snapshot = this.registry.resolveScreenSnapshot(context, request.scope, reference);
    if (!snapshot.ok) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", targetCondition: "stale", recovery: ["observe_again"] });
      return { ok: false, receipt: failure("not_completed", result), error: registryError(snapshot.code), outcome: result };
    }
    const { metadata, providerSnapshot } = snapshot.data;
    const frame = windowSnapshotFrame(metadata, providerSnapshot);
    const desktop = "scope" in request.operation && request.operation.scope === "desktop";
    const desktopDimensions = providerSnapshot.kind === "desktop" && "display" in metadata ? metadata.presentedDimensions : null;
    const desktopNativeDimensions = providerSnapshot.kind === "desktop" ? { width: providerSnapshot.nativeWidth, height: providerSnapshot.nativeHeight } : null;
    const dimensions = desktop ? desktopDimensions : frame;
    const evidence: ComputerUseTargetEvidence = dimensions === null
      ? unavailable
      : { kind: "screen", bounds: { x: 0, y: 0, width: dimensions.width, height: dimensions.height } };
    const point = frame !== null && "coordinateSpace" in request.operation ? windowPoint(frame, request.operation.x, request.operation.y) : null;
    if (desktop ? desktopDimensions === null
      : frame === null || point === null || !("coordinateSpace" in request.operation) || request.operation.coordinateSpace !== frame.coordinateSpace) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
      return { ok: false, receipt: failure("not_completed", result, evidence), error: desktop ? "Desktop input requires a fresh desktop snapshot." : "The input point is outside this exact window screenshot.", outcome: result };
    }
    if (name === "move_pointer" && (request.operation.coordinateSpace !== "presented_snapshot_pixels"
      || !Number.isFinite(request.operation.x) || request.operation.x < 0 || request.operation.x >= desktopDimensions!.width
      || !Number.isFinite(request.operation.y) || request.operation.y < 0 || request.operation.y >= desktopDimensions!.height)) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
      return { ok: false, receipt: failure("not_completed", result, evidence), error: "The pointer point is outside this exact desktop screenshot.", outcome: result };
    }
    if (name === "type_text" && cuaSanitizedText(request.operation.text) !== request.operation.text) {
      const result = outcome("pre_effect_dispatch", { retrySafety: "never", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "current", recovery: [] });
      return { ok: false, receipt: failure("not_completed", result, evidence), error: "Cua would alter this text as a trailing protocol fragment, so Nautilo refused it before delivery.", outcome: result };
    }
    const keyInput = name === "press_key" ? normalizeCuaKey(request.operation.key, request.operation.modifiers) : null;
    if (name === "press_key" && keyInput === null) {
      const result = outcome("pre_effect_dispatch", { retrySafety: "never", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "current", recovery: [] });
      return { ok: false, receipt: failure("not_completed", result, evidence), error: "This key or modifier is not in Cua's pinned macOS keyboard contract.", outcome: result };
    }
    if (request.signal?.aborted) {
      const result = outcome("pre_effect_dispatch", { retrySafety: "safe", stateChangeCertainty: "not_changed", providerCondition: "cancelled", targetCondition: "current", recovery: ["retry_same_request"] });
      return { ok: false, receipt: failure("not_completed", result, evidence), error: "Desktop input was cancelled before it began.", outcome: result };
    }
    const entryHumanControl = await this.assertContextHumanControl(context, request.scope);
    if (entryHumanControl !== "current") {
      const result = outcome("pre_effect_dispatch", {
        retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
        ...(entryHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}),
      });
      return { ok: false, receipt: failure("not_completed", result, evidence), error: entryHumanControl === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: result };
    }
    let crossed = false;
    let settled = false;
    let dispatchHuman: "current" | "external_interference" | "unavailable" | null = null;
    const leases: Lease[] = [];
    try {
      const deliveryMode = desktop ? "not_applicable" : "deliveryMode" in request.operation ? request.operation.deliveryMode ?? "background" : "background";
      const destination = desktop ? { scope: "desktop" } : { pid: frame!.pid, window_id: frame!.windowId, x: point!.x, y: point!.y, delivery_mode: deliveryMode };
      const args = name === "type_text"
        ? { ...destination, text: request.operation.text, ...(request.operation.delayMs === undefined ? {} : { delay_ms: request.operation.delayMs }) }
        : name === "press_key" ? { ...destination,
          ...(keyboardTool === "hotkey" ? { keys: [...keyInput!.modifiers, keyInput!.key] } : { key: keyInput!.key, modifiers: [...keyInput!.modifiers] }) }
        : { scope: "desktop", x: request.operation.x * desktopNativeDimensions!.width / desktopDimensions!.width,
          y: request.operation.y * desktopNativeDimensions!.height / desktopDimensions!.height };
      const dispatched = await this.call(leases, request.scope, name === "move_pointer" ? "move_cursor" : name === "press_key" ? keyboardTool : name, args, request.signal, async () => {
        dispatchHuman = await this.assertContextHumanControl(context, request.scope);
        if (dispatchHuman !== "current") return false;
        const claimed = this.registry.claimSnapshotMutation(context, request.scope);
        crossed = claimed.ok;
        return crossed;
      });
      if (!dispatched.ok) {
        if (!crossed && dispatchHuman !== null && dispatchHuman !== "current") {
          const result = outcome("pre_effect_dispatch", {
            retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
            ...(dispatchHuman === "external_interference" ? { externalInterference: "user_input" as const } : {}),
          });
          return { ok: false, receipt: failure("not_completed", result, evidence), error: dispatchHuman === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: result };
        }
        const pre = !crossed && dispatched.stage === "session";
        const result = outcome(pre ? "pre_effect_dispatch" : "post_effect_verification", {
          retrySafety: pre && dispatched.code === "cancelled" ? "safe" : pre ? "observe_before_retry" : "never",
          stateChangeCertainty: pre ? "not_changed" : "unknown",
          providerCondition: dispatched.code === "cancelled" ? "cancelled" : "unknown",
          targetCondition: pre ? "current" : "unknown",
          recovery: pre && dispatched.code === "cancelled" ? ["retry_same_request"] : pre ? ["observe_again"] : ["observe_again", "do_not_replay"],
        });
        return { ok: false, receipt: failure(pre ? "not_completed" : "unknown_completion", result, evidence), error: pre ? "Cua could not begin exact screenshot input." : "Desktop input completion is unknown. Observe again; do not replay it.", outcome: result };
      }
      const effect = name === "move_pointer" ? parseDesktopPointerEffect(dispatched.result) : parseTextOrKeyEffect(dispatched.result, {
        requestedCharacters,
        ...(deliveryMode === "not_applicable" ? { deliveryMode } : { pid: frame!.pid, windowId: frame!.windowId, deliveryMode }),
      }, keyboardTool);
      settled = effect.kind !== "malformed" && effect.kind !== "indeterminate" && effect.kind !== "provider_failure";
      if (effect.kind === "completed" || name === "move_pointer" && effect.kind === "unverifiable") {
        const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: effect.kind === "completed" ? "changed" : "unknown", providerCondition: "ready", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        return {
          ok: true,
          receipt: {
            version: 1, timing: "immediate", action: name,
            target: { version: 1, context, reference }, resolvedTarget: evidence, provider: "cua",
            deliveryMode, completionCertainty: "completed", verification: effect.kind === "completed" ? "verified" : "not_verified",
            ...(name === "type_text" ? { textDelivery: { requestedCharacters: requestedCharacters!, deliveredCharacters: effect.providerAction.delivery?.deliveredCount ?? null } } : {}),
            providerAction: effect.providerAction,
            unexecutedRemainder: { count: 0, reason: "none" }, outcome: result,
          },
        };
      }
      if (effect.kind === "chunk_refusal") {
        // Match the window route and the public chunk-refusal receipt: the
        // returned maxChunkCharacters describes a new, smaller request, not
        // permission to retry this undelivered full payload unchanged.
        const result = outcome("pre_effect_dispatch", { retrySafety: "never", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "current", recovery: [] });
        return {
          ok: false,
          receipt: {
            ...failure("not_completed", result, evidence),
            textDelivery: { requestedCharacters: requestedCharacters!, deliveredCharacters: 0, maxChunkCharacters: effect.maxChunkCharacters },
          },
          error: `Cua refused text synthesis before delivery. Submit separate text chunks of at most ${effect.maxChunkCharacters} characters after observing again.`, outcome: result,
        };
      }
      if (effect.kind === "partial") {
        const result = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "changed", providerCondition: "ready", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        return {
          ok: false,
          receipt: {
            version: 1, timing: "immediate", action: name,
            target: { version: 1, context, reference }, resolvedTarget: evidence, provider: "cua",
            deliveryMode: effect.delivery, completionCertainty: "partially_completed", verification: "not_verified",
            textDelivery: { requestedCharacters: requestedCharacters!, deliveredCharacters: effect.delivered }, providerAction: null,
            unexecutedRemainder: { count: requestedCharacters! - effect.delivered, reason: "failed" }, outcome: result,
          },
          error: "Cua inserted only a prefix. Observe the target before supplying only its remaining suffix.", outcome: result,
        };
      }
      if (effect.kind === "refused" || effect.kind === "refused_foreground" || effect.kind === "refused_element") {
        const result = outcome("pre_effect_dispatch", { retrySafety: "never", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
        return { ok: false, receipt: failure("not_completed", result, evidence), error: "Cua refused this exact screenshot input before delivery. Observe again before acting.", outcome: result };
      }
      if (effect.kind === "malformed") this.invalidateMalformedProvider();
      const result = outcome("post_effect_verification", {
        retrySafety: "observe_before_retry", stateChangeCertainty: "unknown",
        providerCondition: effect.kind === "malformed" ? "malformed_response" : effect.kind === "unverifiable" ? "ready" : "unknown",
        targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"],
      });
      return {
        ok: false,
        receipt: failure("unknown_completion", result, evidence, effect.kind === "unverifiable" ? effect.providerAction : null, effect.kind === "unverifiable" ? deliveryMode : "unknown"),
        error: effect.kind === "malformed" ? "Cua screenshot-input output did not match the pinned contract. Observe again; do not replay it." : "Desktop input completion is unknown. Observe again; do not replay it.",
        outcome: result,
      };
    } finally {
      if (crossed) {
        if (settled) this.registry.settleSnapshotMutation(context, request.scope);
        else this.registry.markUnknownCompletion(context, request.scope);
      }
      await this.release(request.scope, leases);
    }
  }

  async typeText(request: CuaComputerDoTypeTextRequest): Promise<CuaComputerDoResult> {
    return "coordinateSpace" in request.operation || "scope" in request.operation
      ? this.mutateSnapshotInput(request as CuaComputerDoCoordinateTypeTextRequest | CuaComputerDoDesktopTypeTextRequest)
      : this.mutateExactWindow(request as CuaComputerDoSemanticTypeTextRequest);
  }

  async movePointer(request: CuaComputerDoMovePointerRequest): Promise<CuaComputerDoResult> {
    return this.mutateSnapshotInput(request);
  }

  async setValue(request: CuaComputerDoSetValueRequest): Promise<CuaComputerDoResult> {
    return this.mutateExactWindow(request);
  }

  async scroll(request: CuaComputerDoScrollRequest): Promise<CuaComputerDoResult> {
    if (!("coordinateSpace" in request.operation)) {
      return this.mutateExactWindow(request as CuaComputerDoElementScrollRequest);
    }
    const { context, reference } = request.operation.target;
    const unavailable: ComputerUseTargetEvidence = { kind: "screen", role: "unavailable" };
    const failure = (
      certainty: "not_completed" | "unknown_completion",
      result: ComputerUseOperationOutcome,
      evidence: ComputerUseTargetEvidence = unavailable,
      providerAction: CuaComputerMutationReceipt["providerAction"] = null,
      deliveryMode: CuaComputerMutationReceipt["deliveryMode"] = certainty === "not_completed" ? "not_delivered" : "unknown",
    ): CuaComputerMutationReceipt => ({
      version: 1, timing: "immediate", action: "scroll",
      target: { version: 1, context, reference }, resolvedTarget: evidence, provider: "cua",
      deliveryMode, completionCertainty: certainty,
      verification: certainty === "not_completed" ? "unavailable" : "not_verified",
      providerAction,
      unexecutedRemainder: { count: 1, reason: certainty === "not_completed" ? "failed" : "unknown_completion" },
      outcome: result,
    });
    const snapshot = this.registry.resolveScreenSnapshot(context, request.scope, reference);
    if (!snapshot.ok) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", targetCondition: "stale", recovery: ["observe_again"] });
      return { ok: false, receipt: failure("not_completed", result), error: registryError(snapshot.code), outcome: result };
    }
    const { metadata, providerSnapshot } = snapshot.data;
    const frame = windowSnapshotFrame(metadata, providerSnapshot);
    const desktop = providerSnapshot.kind === "desktop" && "display" in metadata;
    const dimensions = desktop ? metadata.presentedDimensions : frame === null ? null : { width: frame.width, height: frame.height };
    const evidence: ComputerUseTargetEvidence = dimensions === null
      ? unavailable
      : { kind: "screen", bounds: { x: 0, y: 0, width: dimensions.width, height: dimensions.height } };
    const point = desktop && providerSnapshot.kind === "desktop" && dimensions !== null
      && Number.isFinite(request.operation.x) && request.operation.x >= 0 && request.operation.x < dimensions.width
      && Number.isFinite(request.operation.y) && request.operation.y >= 0 && request.operation.y < dimensions.height
      ? { x: request.operation.x * providerSnapshot.nativeWidth / dimensions.width, y: request.operation.y * providerSnapshot.nativeHeight / dimensions.height }
      : frame === null ? null : windowPoint(frame, request.operation.x, request.operation.y);
    if (point === null || request.operation.coordinateSpace !== (desktop ? "presented_snapshot_pixels" : frame?.coordinateSpace)) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
      return { ok: false, receipt: failure("not_completed", result, evidence), error: "The scroll point is outside this exact screenshot.", outcome: result };
    }
    if (desktop && request.operation.deliveryMode === "background") {
      const result = outcome("pre_effect_dispatch", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "current", recovery: ["observe_again"] });
      return { ok: false, receipt: failure("not_completed", result, evidence), error: "Desktop scrolling is foreground input. Use foreground delivery against a fresh desktop snapshot. Nothing was scrolled.", outcome: result };
    }
    if (request.signal?.aborted) {
      const result = outcome("pre_effect_dispatch", { retrySafety: "safe", stateChangeCertainty: "not_changed", providerCondition: "cancelled", targetCondition: "current", recovery: ["retry_same_request"] });
      return { ok: false, receipt: failure("not_completed", result, evidence), error: "Desktop scroll was cancelled before it began.", outcome: result };
    }
    const entryHumanControl = await this.assertContextHumanControl(context, request.scope);
    if (entryHumanControl !== "current") {
      const result = outcome("pre_effect_dispatch", {
        retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
        ...(entryHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}),
      });
      return { ok: false, receipt: failure("not_completed", result, evidence), error: entryHumanControl === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: result };
    }
    let crossed = false;
    let settled = false;
    let dispatchHuman: "current" | "external_interference" | "unavailable" | null = null;
    const leases: Lease[] = [];
    try {
      const deliveryMode = request.operation.deliveryMode ?? "background";
      const scrolled = await this.call(leases, request.scope, "scroll", {
        ...(desktop ? { scope: "desktop" } : { pid: frame!.pid, window_id: frame!.windowId, delivery_mode: deliveryMode }),
        x: point.x, y: point.y,
        direction: request.operation.direction, amount: request.operation.amount, by: request.operation.by,
      }, request.signal, async () => {
        dispatchHuman = await this.assertContextHumanControl(context, request.scope);
        if (dispatchHuman !== "current") return false;
        const claimed = this.registry.claimSnapshotMutation(context, request.scope);
        crossed = claimed.ok;
        return crossed;
      });
      if (!scrolled.ok) {
        if (!crossed && dispatchHuman !== null && dispatchHuman !== "current") {
          const result = outcome("pre_effect_dispatch", {
            retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
            ...(dispatchHuman === "external_interference" ? { externalInterference: "user_input" as const } : {}),
          });
          return { ok: false, receipt: failure("not_completed", result, evidence), error: dispatchHuman === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: result };
        }
        const pre = !crossed && scrolled.stage === "session";
        const result = outcome(pre ? "pre_effect_dispatch" : "post_effect_verification", {
          retrySafety: pre && scrolled.code === "cancelled" ? "safe" : pre ? "observe_before_retry" : "never",
          stateChangeCertainty: pre ? "not_changed" : "unknown",
          providerCondition: scrolled.code === "cancelled" ? "cancelled" : "unknown",
          targetCondition: pre ? "current" : "unknown",
          recovery: pre && scrolled.code === "cancelled" ? ["retry_same_request"] : pre ? ["observe_again"] : ["observe_again", "do_not_replay"],
        });
        return { ok: false, receipt: failure(pre ? "not_completed" : "unknown_completion", result, evidence), error: pre ? "Cua could not begin the exact window scroll." : "Window scroll completion is unknown. Observe again; do not replay it.", outcome: result };
      }
      const effect = parseScrollEffect(scrolled.result, { ...(frame === null ? {} : { pid: frame.pid, windowId: frame.windowId }), deliveryMode, desktop });
      settled = effect.kind === "background_unavailable" || effect.kind === "background_refusal" || effect.kind === "synthetic_unverifiable";
      if (effect.kind === "background_unavailable" || effect.kind === "background_refusal") {
        const result = outcome("pre_effect_dispatch", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
        return { ok: false, receipt: failure("not_completed", result, evidence), error: "Cua refused this window scroll before delivery. Observe again and use deliveryMode: foreground when background input is unavailable.", outcome: result };
      }
      if (effect.kind === "synthetic_unverifiable") {
        const result = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: "ready", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        return { ok: false, receipt: failure("unknown_completion", result, evidence, effect.providerAction, effect.providerAction.delivery!.mode as "background" | "foreground" | "not_applicable"), error: "Scroll was delivered without a semantic readback. Observe its effect before continuing; do not replay it.", outcome: result };
      }
      if (effect.kind === "malformed" || effect.kind === "unverifiable" || effect.kind === "refused_element") {
        this.invalidateMalformedProvider();
        const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: "unknown", providerCondition: "malformed_response", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        return { ok: false, receipt: failure("unknown_completion", result, evidence), error: "Cua window-scroll output did not match the pinned contract. Observe again; do not replay it.", outcome: result };
      }
      const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: "unknown", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
      return { ok: false, receipt: failure("unknown_completion", result, evidence), error: "Window scroll completion is unknown. Observe again; do not replay it.", outcome: result };
    } finally {
      if (crossed) {
        if (settled) this.registry.settleSnapshotMutation(context, request.scope);
        else this.registry.markUnknownCompletion(context, request.scope);
      }
      await this.release(request.scope, leases);
    }
  }

  async pressKey(request: CuaComputerDoPressKeyRequest): Promise<CuaComputerDoResult> {
    return "coordinateSpace" in request.operation || "scope" in request.operation
      ? this.mutateSnapshotInput(request as CuaComputerDoCoordinatePressKeyRequest | CuaComputerDoDesktopPressKeyRequest)
      : this.mutateExactWindow(request as CuaComputerDoSemanticPressKeyRequest);
  }

  /** Cua's dedicated chord route, sharing exact target/lease/takeover handling with keys. */
  async hotkey(request: CuaComputerDoHotkeyRequest): Promise<CuaComputerDoResult> {
    const { keys, ...destination } = request.operation;
    // Invalid direct callers follow the existing pre-dispatch key refusal;
    // public contract validation rejects them earlier. Never drop a base key.
    const chord = normalizeCuaMacosHotkey(keys) ?? { key: "", modifiers: [] };
    const normalized = { ...request, operation: { ...destination, kind: "press_key" as const, ...chord } };
    const result = "coordinateSpace" in normalized.operation || "scope" in normalized.operation
      ? await this.mutateSnapshotInput(normalized as CuaComputerDoCoordinatePressKeyRequest | CuaComputerDoDesktopPressKeyRequest, "hotkey")
      : await this.mutateExactWindow(normalized as CuaComputerDoSemanticPressKeyRequest, "hotkey");
    return { ...result, receipt: { ...result.receipt, action: "hotkey" } };
  }

  /** Invoke one exact native menu path once; semantic completion requires a fresh observation. */
  async invokeMenu(request: CuaComputerDoInvokeMenuRequest): Promise<CuaComputerDoResult> {
    const { context, reference } = request.operation.target;
    const target = this.registry.resolveTarget(context, request.scope, reference);
    const unavailable: CuaComputerMutationReceipt["resolvedTarget"] = { kind: "window", role: "unavailable" };
    const receipt = (
      certainty: "not_completed" | "unknown_completion",
      result: ComputerUseOperationOutcome,
      providerAction: CuaComputerMutationReceipt["providerAction"] = null,
      deliveryMode: CuaComputerMutationReceipt["deliveryMode"] = certainty === "not_completed" ? "not_delivered" : "unknown",
    ): CuaComputerMutationReceipt => ({
      version: 1, timing: "immediate", action: "invoke_menu",
      target: { version: 1, context, reference }, resolvedTarget: target.ok ? receiptEvidence(target.data.evidence) : unavailable,
      provider: "cua", deliveryMode, completionCertainty: certainty,
      verification: certainty === "not_completed" ? "unavailable" : "not_verified", providerAction,
      unexecutedRemainder: { count: 1, reason: certainty === "not_completed" ? "failed" : "unknown_completion" }, outcome: result,
    });
    if (!target.ok) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", targetCondition: "stale", recovery: ["observe_again"] });
      return { ok: false, receipt: receipt("not_completed", result), error: registryError(target.code), outcome: result };
    }
    const provider = target.data.providerTarget;
    if (provider.provider !== "cua" || provider.operation !== "focus" || provider.pid === undefined || provider.windowId === undefined || provider.app === undefined) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
      return { ok: false, receipt: receipt("not_completed", result), error: "This target does not authorize an exact native menu command.", outcome: result };
    }
    if (request.signal?.aborted) {
      const result = outcome("pre_effect_dispatch", { retrySafety: "safe", stateChangeCertainty: "not_changed", providerCondition: "cancelled", targetCondition: "current", recovery: ["retry_same_request"] });
      return { ok: false, receipt: receipt("not_completed", result), error: "Desktop menu invocation was cancelled before it began.", outcome: result };
    }
    const leases: Lease[] = [];
    let boundaryCrossed = false;
    try {
      const preflight = await this.preflightExactWindow(request.scope, provider, request.signal, leases);
      if (preflight !== "current") {
        const malformed = preflight === "malformed";
        if (malformed) this.invalidateMalformedProvider();
        const cancelled = preflight === "cancelled";
        const result = outcome("pre_effect_dispatch", {
          retrySafety: cancelled ? "safe" : "observe_before_retry", stateChangeCertainty: "not_changed",
          providerCondition: cancelled ? "cancelled" : malformed ? "malformed_response" : preflight === "unavailable" ? "ready" : "unknown",
          targetCondition: malformed || preflight === "session_failed" ? "unknown" : "unavailable",
          recovery: cancelled ? ["retry_same_request"] : ["observe_again"],
        });
        return { ok: false, receipt: receipt("not_completed", result), error: cancelled ? "Desktop menu invocation was cancelled before it began." : "The exact desktop target is no longer available.", outcome: result };
      }
      const human = await this.assertContextHumanControl(context, request.scope);
      if (human !== "current") {
        const result = outcome("pre_effect_dispatch", {
          retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
          ...(human === "external_interference" ? { externalInterference: "user_input" as const } : {}),
        });
        return { ok: false, receipt: receipt("not_completed", result), error: human === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: result };
      }
      boundaryCrossed = true;
      const invoked = await this.call(leases, request.scope, "invoke_menu", {
        pid: provider.pid, window_id: provider.windowId, path: [...request.operation.menuPath],
      }, request.signal);
      if (!invoked.ok && invoked.stage === "session") {
        boundaryCrossed = false;
        const result = outcome("pre_effect_dispatch", { retrySafety: invoked.code === "cancelled" ? "safe" : "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: invoked.code === "cancelled" ? "cancelled" : "unknown", targetCondition: "current", recovery: invoked.code === "cancelled" ? ["retry_same_request"] : ["observe_again"] });
        return { ok: false, receipt: receipt("not_completed", result), error: "Cua could not begin the exact native menu command.", outcome: result };
      }
      if (invoked.ok && isMenuPathUnavailable(invoked.result)) {
        boundaryCrossed = false;
        const result = outcome("pre_effect_dispatch", { retrySafety: "never", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "current", recovery: [] });
        return { ok: false, receipt: receipt("not_completed", result), error: "That exact native menu path is unavailable in the current window.", outcome: result };
      }
      if (!invoked.ok || invoked.result.structuredContent === null || !exactInvokeMenuAction(invoked.result.structuredContent)) {
        this.registry.markUnknownCompletion(context, request.scope);
        if (invoked.ok && !invoked.result.isError) this.invalidateMalformedProvider();
        const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: "unknown", providerCondition: invoked.ok && !invoked.result.isError ? "malformed_response" : "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        return { ok: false, receipt: receipt("unknown_completion", result), error: "Native menu completion is unknown. Observe again; do not replay it.", outcome: result };
      }
      this.registry.retireMutationCapabilities(context, request.scope);
      const providerAction = actionProjection(invoked.result.structuredContent)!;
      const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: "unknown", providerCondition: "ready", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
      return { ok: false, receipt: receipt("unknown_completion", result, providerAction, "foreground"), error: "The native menu command was delivered, but its semantic effect requires a fresh observation. Do not replay it.", outcome: result };
    } catch {
      if (boundaryCrossed) this.registry.markUnknownCompletion(context, request.scope);
      const result = outcome(boundaryCrossed ? "post_effect_verification" : "pre_effect_dispatch", {
        retrySafety: boundaryCrossed ? "never" : "observe_before_retry", stateChangeCertainty: boundaryCrossed ? "unknown" : "not_changed",
        providerCondition: "unknown", targetCondition: "unknown", recovery: boundaryCrossed ? ["observe_again", "do_not_replay"] : ["observe_again"],
      });
      return { ok: false, receipt: receipt(boundaryCrossed ? "unknown_completion" : "not_completed", result), error: boundaryCrossed ? "Native menu completion is unknown. Observe again; do not replay it." : "Cua could not preflight the exact native menu target.", outcome: result };
    } finally {
      await this.release(request.scope, leases);
    }
  }

  /** Set one exact native window frame and independently verify its live bounds. */
  async setWindowFrame(request: CuaComputerDoSetWindowFrameRequest): Promise<CuaComputerDoResult> {
    const { context, reference } = request.operation.target;
    const target = this.registry.resolveTarget(context, request.scope, reference);
    const unavailable: CuaComputerMutationReceipt["resolvedTarget"] = { kind: "window", role: "unavailable" };
    const receipt = (
      certainty: "completed" | "not_completed" | "unknown_completion",
      result: ComputerUseOperationOutcome,
      providerAction: CuaComputerMutationReceipt["providerAction"] = null,
    ): CuaComputerMutationReceipt => ({
      version: 1, timing: "immediate", action: "set_window_frame",
      target: { version: 1, context, reference }, resolvedTarget: target.ok ? receiptEvidence(target.data.evidence) : unavailable,
      provider: "cua", deliveryMode: certainty === "completed" ? "not_applicable" : certainty === "not_completed" ? "not_delivered" : "unknown",
      completionCertainty: certainty, verification: certainty === "completed" ? "verified" : certainty === "unknown_completion" ? "not_verified" : "unavailable",
      providerAction, unexecutedRemainder: { count: certainty === "completed" ? 0 : 1, reason: certainty === "completed" ? "none" : certainty === "not_completed" ? "failed" : "unknown_completion" }, outcome: result,
    });
    if (!target.ok) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", targetCondition: "stale", recovery: ["observe_again"] });
      return { ok: false, receipt: receipt("not_completed", result), error: registryError(target.code), outcome: result };
    }
    const provider = target.data.providerTarget;
    if (provider.provider !== "cua" || provider.operation !== "focus" || provider.pid === undefined || provider.windowId === undefined || provider.app === undefined) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
      return { ok: false, receipt: receipt("not_completed", result), error: "This target does not authorize an exact window-frame change.", outcome: result };
    }
    if (request.signal?.aborted) {
      const result = outcome("pre_effect_dispatch", { retrySafety: "safe", stateChangeCertainty: "not_changed", providerCondition: "cancelled", targetCondition: "current", recovery: ["retry_same_request"] });
      return { ok: false, receipt: receipt("not_completed", result), error: "Window-frame change was cancelled before it began.", outcome: result };
    }
    const leases: Lease[] = [];
    let boundaryCrossed = false;
    try {
      const preflight = await this.preflightExactWindow(request.scope, provider, request.signal, leases);
      if (preflight !== "current") {
        const malformed = preflight === "malformed";
        if (malformed) this.invalidateMalformedProvider();
        const cancelled = preflight === "cancelled";
        const result = outcome("pre_effect_dispatch", {
          retrySafety: cancelled ? "safe" : "observe_before_retry", stateChangeCertainty: "not_changed",
          providerCondition: cancelled ? "cancelled" : malformed ? "malformed_response" : preflight === "unavailable" ? "ready" : "unknown",
          targetCondition: malformed || preflight === "session_failed" ? "unknown" : "unavailable",
          recovery: cancelled ? ["retry_same_request"] : ["observe_again"],
        });
        return { ok: false, receipt: receipt("not_completed", result), error: cancelled ? "Window-frame change was cancelled before it began." : "The exact desktop target is no longer available.", outcome: result };
      }
      const human = await this.assertContextHumanControl(context, request.scope);
      if (human !== "current") {
        const result = outcome("pre_effect_dispatch", {
          retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
          ...(human === "external_interference" ? { externalInterference: "user_input" as const } : {}),
        });
        return { ok: false, receipt: receipt("not_completed", result), error: human === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: result };
      }
      boundaryCrossed = true;
      const changed = await this.call(leases, request.scope, "set_window_frame", {
        pid: provider.pid, window_id: provider.windowId,
        x: request.operation.frame.x, y: request.operation.frame.y,
        width: request.operation.frame.width, height: request.operation.frame.height,
      }, request.signal);
      if (!changed.ok && changed.stage === "session") {
        boundaryCrossed = false;
        const result = outcome("pre_effect_dispatch", { retrySafety: changed.code === "cancelled" ? "safe" : "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: changed.code === "cancelled" ? "cancelled" : "unknown", targetCondition: "current", recovery: changed.code === "cancelled" ? ["retry_same_request"] : ["observe_again"] });
        return { ok: false, receipt: receipt("not_completed", result), error: "Cua could not begin the exact window-frame change.", outcome: result };
      }
      if (!changed.ok) {
        this.registry.markUnknownCompletion(context, request.scope);
        const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: "unknown", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        return { ok: false, receipt: receipt("unknown_completion", result), error: "Window-frame completion is unknown. Observe again; do not replay it.", outcome: result };
      }
      const providerAction = setWindowFrameAction(changed.result);
      if (providerAction === null) {
        this.registry.markUnknownCompletion(context, request.scope);
        if (!changed.result.isError) this.invalidateMalformedProvider();
        const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: "unknown", providerCondition: !changed.result.isError ? "malformed_response" : "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        return { ok: false, receipt: receipt("unknown_completion", result), error: "Window-frame completion is unknown. Observe again; do not replay it.", outcome: result };
      }
      const appsResult = await this.call(leases, request.scope, "list_apps", {}, request.signal);
      const windowsResult = await this.call(leases, request.scope, "list_windows", { pid: provider.pid }, request.signal);
      const sameSession = appsResult.ok && windowsResult.ok
        && appsResult.generation === changed.generation && appsResult.sessionId === changed.sessionId
        && windowsResult.generation === changed.generation && windowsResult.sessionId === changed.sessionId;
      const apps = sameSession && !appsResult.result.isError ? parseApplications(appsResult.result) : null;
      const windows = apps !== null && windowsResult.ok && !windowsResult.result.isError
        ? parseWindows(windowsResult.result, new Map(apps.applications.map((app) => [app.pid, app])))
        : null;
      const humanAfterRead = await this.assertContextHumanControl(context, request.scope);
      const observed = windows?.windows.find((window) => window.pid === provider.pid && window.windowId === provider.windowId);
      const frame = request.operation.frame;
      // AppKit/WindowServer may settle a requested frame by one or two logical
      // pixels for borders and screen constraints. The public verifier already
      // defines this same 2 px tolerance; requiring byte-exact geometry here
      // falsely turns a confirmed move into unknown completion.
      const settled = observed !== undefined && Math.abs(observed.bounds.x - frame.x) <= 2
        && Math.abs(observed.bounds.y - frame.y) <= 2
        && Math.abs(observed.bounds.width - frame.width) <= 2
        && Math.abs(observed.bounds.height - frame.height) <= 2;
      if (sameSession && apps !== null && windows !== null && humanAfterRead === "current" && settled && !request.signal?.aborted) {
        const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: "changed", providerCondition: "ready", targetCondition: "current", recovery: [] });
        return { ok: true, receipt: receipt("completed", result, providerAction) };
      }
      this.registry.markUnknownCompletion(context, request.scope);
      const malformed = sameSession && (apps === null || windows === null);
      if (malformed) this.invalidateMalformedProvider();
      const result = outcome("post_effect_verification", {
        retrySafety: "never", stateChangeCertainty: "unknown", providerCondition: malformed ? "malformed_response" : "unknown", targetCondition: "unknown",
        recovery: ["observe_again", "do_not_replay"], ...(humanAfterRead === "external_interference" ? { externalInterference: "user_input" as const } : {}),
      });
      // A confirmed provider action cannot be attached to a public
      // unknown-completion receipt: confirmation belongs only to a verified
      // completed mutation in the public schema. Keep the private fact out of
      // this conservative result rather than manufacturing host_failure.
      return { ok: false, receipt: receipt("unknown_completion", result), error: humanAfterRead === "external_interference" ? "Local input interrupted window-frame verification. Observe again; do not replay it." : "Window-frame completion could not be verified. Observe again; do not replay it.", outcome: result };
    } catch {
      if (boundaryCrossed) this.registry.markUnknownCompletion(context, request.scope);
      const result = outcome(boundaryCrossed ? "post_effect_verification" : "pre_effect_dispatch", {
        retrySafety: boundaryCrossed ? "never" : "observe_before_retry", stateChangeCertainty: boundaryCrossed ? "unknown" : "not_changed",
        providerCondition: "unknown", targetCondition: "unknown", recovery: boundaryCrossed ? ["observe_again", "do_not_replay"] : ["observe_again"],
      });
      return { ok: false, receipt: receipt(boundaryCrossed ? "unknown_completion" : "not_completed", result), error: boundaryCrossed ? "Window-frame completion is unknown. Observe again; do not replay it." : "Cua could not preflight the exact window-frame target.", outcome: result };
    } finally {
      await this.release(request.scope, leases);
    }
  }

  /**
   * One crossed native new-window menu boundary with a single complete native-set
   * handoff.  This is intentionally not a general polling primitive: it owns
   * the pre-set, one menu invocation, 8s/12-read post-set budget, and atomic
   * new-context mint together so a caller cannot accidentally compare a
   * fresh result with another invocation's stale baseline.
   */
  async createWindow(request: CuaComputerDoCreateWindowRequest): Promise<CuaComputerDoResult> {
    const { context, reference } = request.operation.target;
    const target = this.registry.resolveTarget(context, request.scope, reference);
    const baseOutcome = (phase: ComputerUseOperationOutcome["phase"], certainty: ComputerUseOperationOutcome["stateChangeCertainty"], recovery: ComputerUseOperationOutcome["recovery"]): ComputerUseOperationOutcome => outcome(phase, {
      // A pre-boundary failure asking for a fresh observation cannot also be
      // final/never: the recovery tuple is part of the public contract.
      retrySafety: phase === "pre_effect_dispatch" && recovery.length === 0 ? "never" : "observe_before_retry",
      stateChangeCertainty: certainty,
      providerCondition: phase === "pre_effect_dispatch" && recovery.length === 0 ? "ready" : "unknown",
      targetCondition: phase === "pre_effect_dispatch" && recovery.length === 0 ? "current" : "unknown",
      recovery,
    });
    const receipt = (
      certainty: "completed" | "not_completed" | "unknown_completion",
      result: ComputerUseOperationOutcome,
      postObservation?: CuaAppearedWindowPostObservation,
      providerAction: CuaComputerMutationReceipt["providerAction"] = null,
    ): CuaComputerMutationReceipt => ({
      version: 1,
      timing: "immediate",
      action: "create_window",
      target: { version: 1, context, reference },
      resolvedTarget: target.ok ? receiptEvidence(target.data.evidence) : { kind: "app", state: "unavailable" },
      provider: "cua",
      // A checked successful invoke_menu remains a foreground provider fact
      // even when the semantic before/after set cannot attribute one window.
      // Transport/malformed paths pass null and therefore retain unknown.
      deliveryMode: certainty === "completed" || providerAction?.delivery?.mode === "foreground"
        ? "foreground"
        : certainty === "not_completed" ? "not_delivered" : "unknown",
      completionCertainty: certainty,
      verification: certainty === "completed" ? "verified" : certainty === "unknown_completion" ? "not_verified" : "unavailable",
      providerAction,
      ...(postObservation === undefined ? {} : { postObservation }),
      unexecutedRemainder: { count: certainty === "completed" ? 0 : 1, reason: certainty === "completed" ? "none" : certainty === "not_completed" ? "failed" : "unknown_completion" },
      outcome: result,
    });
    if (!target.ok) {
      const result = outcome("resolve_target", {
        retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "stale", recovery: ["observe_again"],
      });
      return { ok: false, receipt: receipt("not_completed", result), error: registryError(target.code), outcome: result };
    }
    const provider = target.data.providerTarget;
    if (provider.provider !== "cua" || provider.operation !== "observe_only" || provider.pid === undefined || provider.app === undefined
      || provider.bundleId === undefined) {
      const result = outcome("pre_effect_dispatch", {
        retrySafety: "never", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "current", recovery: [],
      });
      return { ok: false, receipt: receipt("not_completed", result), error: "This exact desktop menu target is no longer available.", outcome: result };
    }
    if (request.signal?.aborted) {
      const result = outcome("pre_effect_dispatch", { retrySafety: "safe", stateChangeCertainty: "not_changed", providerCondition: "cancelled", targetCondition: "current", recovery: ["retry_same_request"] });
      return { ok: false, receipt: receipt("not_completed", result), error: "Desktop menu action was cancelled before it began.", outcome: result };
    }

    const leases: Lease[] = [];
    let crossedBoundary = false;
    try {
      let trustedHumanEpoch = await this.readHumanInputEpoch();
      const entry = this.registry.advanceHumanInputEpoch(context, request.scope, trustedHumanEpoch, HUMAN_INPUT_EPOCH_TOLERANCE_MILLISECONDS);
      if (!entry.ok) {
        if (entry.code === "external_interference") throw new CuaExternalInterferenceError();
        const result = outcome("resolve_target", {
          retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "stale", recovery: ["observe_again"],
        });
        return { ok: false, receipt: receipt("not_completed", result), error: registryError(entry.code), outcome: result };
      }
      const assertUninterrupted = async (): Promise<void> => {
        const current = await this.readHumanInputEpoch();
        if (current > trustedHumanEpoch + HUMAN_INPUT_EPOCH_TOLERANCE_MILLISECONDS) {
          throw new CuaExternalInterferenceError();
        }
        trustedHumanEpoch = current;
      };
      const baselineResult = await this.call(leases, request.scope, "list_windows", { pid: provider.pid }, request.signal);
      if (!baselineResult.ok || baselineResult.result.isError) {
        const result = baseOutcome("pre_effect_dispatch", "not_changed", ["observe_again"]);
        return { ok: false, receipt: receipt("not_completed", result), error: "Desktop menu preflight could not complete. Observe again.", outcome: result };
      }
      const applications = new Map<number, ParsedApplication>([[provider.pid, {
        pid: provider.pid,
        name: provider.app,
        bundleId: provider.bundleId,
        active: false,
      }]]);
      const baseline = parseWindows(baselineResult.result, applications);
      if (baseline === null || baseline.uninspectedWindows !== 0) {
        // The local complete-set bound is an authority limit, not evidence
        // that Cua drifted. We cannot safely attribute a new window from a
        // truncated pre-set, but the checked provider remains usable.
        if (baseline === null) this.invalidateMalformedProvider();
        const result = baseOutcome("pre_effect_dispatch", "not_changed", ["observe_again"]);
        return { ok: false, receipt: receipt("not_completed", result), error: "Desktop menu preflight did not match the checked Cua contract.", outcome: result };
      }
      const ordinaryBaseline = baseline.windows.filter((window) => window.appWindowCandidate);
      const baselineIds = new Set(ordinaryBaseline.map((window) => window.windowId));
      const menuAnchors = ordinaryBaseline.filter((window): window is ParsedWindow & { readonly zIndex: number } => window.zIndex !== null);
      if (menuAnchors.length === 0) {
        const result = baseOutcome("pre_effect_dispatch", "not_changed", ["observe_again"]);
        return { ok: false, receipt: receipt("not_completed", result), error: "No exact ordinary native window is currently available for this application.", outcome: result };
      }
      // Cua's invoke_menu owns exact-target activation and fails closed when
      // the live native menu path cannot be resolved. Do not pre-focus or AX
      // probe raw WindowServer helper surfaces here: those extra boundaries
      // can change focus without running the requested menu command. Higher
      // z-index is closer to the front; array order is never identity.
      menuAnchors.sort((left, right) => right.zIndex - left.zIndex || left.windowId - right.windowId);
      await assertUninterrupted();
      crossedBoundary = true;
      const invoked = await this.call(leases, request.scope, "invoke_menu", {
        pid: provider.pid,
        window_id: menuAnchors[0]!.windowId,
        path: request.operation.menuPath,
      }, request.signal);
      // A transport failure after the dispatch attempt is indeterminate.  Do
      // not convert an ActionResult into success: Cua itself documents menu
      // effects as unverifiable pending fresh semantic state.
      if (!invoked.ok) {
        this.registry.markUnknownCompletion(context, request.scope);
        const result = baseOutcome("post_effect_verification", "unknown", ["observe_again", "do_not_replay"]);
        return { ok: false, receipt: receipt("unknown_completion", result, { version: 1, kind: "appeared_window", disposition: "incomplete" }), error: "Desktop menu completion is unknown. Observe again; do not replay it.", outcome: result };
      }
      if (invoked.result.isError && isMenuPathUnavailable(invoked.result)) {
        // Cua proved it did not dispatch the requested final menu action. Its
        // internal focus preparation is not semantic evidence that the requested menu command
        // ran, so this is safely a pre-effect refusal with no handoff claim.
        crossedBoundary = false;
        const result = baseOutcome("pre_effect_dispatch", "not_changed", ["observe_again"]);
        return { ok: false, receipt: receipt("not_completed", result), error: "The requested native menu path is not currently available. Observe again.", outcome: result };
      }
      if (invoked.result.isError || invoked.result.structuredContent === null || !exactInvokeMenuAction(invoked.result.structuredContent)) {
        this.registry.markUnknownCompletion(context, request.scope);
        const result = baseOutcome("post_effect_verification", "unknown", ["observe_again", "do_not_replay"]);
        return { ok: false, receipt: receipt("unknown_completion", result, { version: 1, kind: "appeared_window", disposition: "incomplete" }), error: "Desktop menu completion is unknown. Observe again; do not replay it.", outcome: result };
      }
      const menuProviderAction = actionProjection(invoked.result.structuredContent);
      await assertUninterrupted();
      const deadline = this.clock() + 8_000;
      let complete = true;
      let appeared: ParsedWindow[] = [];
      for (let reads = 0; reads < 12 && this.clock() < deadline; reads += 1) {
        const listed = await this.call(leases, request.scope, "list_windows", { pid: provider.pid }, request.signal);
        if (!listed.ok || listed.result.isError) { complete = false; break; }
        const post = parseWindows(listed.result, applications);
        if (post === null || post.uninspectedWindows !== 0) {
          complete = false;
          // A legitimate result above our complete-set cap is a semantic
          // incompleteness after the crossed boundary, never a route-health
          // failure.  Only malformed bytes withdraw Cua readiness.
          if (post === null) this.invalidateMalformedProvider();
          break;
        }
        // Window creation can also produce unlocated layer-zero helper surfaces.
        // Only located positive-size candidates are
        // semantic windows; retain the raw complete set solely as the checked
        // provider envelope and compare the ordinary candidate sets here.
        appeared = post.windows.filter((window) => window.appWindowCandidate && !baselineIds.has(window.windowId));
        await assertUninterrupted();
        if (appeared.length > 0) break;
        if (reads < 11 && this.clock() < deadline) await this.sleep(150, request.signal);
      }
      const postObservation = (): CuaAppearedWindowPostObservation => {
        if (!complete) return { version: 1, kind: "appeared_window", disposition: "incomplete" };
        if (appeared.length === 0) return { version: 1, kind: "appeared_window", disposition: "none_observed" };
        if (appeared.length !== 1) return { version: 1, kind: "appeared_window", disposition: "ambiguous" };
        const appearedWindow = appeared[0]!;
        // Re-resolve the input app immediately before the atomic successor
        // commit.  A stale/fenced app authority may never mint a new dctx_.
        const currentApp = this.registry.resolveTarget(context, request.scope, reference);
        if (!currentApp.ok || currentApp.data.providerTarget.provider !== "cua"
          || currentApp.data.providerTarget.operation !== "observe_only"
          || currentApp.data.providerTarget.pid !== provider.pid
          || currentApp.data.providerTarget.bundleId !== provider.bundleId
          || currentApp.data.providerTarget.app !== provider.app) {
          return { version: 1, kind: "appeared_window", disposition: "incomplete" };
        }
        const minted = this.registry.createAppearedWindowContext(request.scope, trustedHumanEpoch, {
          evidence: { kind: "app", appLabel: provider.app! },
          providerTarget: {
            provider: "cua",
            operation: "observe_only",
            app: provider.app!,
            pid: provider.pid!,
            bundleId: provider.bundleId!,
          },
        }, {
          // Retained context evidence carries only the user-visible semantic
          // app label required by generic window-state receipts. The public
          // create handoff below remains content-free: no native title/id.
          evidence: { kind: "window", appLabel: provider.app! },
          providerTarget: {
            provider: "cua",
            operation: "focus",
            app: provider.app!,
            pid: provider.pid!,
            windowId: appearedWindow.windowId,
            bundleId: provider.bundleId!,
            freshAppeared: true,
          },
        });
        if (!minted.ok) return { version: 1, kind: "appeared_window", disposition: "incomplete" };
        if (!this.retain(minted.data.context, request.scope, leases)) return { version: 1, kind: "appeared_window", disposition: "incomplete" };
        return {
          version: 1,
          kind: "appeared_window",
          disposition: "unique",
          app: {
            target: { version: 1, context: minted.data.context, reference: minted.data.app.reference },
            evidence: { kind: "app", appLabel: provider.app! },
          },
          window: { target: { version: 1, context: minted.data.context, reference: minted.data.window.reference }, evidence: { kind: "window" } },
        };
      };
      const handoff = postObservation();
      // The new context exists only for a unique observed delta.  The old
      // context is atomically withdrawn by the registry at that point.
      if (handoff.disposition === "unique") {
        const result = outcome("post_effect_verification", {
          retrySafety: "never", stateChangeCertainty: "changed", providerCondition: "ready", targetCondition: "current", recovery: ["do_not_replay"],
        });
        return { ok: true, receipt: receipt("completed", result, handoff, menuProviderAction) };
      }
      this.registry.markUnknownCompletion(context, request.scope);
      // The checked foreground ActionResult is retained even when the
      // semantic before/after set cannot attribute one successor window.
      const result = outcome("post_effect_verification", {
        retrySafety: "observe_before_retry", stateChangeCertainty: "unknown",
        providerCondition: "ready", targetCondition: "current",
        recovery: ["observe_again", "do_not_replay"],
      });
      return { ok: false, receipt: receipt("unknown_completion", result, handoff, menuProviderAction), error: "Desktop menu completion is unknown. Observe again; do not replay it.", outcome: result };
    } catch (error) {
      const interrupted = error instanceof CuaExternalInterferenceError;
      if (crossedBoundary) this.registry.markUnknownCompletion(context, request.scope);
      const result = crossedBoundary
        ? baseOutcome("post_effect_verification", "unknown", ["observe_again", "do_not_replay"])
        : baseOutcome("pre_effect_dispatch", "not_changed", ["observe_again"]);
      const classified = interrupted
        ? { ...result, externalInterference: "user_input" as const }
        : result;
      return {
        ok: false,
        receipt: receipt(crossedBoundary ? "unknown_completion" : "not_completed", classified, crossedBoundary ? { version: 1, kind: "appeared_window", disposition: "incomplete" } : undefined),
        error: interrupted ? "Local input interrupted the desktop operation. Observe again before acting." : crossedBoundary ? "Desktop menu completion is unknown. Observe again; do not replay it." : "Desktop menu preflight could not complete. Observe again.",
        outcome: classified,
      };
    } finally {
      await this.release(request.scope, leases);
    }
  }

  async verify(request: CuaComputerVerifyRequest): Promise<CuaComputerVerifyResult> {
    const target = this.registry.resolveObservationTarget(request.target.context, request.scope, request.target.reference);
    if (!target.ok) {
      const outcomeResult = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", targetCondition: "stale", recovery: ["observe_again"] });
      return { ok: false, error: registryError(target.code), outcome: outcomeResult };
    }
    const provider = target.data.providerTarget;
    if (provider.provider !== "cua" || provider.operation !== "focus" || provider.pid === undefined || provider.windowId === undefined || provider.app === undefined) {
      const outcomeResult = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
      return { ok: false, error: "This target cannot be verified by the selected desktop provider.", outcome: outcomeResult };
    }
    if (request.signal?.aborted) {
      const outcomeResult = outcome("pre_effect_dispatch", { retrySafety: "safe", stateChangeCertainty: "not_applicable", providerCondition: "cancelled", targetCondition: "current", recovery: ["retry_same_request"] });
      return { ok: false, error: "Desktop verification was cancelled before it began.", outcome: outcomeResult };
    }
    const entryHumanControl = await this.assertContextHumanControl(request.target.context, request.scope);
    if (entryHumanControl !== "current") {
      const outcomeResult = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"], ...(entryHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}) });
      return { ok: false, error: entryHumanControl === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: outcomeResult };
    }
    const leases: Lease[] = [];
    try {
      const preflight = await this.preflightExactWindow(request.scope, provider, request.signal, leases);
      if (preflight !== "current") {
        const cancelled = preflight === "cancelled";
        const malformed = preflight === "malformed";
        if (malformed) this.invalidateMalformedProvider();
        const outcomeResult = outcome("resolve_target", {
          retrySafety: cancelled ? "safe" : "observe_before_retry", stateChangeCertainty: "not_applicable",
          providerCondition: cancelled ? "cancelled" : malformed ? "malformed_response" : preflight === "unavailable" ? "ready" : "unknown",
          targetCondition: malformed || preflight === "session_failed" ? "unknown" : "unavailable",
          recovery: cancelled ? ["retry_same_request"] : ["observe_again"],
        });
        return { ok: false, error: cancelled ? "Desktop verification was cancelled before it began." : "The exact desktop target is no longer available.", outcome: outcomeResult };
      }
      const postPreflightHumanControl = await this.assertContextHumanControl(request.target.context, request.scope);
      if (postPreflightHumanControl !== "current") {
        const outcomeResult = outcome("pre_effect_dispatch", {
          retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable",
          providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
          ...(postPreflightHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}),
        });
        return { ok: false, error: postPreflightHumanControl === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: outcomeResult };
      }
      // The qualified handoff fixes two stable samples over two seconds;
      // keep screenshots out of this semantic read path and discard
      // `observed_json` even after schema validation.
      const expect = cuaVerifyExpect(request.expect);
      if (expect === null) {
        const outcomeResult = outcome("pre_effect_dispatch", { retrySafety: "never", stateChangeCertainty: "not_applicable", providerCondition: "ready", targetCondition: "current", recovery: [] });
        return { ok: false, error: "Computer verification received an invalid bounded predicate.", outcome: outcomeResult };
      }
      const verified = await this.call(leases, request.scope, "verify_state", {
        pid: provider.pid,
        window_id: provider.windowId,
        expect,
        timeout_ms: 2_000,
        stable_samples: 2,
        include_screenshot: false,
      }, request.signal);
      if (!verified.ok) {
        const cancelled = verified.code === "cancelled";
        const outcomeResult = outcome("post_effect_verification", { retrySafety: cancelled ? "safe" : "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: cancelled ? "cancelled" : "unknown", targetCondition: "unknown", recovery: cancelled ? ["retry_same_request"] : ["observe_again"] });
        return { ok: false, error: "Cua could not complete the exact desktop verification.", outcome: outcomeResult };
      }
      const postReadHumanControl = await this.assertContextHumanControl(request.target.context, request.scope);
      if (postReadHumanControl !== "current") {
        const outcomeResult = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"], ...(postReadHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}) });
        return { ok: false, error: postReadHumanControl === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: outcomeResult };
      }
      if (verified.result.isError) {
        const outcomeResult = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "unknown", targetCondition: "current", recovery: ["observe_again"] });
        return { ok: false, error: "Cua could not complete the exact desktop verification.", outcome: outcomeResult };
      }
      const parsed = parseVerifyState(verified.result, request.target, expect.length);
      if (parsed === null || request.signal?.aborted) {
        if (parsed === null) this.invalidateMalformedProvider();
        const outcomeResult = outcome("post_effect_verification", { retrySafety: request.signal?.aborted ? "safe" : "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: request.signal?.aborted ? "cancelled" : "malformed_response", targetCondition: "unknown", recovery: request.signal?.aborted ? ["retry_same_request"] : ["observe_again"] });
        return { ok: false, error: request.signal?.aborted ? "Desktop verification was cancelled before it completed." : "Cua did not return the pinned verification result.", outcome: outcomeResult };
      }
      return { ok: true, verification: parsed };
    } catch {
      const outcomeResult = outcome("post_effect_verification", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_applicable", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"] });
      return { ok: false, error: "Cua could not complete the exact desktop verification.", outcome: outcomeResult };
    } finally {
      await this.release(request.scope, leases);
    }
  }

  /** One qualified foreground drag in the exact fresh Cua window-screenshot frame. */
  async dragDrop(request: CuaComputerDoDragDropRequest): Promise<CuaComputerDoResult> {
    const { context, reference } = request.operation.target;
    const unavailable: ComputerUseTargetEvidence = { kind: "screen", role: "unavailable" };
    const failure = (certainty: "not_completed" | "unknown_completion", result: ComputerUseOperationOutcome, evidence = unavailable): CuaComputerMutationReceipt => ({
      version: 1, timing: "immediate", action: "drag_drop",
      target: { version: 1, context, reference }, resolvedTarget: evidence, provider: "cua",
      deliveryMode: certainty === "not_completed" ? "not_delivered" : "unknown",
      completionCertainty: certainty, verification: "not_verified", providerAction: null,
      unexecutedRemainder: { count: 1, reason: certainty === "not_completed" ? "failed" : "unknown_completion" }, outcome: result,
    });
    const snapshot = this.registry.resolveScreenSnapshot(context, request.scope, reference);
    if (!snapshot.ok) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", targetCondition: "stale", recovery: ["observe_again"] });
      return { ok: false, receipt: failure("not_completed", result), error: registryError(snapshot.code), outcome: result };
    }
    const { metadata, providerSnapshot } = snapshot.data;
    const frame = windowSnapshotFrame(metadata, providerSnapshot);
    const desktop = providerSnapshot.kind === "desktop" && "display" in metadata;
    const dimensions = desktop ? metadata.presentedDimensions : frame === null ? null : { width: frame.width, height: frame.height };
    const evidence: ComputerUseTargetEvidence = dimensions === null ? unavailable : { kind: "screen", bounds: { x: 0, y: 0, width: dimensions.width, height: dimensions.height } };
    const pointValid = (point: Readonly<{ x: number; y: number }>) => dimensions !== null
      && Number.isFinite(point.x) && point.x >= 0 && point.x < dimensions.width
      && Number.isFinite(point.y) && point.y >= 0 && point.y < dimensions.height;
    if (dimensions === null || request.operation.coordinateSpace !== (desktop ? "presented_snapshot_pixels" : frame?.coordinateSpace)
      || !pointValid(request.operation.from) || !pointValid(request.operation.to)) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
      return { ok: false, receipt: failure("not_completed", result, evidence), error: "The drag points do not match this exact snapshot and coordinate frame.", outcome: result };
    }
    if (desktop && request.operation.deliveryMode === "background") {
      const result = outcome("pre_effect_dispatch", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "current", recovery: ["observe_again"] });
      return { ok: false, receipt: failure("not_completed", result, evidence), error: "Desktop drag is foreground input. Use foreground delivery against a fresh desktop snapshot. Nothing was dragged.", outcome: result };
    }
    const mapPoint = (point: Readonly<{ x: number; y: number }>) => desktop && providerSnapshot.kind === "desktop"
      ? { x: point.x * providerSnapshot.nativeWidth / dimensions.width, y: point.y * providerSnapshot.nativeHeight / dimensions.height }
      : windowPoint(frame!, point.x, point.y)!;
    const from = mapPoint(request.operation.from);
    const to = mapPoint(request.operation.to);
    if (request.signal?.aborted) {
      const result = outcome("pre_effect_dispatch", { retrySafety: "safe", stateChangeCertainty: "not_changed", providerCondition: "cancelled", targetCondition: "current", recovery: ["retry_same_request"] });
      return { ok: false, receipt: failure("not_completed", result, evidence), error: "Desktop drag was cancelled before it began.", outcome: result };
    }
    const human = await this.assertContextHumanControl(context, request.scope);
    if (human !== "current") {
      const result = outcome("pre_effect_dispatch", {
        retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
        ...(human === "external_interference" ? { externalInterference: "user_input" as const } : {}),
      });
      return { ok: false, receipt: failure("not_completed", result, evidence), error: human === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: result };
    }
    let crossed = false;
    let settled = false;
    let dispatchHuman: "current" | "external_interference" | "unavailable" | null = null;
    const leases: Lease[] = [];
    try {
      const dispatched = await this.call(leases, request.scope, "drag", {
        ...(desktop ? { scope: "desktop" } : { pid: frame!.pid, window_id: frame!.windowId, delivery_mode: request.operation.deliveryMode ?? "foreground" }),
        from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y,
        ...(request.operation.durationMs === undefined ? {} : { duration_ms: request.operation.durationMs }),
        ...(request.operation.steps === undefined ? {} : { steps: request.operation.steps }),
        ...cuaPixelClickArguments(request.operation),
      }, request.signal, async () => {
        dispatchHuman = await this.assertContextHumanControl(context, request.scope);
        if (dispatchHuman !== "current") return false;
        const claimed = this.registry.claimSnapshotMutation(context, request.scope);
        crossed = claimed.ok;
        return crossed;
      });
      if (!dispatched.ok) {
        if (!crossed && dispatchHuman !== null && dispatchHuman !== "current") {
          const result = outcome("pre_effect_dispatch", {
            retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
            ...(dispatchHuman === "external_interference" ? { externalInterference: "user_input" as const } : {}),
          });
          return { ok: false, receipt: failure("not_completed", result, evidence), error: dispatchHuman === "external_interference" ? "Local input interrupted the desktop operation. Observe again before acting." : "Desktop human-input state could not be read. Observe again before acting.", outcome: result };
        }
        const pre = !crossed && dispatched.stage === "session";
        const result = outcome(pre ? "pre_effect_dispatch" : "post_effect_verification", {
          retrySafety: pre && dispatched.code === "cancelled" ? "safe" : pre ? "observe_before_retry" : "never",
          stateChangeCertainty: pre ? "not_changed" : "unknown",
          providerCondition: dispatched.code === "cancelled" ? "cancelled" : "unknown",
          targetCondition: pre ? "current" : "unknown",
          recovery: pre && dispatched.code === "cancelled" ? ["retry_same_request"] : pre ? ["observe_again"] : ["observe_again", "do_not_replay"],
        });
        return { ok: false, receipt: failure(pre ? "not_completed" : "unknown_completion", result, evidence), error: pre ? "Cua could not begin the exact drag." : "Desktop drag completion is unknown. Observe again; do not replay it.", outcome: result };
      }
      if (!desktop && frame !== null && parseWindowPixelClickEffect(dispatched.result, { pid: frame.pid, windowId: frame.windowId }).kind === "not_delivered") {
        settled = true;
        const result = outcome("pre_effect_dispatch", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
        return { ok: false, receipt: failure("not_completed", result, evidence), error: "Cua did not deliver the drag. Obtain a fresh snapshot of the intended target and use foreground delivery. Nothing was dragged.", outcome: result };
      }
      const providerAction = parseDragAction(dispatched.result, desktop);
      settled = providerAction !== null;
      if (providerAction === null) {
        this.invalidateMalformedProvider();
        const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: "unknown", providerCondition: "malformed_response", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        return { ok: false, receipt: failure("unknown_completion", result, evidence), error: "Cua drag output did not match the pinned contract. Observe again; do not replay it.", outcome: result };
      }
      const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: "unknown", providerCondition: "ready", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
      return {
        ok: true,
        receipt: {
          version: 1, timing: "immediate", action: "drag_drop", target: { version: 1, context, reference }, resolvedTarget: evidence, provider: "cua",
          deliveryMode: desktop ? "not_applicable" : "foreground", completionCertainty: "completed", verification: "not_verified", providerAction,
          unexecutedRemainder: { count: 0, reason: "none" }, outcome: result,
        },
      };
    } finally {
      if (crossed) {
        if (settled) this.registry.settleSnapshotMutation(context, request.scope);
        else this.registry.markUnknownCompletion(context, request.scope);
      }
      await this.release(request.scope, leases);
    }
  }

  async click(request: CuaComputerDoClickRequest): Promise<CuaComputerDoResult> {
    if (!("coordinateSpace" in request.operation)) {
      return this.mutateExactWindow(request as CuaElementClickRequest);
    }
    const { context, reference } = request.operation.target;
    const unavailable: ComputerUseTargetEvidence = { kind: "screen", role: "unavailable" };
    const snapshot = this.registry.resolveScreenSnapshot(context, request.scope, reference);
    if (!snapshot.ok) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", targetCondition: "stale", recovery: ["observe_again"] });
      return { ok: false, receipt: clickFailureReceipt(request, unavailable, "not_completed", result), error: registryError(snapshot.code), outcome: result };
    }
    const { metadata, providerSnapshot } = snapshot.data;
    const desktopDimensions = providerSnapshot.kind === "desktop" && "display" in metadata
      ? metadata.presentedDimensions
      : null;
    const desktopOrigin = providerSnapshot.kind === "desktop" && "display" in metadata
      ? metadata.display.origin
      : null;
    const resolvedWindowFrame = windowSnapshotFrame(metadata, providerSnapshot);
    const windowDimensions = resolvedWindowFrame === null
      ? null
      : { width: resolvedWindowFrame.width, height: resolvedWindowFrame.height };
    const matchingSpace = (desktopDimensions !== null && request.operation.coordinateSpace === "presented_snapshot_pixels")
      || (resolvedWindowFrame !== null && request.operation.coordinateSpace === resolvedWindowFrame.coordinateSpace);
    const dimensions = desktopDimensions ?? windowDimensions;
    if (!matchingSpace || dimensions === null) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", targetCondition: "unavailable", recovery: ["observe_again"] });
      return { ok: false, receipt: clickFailureReceipt(request, unavailable, "not_completed", result), error: "This coordinate space does not match the exact fresh snapshot.", outcome: result };
    }
    const evidence: ComputerUseTargetEvidence = {
      kind: "screen",
      bounds: {
        x: desktopOrigin?.x ?? 0,
        y: desktopOrigin?.y ?? 0,
        width: dimensions.width,
        height: dimensions.height,
      },
    };
    if (!Number.isFinite(request.operation.x) || request.operation.x < 0
      || !Number.isFinite(request.operation.y) || request.operation.y < 0
      || request.operation.x >= dimensions.width
      || request.operation.y >= dimensions.height) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", targetCondition: "unavailable", recovery: ["observe_again"] });
      return { ok: false, receipt: clickFailureReceipt(request, evidence, "not_completed", result), error: "The screen point is outside this exact snapshot.", outcome: result };
    }
    if (request.signal?.aborted) {
      const result = outcome("pre_effect_dispatch", { retrySafety: "safe", stateChangeCertainty: "not_changed", providerCondition: "cancelled", targetCondition: "current", recovery: ["retry_same_request"] });
      return { ok: false, receipt: clickFailureReceipt(request, evidence, "not_completed", result), error: "Desktop click was cancelled before it began.", outcome: result };
    }
    // A screen snapshot is a coordinate capability, not an authority to
    // displace a Human who has taken over since the snapshot was minted.
    // Check it immediately before the global HID boundary.  Unlike AX calls,
    // the click itself advances IOHIDSystem, so there is deliberately no
    // post-click HID attribution. Delivery may still be complete when Cua
    // reports it, but the semantic effect stays unverified and the snapshot
    // context is fenced.
    const entryHumanControl = await this.assertContextHumanControl(context, request.scope);
    if (entryHumanControl !== "current") {
      const result = outcome("pre_effect_dispatch", {
        retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
        ...(entryHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}),
      });
      return {
        ok: false,
        receipt: clickFailureReceipt(request, evidence, "not_completed", result),
        error: entryHumanControl === "external_interference"
          ? "Local input interrupted the desktop operation. Observe again before acting."
          : "Desktop human-input state could not be read. Observe again before acting.",
        outcome: result,
      };
    }
    if (resolvedWindowFrame !== null) {
      const point = windowPoint(resolvedWindowFrame, request.operation.x, request.operation.y)!;
      const deliveryMode = request.operation.deliveryMode ?? "background";
      let crossed = false;
      let settled = false;
      let dispatchHuman: "current" | "external_interference" | "unavailable" | null = null;
      const leases: Lease[] = [];
      try {
        const clicked = await this.call(leases, request.scope, "click", {
          pid: resolvedWindowFrame.pid,
          window_id: resolvedWindowFrame.windowId,
          x: point.x,
          y: point.y,
          delivery_mode: deliveryMode,
          ...cuaPixelClickArguments(request.operation),
        }, request.signal, async () => {
          dispatchHuman = await this.assertContextHumanControl(context, request.scope);
          if (dispatchHuman !== "current") return false;
          const claimed = this.registry.claimSnapshotMutation(context, request.scope);
          crossed = claimed.ok;
          return crossed;
        });
        if (!clicked.ok) {
          if (!crossed && dispatchHuman !== null && dispatchHuman !== "current") {
            const result = outcome("pre_effect_dispatch", {
              retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
              ...(dispatchHuman === "external_interference" ? { externalInterference: "user_input" as const } : {}),
            });
            return {
              ok: false,
              receipt: clickFailureReceipt(request, evidence, "not_completed", result),
              error: dispatchHuman === "external_interference"
                ? "Local input interrupted the desktop operation. Observe again before acting."
                : "Desktop human-input state could not be read. Observe again before acting.",
              outcome: result,
            };
          }
          const pre = !crossed && clicked.stage === "session";
          const result = outcome(pre ? "pre_effect_dispatch" : "post_effect_verification", {
            retrySafety: pre && clicked.code === "cancelled" ? "safe" : pre ? "observe_before_retry" : "never",
            stateChangeCertainty: pre ? "not_changed" : "unknown",
            providerCondition: clicked.code === "cancelled" ? "cancelled" : "unknown",
            targetCondition: pre ? "current" : "unknown",
            recovery: pre && clicked.code === "cancelled" ? ["retry_same_request"] : pre ? ["observe_again"] : ["observe_again", "do_not_replay"],
          });
          return { ok: false, receipt: clickFailureReceipt(request, evidence, pre ? "not_completed" : "unknown_completion", result), error: pre ? "Cua could not begin the exact window click." : "Window click completion is unknown. Observe again; do not replay it.", outcome: result };
        }
        const effect = parseWindowPixelClickEffect(clicked.result, {
          pid: resolvedWindowFrame.pid,
          windowId: resolvedWindowFrame.windowId,
          deliveryMode,
        });
        settled = effect.kind === "delivered" || effect.kind === "not_delivered";
        if (effect.kind === "not_delivered") {
          const result = outcome("pre_effect_dispatch", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] });
          return { ok: false, receipt: clickFailureReceipt(request, evidence, "not_completed", result), error: effect.foregroundRequired
            ? "Cua requires foreground delivery for this exact click. Obtain a fresh window snapshot, then use deliveryMode: foreground. Nothing was clicked."
            : "Cua refused the exact window click. Observe again before acting.", outcome: result };
        }
        if (effect.kind === "provider_failure") {
          const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: "unknown", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
          return { ok: false, receipt: clickFailureReceipt(request, evidence, "unknown_completion", result), error: "Window click completion is unknown. Observe again; do not replay it.", outcome: result };
        }
        if (effect.kind === "malformed") {
          this.invalidateMalformedProvider();
          const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: "unknown", providerCondition: "malformed_response", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
          return { ok: false, receipt: clickFailureReceipt(request, evidence, "unknown_completion", result), error: "Cua window-click output did not match the pinned contract. Observe again; do not replay it.", outcome: result };
        }
        const confirmed = effect.providerAction.effect === "confirmed";
        const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: confirmed ? "changed" : "unknown", providerCondition: "ready", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
        return {
          ok: true,
          receipt: {
            version: 1, timing: "immediate", action: "click",
            target: { version: 1, context, reference }, resolvedTarget: evidence, provider: "cua",
            deliveryMode: effect.providerAction.delivery!.mode as "background" | "foreground", completionCertainty: "completed", verification: confirmed ? "verified" : "not_verified",
            providerAction: effect.providerAction,
            unexecutedRemainder: { count: 0, reason: "none" }, outcome: result,
          },
        };
      } finally {
        if (crossed) {
          if (settled) this.registry.settleSnapshotMutation(context, request.scope);
          else this.registry.markUnknownCompletion(context, request.scope);
        }
        await this.release(request.scope, leases);
      }
    }
    if (providerSnapshot.kind !== "desktop" || desktopDimensions === null) {
      const result = outcome("resolve_target", { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", targetCondition: "unavailable", recovery: ["observe_again"] });
      return { ok: false, receipt: clickFailureReceipt(request, evidence, "not_completed", result), error: "This snapshot does not authorize a desktop click.", outcome: result };
    }
    const nativeX = request.operation.x * providerSnapshot.nativeWidth / desktopDimensions.width;
    const nativeY = request.operation.y * providerSnapshot.nativeHeight / desktopDimensions.height;
    if (request.operation.deliveryMode === "background") {
      const result = outcome("pre_effect_dispatch", { retrySafety: "safe", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "current", recovery: ["retry_same_request"] });
      return { ok: false, receipt: clickFailureReceipt(request, evidence, "not_completed", result),
        error: "A desktop-wide snapshot cannot deliver background input. Use foreground delivery, or observe the exact window for window-local background input. Nothing was clicked.", outcome: result };
    }
    const dispatchHumanControl = await this.assertContextHumanControl(context, request.scope);
    if (dispatchHumanControl !== "current") {
      const result = outcome("pre_effect_dispatch", {
        retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again"],
        ...(dispatchHumanControl === "external_interference" ? { externalInterference: "user_input" as const } : {}),
      });
      return {
        ok: false,
        receipt: clickFailureReceipt(request, evidence, "not_completed", result),
        error: dispatchHumanControl === "external_interference"
          ? "Local input interrupted the desktop operation. Observe again before acting."
          : "Desktop human-input state could not be read. Observe again before acting.",
        outcome: result,
      };
    }
    const pointerOptions: CuaPixelClickOptions = {
      ...(request.operation.button === undefined ? {} : { button: request.operation.button }),
      ...(request.operation.count === undefined ? {} : { count: request.operation.count }),
      ...(request.operation.modifiers === undefined ? {} : { modifiers: request.operation.modifiers }),
    };
    const finalHumanControl: { state: "current" | "external_interference" | "unavailable" } = { state: "current" };
    const clicked = await this.port.clickDesktop(request.scope, nativeX, nativeY, request.signal, pointerOptions, async () => {
      finalHumanControl.state = await this.assertContextHumanControl(context, request.scope);
      return finalHumanControl.state === "current";
    });
    if (!clicked.ok && clicked.stage === "session") {
      const result = outcome("pre_effect_dispatch", {
        retrySafety: clicked.code === "cancelled" ? "safe" : "observe_before_retry",
        stateChangeCertainty: "not_changed",
        providerCondition: clicked.code === "cancelled" ? "cancelled" : "unknown",
        targetCondition: "current",
        recovery: clicked.code === "cancelled" ? ["retry_same_request"] : ["observe_again"],
        ...(finalHumanControl.state === "external_interference" ? { externalInterference: "user_input" as const } : {}),
      });
      return { ok: false, receipt: clickFailureReceipt(request, evidence, "not_completed", result), error: finalHumanControl.state === "external_interference"
        ? "Local input interrupted the desktop operation before dispatch. Observe again before acting."
        : "Cua could not begin the exact desktop click.", outcome: result };
    }
    if (!clicked.ok) {
      this.registry.markUnknownCompletion(context, request.scope);
      const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: "unknown", providerCondition: "unknown", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
      return { ok: false, receipt: clickFailureReceipt(request, evidence, "unknown_completion", result), error: "Desktop click completion is unknown. Observe again; do not replay it.", outcome: result };
    }
    try {
      // Global HID advances the same system signal used to detect Human
      // takeover. Without a separate signed agent-input rearm primitive we
      // cannot distinguish our own click from intervening local input after
      // this point. Retire the snapshot. Cua did report delivery of this
      // exact global-input action, so preserve that completion fact, while
      // the resulting desktop state remains unknown and non-replayable.
      this.registry.retireMutationCapabilities(context, request.scope);
      const result = outcome("post_effect_verification", { retrySafety: "never", stateChangeCertainty: "unknown", providerCondition: "ready", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] });
      return {
        ok: true,
        receipt: {
          version: 1, timing: "immediate", action: "click",
          target: { version: 1, context, reference }, resolvedTarget: evidence, provider: "cua",
          // The pinned ActionResult says global input with delivery not-applicable;
          // do not relabel that as foreground delivery or a verified effect.
          deliveryMode: "not_applicable", completionCertainty: "completed", verification: "not_verified",
          providerAction: {
            effect: "unverifiable", route: "global_input", delivery: { mode: "not_applicable" }, evidenceKinds: [], escalation: null,
          },
          unexecutedRemainder: { count: 0, reason: "none" }, outcome: result,
        },
      };
    } finally {
      await this.port.endContextLease(request.scope, clicked.generation, clicked.sessionId);
    }
  }
}

function verifiedExactFocus(result: CuaContextToolResult | null, pid: number, windowId: number): boolean {
  const data = result === null ? null : structured(result);
  const effect = data === null ? null : record(data["exact_window_effect"]);
  const observed = data === null ? null : record(data["observed"]);
  const path = data?.["path"];
  return result?.isError === false
    && data !== null && exactVerifyKeys(data, ["activated", "code", "exact_window_effect", "observed", "path", "pid", "process_activated", "request_accepted", "status", "window_id"])
    && effect !== null && exactVerifyKeys(effect, ["focused", "frontmost_ordinary", "target_visible_ordinary", "verified"])
    && observed !== null && exactVerifyKeys(observed, ["focused_window_id", "front_process_matches_target", "frontmost_ordinary_window_id", "frontmost_pid", "workspace_frontmost_pid"])
    && typeof path === "string" && ["skylight_process_exact_cocoa_ax", "skylight_process_exact", "skylight_process_ax", "skylight_process", "skylight_exact_cocoa_ax", "skylight_exact", "cocoa_ax", "cocoa", "ax", "none"].includes(path)
    && data["status"] === "activated"
    && data["code"] === "bring_to_front_exact_window_verified"
    && data["pid"] === pid
    && data["window_id"] === windowId
    && data["activated"] === true
    && data["request_accepted"] === true
    && data["process_activated"] === true
    && effect?.["verified"] === true
    && effect["focused"] === true
    && effect["frontmost_ordinary"] === true
    && effect["target_visible_ordinary"] === true
    && observed["frontmost_pid"] === pid
    && observed["focused_window_id"] === windowId
    && observed["frontmost_ordinary_window_id"] === windowId
    && (observed["workspace_frontmost_pid"] === null || Number.isSafeInteger(observed["workspace_frontmost_pid"]))
    && (observed["front_process_matches_target"] === null || typeof observed["front_process_matches_target"] === "boolean");
}

/**
 * Pinned Cua 0.23.2 can report this exact partial family when its transparent
 * cursor-overlay surface is above an otherwise focused exact app window. This
 * predicate alone is never success; focus() additionally requires a fresh,
 * same-session, non-degraded exact-window state response.
 */
function exactFocusedWindowWithFrontmostSurfaceUnverified(result: CuaContextToolResult, pid: number, windowId: number): boolean {
  const data = result.structuredContent;
  const effect = data === null ? null : record(data["exact_window_effect"]);
  const observed = data === null ? null : record(data["observed"]);
  const path = data?.["path"];
  return result.isError === true
    && data !== null && exactVerifyKeys(data, ["activated", "code", "exact_window_effect", "observed", "path", "pid", "process_activated", "request_accepted", "status", "window_id"])
    && effect !== null && exactVerifyKeys(effect, ["focused", "frontmost_ordinary", "target_visible_ordinary", "verified"])
    && observed !== null && exactVerifyKeys(observed, ["focused_window_id", "front_process_matches_target", "frontmost_ordinary_window_id", "frontmost_pid", "workspace_frontmost_pid"])
    && typeof path === "string" && ["skylight_process_exact_cocoa_ax", "skylight_process_exact", "skylight_process_ax", "skylight_process", "skylight_exact_cocoa_ax", "skylight_exact", "cocoa_ax", "cocoa", "ax", "none"].includes(path)
    && data["status"] === "partial" && data["code"] === "bring_to_front_exact_window_unverified"
    && data["pid"] === pid && data["window_id"] === windowId
    && data["activated"] === false && data["request_accepted"] === true && data["process_activated"] === true
    && effect["verified"] === false && effect["focused"] === true && effect["frontmost_ordinary"] === false
    && effect["target_visible_ordinary"] === true
    && observed["frontmost_pid"] === pid && observed["front_process_matches_target"] === true
    && observed["focused_window_id"] === windowId
    && positiveInteger(observed["frontmost_ordinary_window_id"]) !== undefined
    && observed["frontmost_ordinary_window_id"] !== windowId
    && (observed["workspace_frontmost_pid"] === null || observed["workspace_frontmost_pid"] === pid);
}

/**
 * The pinned driver identifies these exact, request-unaccepted refusals before
 * it can deliver a focus. Every other error remains ambiguous after dispatch.
 */
function typedFocusRefusal(result: CuaContextToolResult, pid: number, windowId: number): boolean {
  if (!result.isError) return false;
  const data = result.structuredContent;
  if (data === null || data["pid"] !== pid || data["activated"] !== false || data["request_accepted"] !== false) return false;
  switch (data["code"]) {
    case "bring_to_front_pid_not_found":
      return exactVerifyKeys(data, ["activated", "code", "pid", "request_accepted"]);
    case "bring_to_front_window_id_out_of_range":
    case "bring_to_front_window_not_found":
      return exactVerifyKeys(data, ["activated", "code", "pid", "request_accepted", "window_id"])
        && data["window_id"] === windowId;
    case "bring_to_front_window_pid_mismatch":
      return exactVerifyKeys(data, ["activated", "code", "owner_pid", "pid", "request_accepted", "window_id"])
        && data["window_id"] === windowId && Number.isSafeInteger(data["owner_pid"])
        && (data["owner_pid"] as number) > 0 && data["owner_pid"] !== pid;
    case "bring_to_front_window_not_ordinary":
      return exactVerifyKeys(data, ["activated", "code", "layer", "pid", "request_accepted", "window_id"])
        && data["window_id"] === windowId && Number.isSafeInteger(data["layer"]) && data["layer"] !== 0;
    default:
      return false;
  }
}
