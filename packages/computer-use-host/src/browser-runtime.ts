import { randomBytes } from "node:crypto";

import {
  BROWSER_CONTRACT_SCHEMAS,
  COMPUTER_USE_BROWSER_CONTRACTS,
  type ComputerBrowserFailure,
  type ComputerBrowserRecoveryAction,
  type ComputerBrowserTabReference,
  type ComputerBrowserTargetReference,
} from "@nautilo/computer-use-contracts";
import type { ComputerUseHostAuthorityScope, ComputerUseHostContract, ComputerUseJson, ComputerUseSettlement } from "@nautilo/computer-use-host-protocol";

import type { CuaToolClient, CuaToolResult } from "./cua-client.js";
import type { ComputerUseContextRegistry } from "./native-context-registry.js";
import type { NativeComputerUseScopeFactory } from "./native-contract-runtime.js";
import {
  COMPUTER_USE_WORKSTATION_STATE_RESOURCE,
  ComputerUseCoordinationAbortError,
  ComputerUseResourceCoordinator,
  type ComputerUseResourceClaim,
} from "./resource-coordinator.js";
import type { ComputerUseContractHandler, ComputerUseContractHandlerResult } from "./runtime.js";

export type NativeWindowReference = Readonly<{ version: 1; context: string; reference: string }>;
export type NativeWindowHandle = Readonly<{ pid: number; windowId: number }>;
export type NativeWindowResolver = (
  reference: NativeWindowReference,
  authority: ComputerUseHostAuthorityScope,
) => NativeWindowHandle | null;
type RandomBytes = (size: number) => Uint8Array;
type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

type BrowserTab = {
  readonly public: ComputerBrowserTabReference;
  readonly cuaTabId: string;
  readonly title: string;
  readonly url: string;
  readonly active: boolean | null;
  busy: boolean;
  mutationAvailable: boolean;
};

type BrowserContext = {
  readonly context: string;
  readonly nativeBindingKey: string;
  readonly native: NativeWindowHandle;
  readonly authority: ComputerUseHostAuthorityScope;
  readonly session: string;
  readonly publicTarget: ComputerBrowserTargetReference;
  readonly cuaTargetId: string;
  readonly tabs: Map<string, BrowserTab>;
  busy: boolean;
};

type PendingBrowserPreparation = {
  readonly native: NativeWindowHandle;
  readonly authority: ComputerUseHostAuthorityScope;
  readonly session: string;
  busy: boolean;
  failure?: ComputerUseContractHandlerResult;
};

type BrowserPrepareSideEffects = Readonly<{
  launchedBrowser: boolean;
  restartedBrowser: boolean;
  createdProfile: boolean;
  reusedDriverProfile: boolean;
  copiedProfileData: boolean;
  changedPreferences: boolean;
  displayedConsentPrompt: boolean;
  openedSetupPage: boolean;
  closedSetupPage: boolean;
  enabledRemoteDebugging: boolean;
  usedBoundedPixelFallback: boolean;
  focusedSetupAddressField: boolean;
  foregroundedWindow: boolean;
  injectedGlobalInput: boolean;
}>;

type BrowserBinding = Readonly<{
  targetId: string;
  tabs: readonly Readonly<{ tabId: string; title: string; url: string; active: boolean | null }>[];
}>;

type PrivateElement = Readonly<{
  tab: BrowserTab;
  cuaRef: string;
  actions: ReadonlySet<"click" | "type" | "pointer" | "scroll">;
}>;
type PrivateContent = Readonly<{ tab: BrowserTab; cuaRef: string }>;
type PrivateContinuation = Readonly<{ tab: BrowserTab; cuaContinuation: string }>;
type PrivateDialog = Readonly<{ tab: BrowserTab; cuaDialogId: string; kind: "alert" | "confirm" | "prompt" | "beforeunload" }>;

const CUA_BROWSER_REFUSAL_CODES = new Set([
  "browser_route_unavailable",
  "browser_requires_setup",
  "browser_binding_ambiguous",
  "browser_binding_stale",
  "browser_wrong_target_refused",
  "browser_tab_required",
  "browser_tab_not_found",
  "browser_ref_stale",
  "browser_input_trust_unavailable",
  "browser_endpoint_owner_mismatch",
  "browser_consent_required",
  "browser_consent_revoked",
  "browser_reconnect_exhausted",
  "browser_input_incomplete",
  "browser_action_unavailable",
  "browser_origin_outside_scope",
]);

export const CUA_BROWSER_PRIMITIVE_EFFECT = {
  start_session: "read",
  end_session: "read",
  browser_prepare: "sensitive",
  get_browser_state: "read",
  browser_navigate: "mutate",
  browser_click: "mutate",
  browser_type: "mutate",
  browser_pointer: "mutate",
  browser_dialog: "mutate",
  list_windows: "read",
  bring_to_front: "mutate",
  hotkey: "mutate",
  type_text: "mutate",
  press_key: "mutate",
} as const;

export const COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES = {
  bindWindow: ["start_session", "get_browser_state", "end_session"],
  prepare: ["start_session", "browser_prepare", "get_browser_state", "end_session"],
  readPage: ["get_browser_state"],
  openUrl: ["get_browser_state", "bring_to_front", "list_windows", "hotkey", "type_text", "press_key", "browser_navigate"],
  navigate: ["browser_navigate"],
  click: ["browser_click"],
  type: ["browser_type"],
  pointer: ["browser_pointer"],
  dialog: ["browser_dialog"],
} as const;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function exactKeys(value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

/** Provider responses are forward-additive; only required known invariants are authoritative. */
function hasKeys(value: Readonly<Record<string, unknown>>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}

function safeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nativeKey(value: NativeWindowReference): string {
  return `${value.context}\u0000${value.reference}`;
}

function publicKey(value: Readonly<{ context: string; reference: string }>): string {
  return `${value.context}\u0000${value.reference}`;
}

function sameAuthority(left: ComputerUseHostAuthorityScope, right: ComputerUseHostAuthorityScope): boolean {
  return left.authorityLeaseId === right.authorityLeaseId && left.authorityGeneration === right.authorityGeneration;
}

function randomReference(prefix: string, random: RandomBytes): string {
  const encoded = Buffer.from(random(32)).toString("base64url");
  if (encoded.length !== 43) throw new Error("opaque_reference_entropy_failure");
  return `${prefix}_${encoded}`;
}

function asResult(value: Readonly<Record<string, unknown>>): Readonly<Record<string, ComputerUseJson>> {
  return value as unknown as Readonly<Record<string, ComputerUseJson>>;
}

function settled(settlement: ComputerUseSettlement, value: Readonly<Record<string, unknown>>): ComputerUseContractHandlerResult {
  return { settlement, result: asResult(value) };
}

function recoveryForRefusal(code: string, nextAction: string | null = null): ComputerBrowserRecoveryAction {
  // A fresh observation cannot repair setup selection or endpoint ownership.
  // Offer the independent native route, not another identical preparation.
  if (code === "browser_wrong_target_refused" || code === "browser_endpoint_owner_mismatch") return "use_native_window";
  if (nextAction === "browser_prepare") return "prepare_browser";
  if (code === "browser_requires_setup") return "prepare_browser";
  if (code === "browser_consent_required" || code === "browser_consent_revoked") return "request_access";
  if (code === "browser_route_unavailable" || code === "browser_input_trust_unavailable" || code === "browser_action_unavailable") {
    return "use_native_window";
  }
  return "observe_again";
}

function refusal(result: CuaToolResult): Readonly<{ code: string; deliveryUnknown: boolean; nextAction: string | null; setupControlAmbiguous: boolean }> | null {
  const structured = result.structuredContent;
  if (structured === null || !hasKeys(structured, ["status", "refusal"]) || structured["status"] !== "refused") return null;
  const value = record(structured["refusal"]);
  if (value === null || !hasKeys(value, ["code", "message"]) || typeof value["code"] !== "string"
    || !CUA_BROWSER_REFUSAL_CODES.has(value["code"]) || typeof value["message"] !== "string") return null;
  const detail = value["detail"] === undefined ? null : record(value["detail"]);
  return {
    code: value["code"],
    deliveryUnknown: detail?.["delivery"] === "unknown",
    nextAction: typeof detail?.["next_action"] === "string" ? detail["next_action"] : null,
    // Both reviewed setup_ui::new_tab_button variants return before AXPress. Do not
    // classify every wrong-target refusal as this particular pre-effect case.
    setupControlAmbiguous: value["code"] === "browser_wrong_target_refused"
      && (value["message"] === 'multiple exact AXButton controls matched "New Tab"'
        || value["message"] === "multiple distinct native New Tab buttons matched"),
  };
}

const BROWSER_FAILURE_REASON: Readonly<Record<string, ComputerBrowserFailure["reason"]>> = {
  browser_route_unavailable: "route_unavailable",
  browser_requires_setup: "setup_required",
  browser_binding_ambiguous: "target_ambiguous",
  browser_binding_stale: "target_stale",
  browser_wrong_target_refused: "wrong_target",
  browser_tab_required: "tab_required",
  browser_tab_not_found: "tab_unavailable",
  browser_ref_stale: "target_stale",
  browser_input_trust_unavailable: "input_trust_unavailable",
  browser_endpoint_owner_mismatch: "endpoint_identity_mismatch",
  browser_consent_required: "access_required",
  browser_consent_revoked: "access_revoked",
  browser_reconnect_exhausted: "connection_lost",
  browser_input_incomplete: "input_incomplete",
  browser_action_unavailable: "action_unavailable",
  browser_origin_outside_scope: "outside_scope",
};

function browserFailure(
  parsed: ReturnType<typeof refusal>,
  stage: ComputerBrowserFailure["stage"],
  stateChangeCertainty: ComputerBrowserFailure["stateChangeCertainty"],
): ComputerBrowserFailure {
  const reason = parsed === null ? "invalid_provider_response"
    : stage === "prepare" && parsed.setupControlAmbiguous ? "setup_control_ambiguous"
      : BROWSER_FAILURE_REASON[parsed.code] ?? "invalid_provider_response";
  const recovery = parsed === null ? null : recoveryForRefusal(parsed.code, parsed.nextAction);
  const retryCondition: ComputerBrowserFailure["retryCondition"] = stateChangeCertainty !== "not_changed"
    ? "inspect_effects_before_continuing"
    : recovery === "prepare_browser" ? "preparation_required"
      : recovery === "request_access" ? "access_required"
        : recovery === "use_native_window" || reason === "invalid_provider_response" || reason === "outside_scope"
          || reason === "connection_lost" ? "route_or_provider_change" : "fresh_target";
  return { reason, stage, stateChangeCertainty, retryCondition };
}

function readRecovery(result: CuaToolResult, stage: "bind" | "read" = "read"): ComputerUseContractHandlerResult {
  const value = record(result.structuredContent?.["refusal"]);
  // Cua's protected-page preflight wraps a failed live-document read as an
  // authorization-host error. This does not prove denial, discard, or a broken
  // driver. Offer native inspection of the existing tab, never a hidden reload.
  if (stage === "read" && result.structuredContent?.["status"] === "refused"
    && value?.["code"] === "authorization_host_failed"
    && typeof value["message"] === "string"
    && value["message"].startsWith("confirmation provider failed: could not prove the live top-level browser document: ")) {
    return settled("not_completed", {
      status: "recovery_required", recovery: "use_native_window",
      failure: { reason: "page_unavailable", stage, stateChangeCertainty: "not_changed", retryCondition: "route_or_provider_change" },
    });
  }
  const parsed = refusal(result);
  const recovery = parsed === null ? "observe_again" : recoveryForRefusal(parsed.code, parsed.nextAction);
  return settled(parsed === null ? "failed" : "not_completed", {
    status: "recovery_required", recovery, failure: browserFailure(parsed, stage, "not_changed"),
  });
}

function mutationRecovery(result: CuaToolResult): ComputerUseContractHandlerResult {
  const parsed = refusal(result);
  if (parsed === null || parsed.deliveryUnknown || parsed.code === "browser_input_incomplete") {
    return settled("unknown_completion", {
      status: "unknown_completion", observeAgain: true, doNotReplay: true,
      failure: browserFailure(parsed, "action", "unknown"),
    });
  }
  return settled("not_completed", {
    status: "not_delivered",
    observeAgain: true,
    doNotReplay: true,
    recovery: recoveryForRefusal(parsed.code, parsed.nextAction),
    failure: browserFailure(parsed, "action", "not_changed"),
  });
}

function prepareFailure(result: CuaToolResult): ComputerUseContractHandlerResult {
  const parsed = refusal(result);
  if (parsed === null || parsed.deliveryUnknown) {
    return settled("unknown_completion", {
      status: "unknown_completion", observeAgain: true, doNotReplay: true,
      failure: browserFailure(parsed, "prepare", "unknown"),
    });
  }
  const refusalValue = record(result.structuredContent?.["refusal"]);
  const detail = refusalValue === null ? null : record(refusalValue["detail"]);
  const setup = detail === null ? null : record(detail["setup_side_effects"]);
  if (detail !== null && Object.hasOwn(detail, "setup_side_effects") && setup === null) {
    return settled("unknown_completion", {
      status: "unknown_completion", observeAgain: true, doNotReplay: true,
      failure: browserFailure(parsed, "prepare", "unknown"),
    });
  }
  if (setup !== null) {
    const expected = [
      "opened_setup_page", "closed_setup_page", "focused_setup_address_field", "enabled_remote_debugging",
      "used_bounded_pixel_fallback", "foregrounded_window", "injected_global_input",
    ];
    // abort() adds rollback evidence. A successful restoration can also mean
    // nothing needed restoring, so it is not itself evidence of a mutation.
    const valid = hasKeys(setup, expected)
      && Object.keys(setup).every((key) => expected.includes(key) || key === "restored_remote_debugging")
      && Object.values(setup).every((effect) => typeof effect === "boolean");
    if (!valid || expected.some((key) => setup[key] === true)) {
      return settled("unknown_completion", {
        status: "unknown_completion", observeAgain: true, doNotReplay: true,
        failure: browserFailure(parsed, "prepare", valid ? "changed" : "unknown"),
      });
    }
  }
  // An absent effects record is not general proof of non-delivery. The exact
  // selector refusal above is a source-proven pre-AXPress exception.
  if (setup === null && !parsed.setupControlAmbiguous) {
    return settled("unknown_completion", {
      status: "unknown_completion", observeAgain: true, doNotReplay: true,
      failure: browserFailure(parsed, "prepare", "unknown"),
    });
  }
  return settled("not_completed", {
    status: "recovery_required", recovery: recoveryForRefusal(parsed.code, parsed.nextAction), observeAgain: true, doNotReplay: true,
    failure: browserFailure(parsed, "prepare", "not_changed"),
  });
}

type CuaActionResult = Readonly<{
  effect: "confirmed" | "partial" | "unverifiable" | "suspected_noop" | "refused";
  route: "accessibility" | "synthetic_events" | "global_input" | "system_api" | "dom" | "trusted_input";
  delivery: Readonly<{ mode: "background" | "foreground" | "not_applicable" | "unknown"; deliveredCount: number | null }> | null;
  escalation: Readonly<{
    target: "pixel" | "foreground" | "page" | "session";
    reason: "route_unavailable" | "delivery_failed" | "effect_unconfirmed" | "suspected_noop" | "permission_required";
  }> | null;
}>;

function parseActionResult(result: CuaToolResult): CuaActionResult | null {
  const value = result.structuredContent;
  if (value === null || !hasKeys(value, ["effect", "route"])
    || !["confirmed", "partial", "unverifiable", "suspected_noop", "refused"].includes(String(value["effect"]))
    || !["accessibility", "synthetic_events", "global_input", "system_api", "dom", "trusted_input"].includes(String(value["route"]))) return null;
  const delivery = value["delivery"] === undefined ? null : record(value["delivery"]);
  if (value["delivery"] !== undefined && (delivery === null || !hasKeys(delivery, ["mode"])
    || !["background", "foreground", "not_applicable", "unknown"].includes(String(delivery["mode"]))
    || (delivery["delivered_count"] !== undefined && !safeNonnegativeInteger(delivery["delivered_count"])))) return null;
  const evidence = value["evidence"];
  if (evidence !== undefined && (!Array.isArray(evidence) || evidence.some((raw) => {
    const item = record(raw);
    return item === null || !hasKeys(item, ["kind"])
      || (item["kind"] !== "value_readback" && item["kind"] !== "window_change");
  }))) return null;
  const escalation = value["escalation"] === undefined ? null : record(value["escalation"]);
  if (value["escalation"] !== undefined && (escalation === null || !hasKeys(escalation, ["target", "reason"])
    || !["pixel", "foreground", "page", "session"].includes(String(escalation["target"]))
    || !["route_unavailable", "delivery_failed", "effect_unconfirmed", "suspected_noop", "permission_required"].includes(String(escalation["reason"])))) return null;
  const effect = value["effect"] as CuaActionResult["effect"];
  if (result.isError && effect !== "refused") return null;
  if ((effect === "confirmed" && (!Array.isArray(evidence) || evidence.length === 0))
    || (effect === "partial" && delivery?.["delivered_count"] === undefined)
    || (effect === "refused" && (delivery !== null || evidence !== undefined))) return null;
  return {
    effect,
    route: value["route"] as CuaActionResult["route"],
    delivery: delivery === null ? null : {
      mode: delivery["mode"] as NonNullable<CuaActionResult["delivery"]>["mode"],
      deliveredCount: delivery["delivered_count"] === undefined ? null : delivery["delivered_count"] as number,
    },
    escalation: escalation === null ? null : {
      target: escalation["target"] as NonNullable<CuaActionResult["escalation"]>["target"],
      reason: escalation["reason"] as NonNullable<CuaActionResult["escalation"]>["reason"],
    },
  };
}

function actionRecovery(action: CuaActionResult): ComputerBrowserRecoveryAction {
  if (action.escalation?.reason === "permission_required") return "request_access";
  if (action.escalation?.target === "session") return "prepare_browser";
  if (action.escalation?.target === "foreground" || action.escalation?.target === "pixel") return "use_native_window";
  return "observe_again";
}

function deliveredMutation(): ComputerUseContractHandlerResult {
  return settled("completed", { status: "delivered", observeAgain: true, doNotReplay: true });
}

function classifyActionMutation(
  result: CuaToolResult,
  expectedRoute: CuaActionResult["route"],
  expectedDeliveredCount?: number,
): ComputerUseContractHandlerResult {
  const action = parseActionResult(result);
  if (action === null && result.structuredContent?.["effect"] === undefined && refusal(result) !== null) return mutationRecovery(result);
  if (action === null || action.route !== expectedRoute) {
    return settled("unknown_completion", { status: "unknown_completion", observeAgain: true, doNotReplay: true });
  }
  if (action.effect === "refused") {
    const recovery = actionRecovery(action);
    const failure: ComputerBrowserFailure = {
      reason: action.escalation?.reason === "permission_required" ? "access_required"
        : action.escalation?.reason === "route_unavailable" ? "route_unavailable" : "action_unavailable",
      stage: "action", stateChangeCertainty: "not_changed",
      retryCondition: recovery === "request_access" ? "access_required"
        : recovery === "prepare_browser" ? "preparation_required"
          : recovery === "use_native_window" ? "route_or_provider_change" : "fresh_target",
      ...(action.route === "trusted_input" ? { inputRoute: "trusted" as const }
        : action.route === "dom" ? { inputRoute: "dom_event" as const } : {}),
      ...(action.escalation === null ? {} : { escalation: action.escalation }),
    };
    return settled("not_completed", {
      status: "not_delivered", observeAgain: true, doNotReplay: true, recovery, failure,
    });
  }
  if (action.delivery === null || action.delivery.mode === "unknown" || action.effect === "partial"
    || (expectedDeliveredCount !== undefined && action.delivery.deliveredCount !== expectedDeliveredCount)) {
    return settled("unknown_completion", { status: "unknown_completion", observeAgain: true, doNotReplay: true });
  }
  return deliveredMutation();
}

function assertPrimitiveDominance(contract: ComputerUseHostContract, primitives: readonly (keyof typeof CUA_BROWSER_PRIMITIVE_EFFECT)[]): void {
  const rank = { read: 0, mutate: 1, sensitive: 2 } as const;
  if (primitives.some((primitive) => rank[CUA_BROWSER_PRIMITIVE_EFFECT[primitive]] > rank[contract.effectClass])) {
    throw new Error(`contract ${contract.contractId} understates a reachable Cua primitive`);
  }
}

export class PrivateComputerUseTargetRegistry {
  readonly #nativeWindows = new Map<string, Readonly<{ handle: NativeWindowHandle; authority: ComputerUseHostAuthorityScope }>>();

  registerWindow(reference: NativeWindowReference, handle: NativeWindowHandle, authority: ComputerUseHostAuthorityScope): void {
    if (!Number.isSafeInteger(handle.pid) || handle.pid < 1 || !Number.isSafeInteger(handle.windowId) || handle.windowId < 1) {
      throw new Error("invalid_native_window_handle");
    }
    this.#nativeWindows.set(nativeKey(reference), { handle, authority });
  }

  retireWindow(reference: NativeWindowReference): void {
    this.#nativeWindows.delete(nativeKey(reference));
  }

  resolveWindow(reference: NativeWindowReference, authority: ComputerUseHostAuthorityScope): NativeWindowHandle | null {
    const retained = this.#nativeWindows.get(nativeKey(reference));
    return retained !== undefined && sameAuthority(retained.authority, authority) ? retained.handle : null;
  }
}

/**
 * Resolve an opaque native-observation window capability directly from the
 * Host-owned registry. The private pid/window tuple never enters a public
 * contract or a second capability map, and the native registry remains the
 * single owner of expiry, replay, authority, and generation fencing.
 */
export function createNativeRegistryWindowResolver(
  registry: ComputerUseContextRegistry,
  scopeForAuthority: NativeComputerUseScopeFactory,
): NativeWindowResolver {
  return (reference, authority) => {
    const resolved = registry.resolveTarget(
      reference.context,
      scopeForAuthority(authority),
      reference.reference,
    );
    if (!resolved.ok
      || resolved.data.evidence.kind !== "window"
      || resolved.data.providerTarget.provider !== "cua"
      || resolved.data.providerTarget.operation !== "focus") return null;
    const { pid, windowId } = resolved.data.providerTarget;
    if (!Number.isSafeInteger(pid) || pid === undefined || pid < 1
      || !Number.isSafeInteger(windowId) || windowId === undefined || windowId < 1) return null;
    return { pid, windowId };
  };
}

export class CuaBrowserRuntime {
  readonly handlers: readonly ComputerUseContractHandler[];
  readonly targets: PrivateComputerUseTargetRegistry;
  readonly #client: CuaToolClient;
  readonly #resolveNativeWindow: NativeWindowResolver;
  readonly #random: RandomBytes;
  readonly #sleep: Sleep;
  readonly #coordinator: ComputerUseResourceCoordinator;
  readonly #contexts = new Map<string, BrowserContext>();
  readonly #contextsByNative = new Map<string, string>();
  readonly #pendingPreparations = new Map<string, PendingBrowserPreparation>();
  readonly #elements = new Map<string, PrivateElement>();
  readonly #contents = new Map<string, PrivateContent>();
  readonly #continuations = new Map<string, PrivateContinuation>();
  readonly #dialogs = new Map<string, PrivateDialog>();
  readonly #retiredNativeWindows = new Set<string>();
  #revoked = false;

  constructor(options: Readonly<{
    client: CuaToolClient;
    targets?: PrivateComputerUseTargetRegistry;
    resolveNativeWindow?: NativeWindowResolver;
    randomBytes?: RandomBytes;
    sleep?: Sleep;
    coordinator?: ComputerUseResourceCoordinator;
  }>) {
    this.#client = options.client;
    this.#random = options.randomBytes ?? randomBytes;
    this.#sleep = options.sleep ?? sleep;
    this.#coordinator = options.coordinator ?? new ComputerUseResourceCoordinator();
    this.targets = options.targets ?? new PrivateComputerUseTargetRegistry();
    this.#resolveNativeWindow = options.resolveNativeWindow
      ?? ((reference, authority) => this.targets.resolveWindow(reference, authority));
    const entries = [
      [COMPUTER_USE_BROWSER_CONTRACTS.bindWindow, COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES.bindWindow],
      [COMPUTER_USE_BROWSER_CONTRACTS.prepare, COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES.prepare],
      [COMPUTER_USE_BROWSER_CONTRACTS.readPage, COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES.readPage],
      [COMPUTER_USE_BROWSER_CONTRACTS.openUrl, COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES.openUrl],
      [COMPUTER_USE_BROWSER_CONTRACTS.navigate, COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES.navigate],
      [COMPUTER_USE_BROWSER_CONTRACTS.click, COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES.click],
      [COMPUTER_USE_BROWSER_CONTRACTS.type, COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES.type],
      [COMPUTER_USE_BROWSER_CONTRACTS.pointer, COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES.pointer],
      [COMPUTER_USE_BROWSER_CONTRACTS.dialog, COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES.dialog],
    ] as const;
    for (const [contract, primitives] of entries) assertPrimitiveDominance(contract, primitives);
    this.handlers = [
      { contract: COMPUTER_USE_BROWSER_CONTRACTS.bindWindow, execute: (args, context) => this.#bind(args, context.authority, context.signal) },
      { contract: COMPUTER_USE_BROWSER_CONTRACTS.prepare, execute: (args, context) => this.#prepare(args, context.authority, context.signal) },
      { contract: COMPUTER_USE_BROWSER_CONTRACTS.readPage, execute: (args, context) => this.#read(args, context.authority, context.signal) },
      { contract: COMPUTER_USE_BROWSER_CONTRACTS.openUrl, execute: (args, context) => this.#openUrl(args, context.authority, context.signal) },
      { contract: COMPUTER_USE_BROWSER_CONTRACTS.navigate, execute: (args, context) => this.#navigate(args, context.authority, context.signal) },
      { contract: COMPUTER_USE_BROWSER_CONTRACTS.click, execute: (args, context) => this.#click(args, context.authority, context.signal) },
      { contract: COMPUTER_USE_BROWSER_CONTRACTS.type, execute: (args, context) => this.#type(args, context.authority, context.signal) },
      { contract: COMPUTER_USE_BROWSER_CONTRACTS.pointer, execute: (args, context) => this.#pointer(args, context.authority, context.signal) },
      { contract: COMPUTER_USE_BROWSER_CONTRACTS.dialog, execute: (args, context) => this.#dialog(args, context.authority, context.signal) },
    ];
  }

  /** Authority/Host teardown deterministically closes every retained Cua session. */
  async close(): Promise<void> {
    this.revoke();
    const pending = [...this.#pendingPreparations.values()];
    this.#pendingPreparations.clear();
    await Promise.all([
      ...[...this.#contexts.values()].map((context) => this.#retireContext(context)),
      ...pending.map((preparation) => this.#client.callTool(
        "end_session",
        { session: preparation.session },
        { authority: preparation.authority },
      ).catch(() => undefined)),
    ]);
    this.#retiredNativeWindows.clear();
  }

  /** Synchronously prevent queued or late provider results from restoring authority. */
  revoke(): void {
    this.#revoked = true;
  }

  #resourceKey(kind: string, values: readonly unknown[]): string {
    return `computer-use:browser:${kind}:${JSON.stringify(values)}`;
  }

  #nativeWindowClaims(
    authority: ComputerUseHostAuthorityScope,
    native: NativeWindowHandle,
    workstationMode: "read" | "write",
  ): readonly ComputerUseResourceClaim[] {
    return [
      { key: COMPUTER_USE_WORKSTATION_STATE_RESOURCE, mode: workstationMode },
      {
        key: this.#resourceKey("native-window", [
          authority.authorityLeaseId, authority.authorityGeneration, native.pid, native.windowId,
        ]),
        mode: "write",
      },
    ];
  }

  #contextClaims(context: BrowserContext, workstationMode: "read" | "write"): readonly ComputerUseResourceClaim[] {
    return [
      { key: COMPUTER_USE_WORKSTATION_STATE_RESOURCE, mode: workstationMode },
      { key: this.#resourceKey("context", [context.context, context.session, context.cuaTargetId]), mode: "write" },
    ];
  }

  #tabClaims(context: BrowserContext, tab: BrowserTab, workstationMode: "read" | "write"): readonly ComputerUseResourceClaim[] {
    return [
      { key: COMPUTER_USE_WORKSTATION_STATE_RESOURCE, mode: workstationMode },
      { key: this.#resourceKey("context", [context.context, context.session, context.cuaTargetId]), mode: "read" },
      { key: this.#resourceKey("tab", [context.context, context.session, tab.cuaTabId]), mode: "write" },
    ];
  }

  async #coordinate(
    claims: readonly ComputerUseResourceClaim[],
    signal: AbortSignal,
    execute: () => Promise<ComputerUseContractHandlerResult>,
  ): Promise<ComputerUseContractHandlerResult> {
    try {
      return await this.#coordinator.withClaims(claims, signal, execute);
    } catch (error) {
      if (!(error instanceof ComputerUseCoordinationAbortError)) throw error;
      // Re-entering the admitted handler with an aborted signal preserves its
      // operation-specific public cancellation envelope without dispatching.
      return execute();
    }
  }

  async #bind(argumentsValue: Readonly<Record<string, ComputerUseJson>>, authority: ComputerUseHostAuthorityScope, signal: AbortSignal, coordinated = false): Promise<ComputerUseContractHandlerResult> {
    const parsed = BROWSER_CONTRACT_SCHEMAS.bindWindow.input.safeParse(argumentsValue);
    if (!parsed.success) return settled("fenced", { status: "recovery_required", recovery: "observe_again" });
    if (this.#revoked) return settled("not_completed", { status: "recovery_required", recovery: "observe_again" });
    if (this.#retiredNativeWindows.has(nativeKey(parsed.data.window))) {
      return settled("not_completed", { status: "recovery_required", recovery: "observe_again" });
    }
    const native = this.#resolveNativeWindow(parsed.data.window, authority);
    if (native === null || signal.aborted) return settled(signal.aborted ? "cancelled" : "not_completed", { status: "recovery_required", recovery: "observe_again" });
    if (!coordinated) return this.#coordinate(this.#nativeWindowClaims(authority, native, "write"), signal,
      () => this.#bind(argumentsValue, authority, signal, true));

    const nativeBindingKey = `${authority.authorityLeaseId}\u0000${authority.authorityGeneration}\u0000${native.pid}\u0000${native.windowId}`;
    const retainedId = this.#contextsByNative.get(nativeBindingKey);
    const retained = retainedId === undefined ? undefined : this.#contexts.get(retainedId);
    if (retained !== undefined) return this.#boundResult(retained, "bound");
    const pending = this.#pendingPreparations.get(nativeBindingKey);
    if (pending?.failure !== undefined) {
      // Reconcile in the lifecycle that performed setup. A new observation
      // reference must not create another setup attempt or discard its grant.
      const response = await this.#client.callTool("get_browser_state", {
        pid: native.pid, window_id: native.windowId, session: pending.session,
      }, { authority, signal }).catch(() => null);
      if (signal.aborted || this.#revoked) return settled(signal.aborted ? "cancelled" : "not_completed", {
        status: "recovery_required", recovery: "observe_again",
      });
      const binding = response === null ? null : this.#parseBinding(response);
      if (binding === null) {
        // Report this read's failure, but do not let a read-only refusal erase
        // the preceding setup's effects or authorize another preparation.
        const previous = record(pending.failure.result["failure"]);
        const certainty = previous?.["stateChangeCertainty"];
        const failure = browserFailure(response === null ? null : refusal(response), "bind",
          certainty === "changed" || certainty === "not_changed" ? certainty : "unknown");
        return settled("not_completed", {
          status: "recovery_required", recovery: "use_native_window",
          failure: response === null ? { ...failure, reason: "transport_unavailable" } : failure,
        });
      }
      const installed = await this.#installContext(native, nativeBindingKey, authority, pending.session, binding);
      if (installed === null) return settled("not_completed", { status: "recovery_required", recovery: "observe_again" });
      this.#pendingPreparations.delete(nativeBindingKey);
      return this.#boundResult(installed, "bound");
    }
    if (pending !== undefined) {
      return settled("not_completed", { status: "recovery_required", recovery: "prepare_browser" });
    }

    const session = randomReference("nautilo-browser", this.#random);
    const started = await this.#client.callTool("start_session", { session }, { authority, signal }).catch(() => null);
    if (started === null || started.isError) {
      return settled("failed", { status: "recovery_required", recovery: "observe_again" });
    }
    if (signal.aborted) {
      await this.#client.callTool("end_session", { session }, { authority, signal }).catch(() => undefined);
      return settled("cancelled", { status: "recovery_required", recovery: "observe_again" });
    }
    if (this.#revoked) {
      await this.#client.callTool("end_session", { session }, { authority, signal }).catch(() => undefined);
      return settled("not_completed", { status: "recovery_required", recovery: "observe_again" });
    }
    const response = await this.#client.callTool("get_browser_state", {
      pid: native.pid,
      window_id: native.windowId,
      session,
    }, { authority, signal }).catch(() => null);
    if (response === null) {
      await this.#client.callTool("end_session", { session }, { authority, signal }).catch(() => undefined);
      return settled("failed", { status: "recovery_required", recovery: "observe_again" });
    }
    if (signal.aborted) {
      await this.#client.callTool("end_session", { session }, { authority, signal }).catch(() => undefined);
      return settled("cancelled", { status: "recovery_required", recovery: "observe_again" });
    }
    if (this.#revoked) {
      await this.#client.callTool("end_session", { session }, { authority, signal }).catch(() => undefined);
      return settled("not_completed", { status: "recovery_required", recovery: "observe_again" });
    }
    const binding = this.#parseBinding(response);
    if (binding === null) {
      const outcome = readRecovery(response, "bind");
      if (outcome.settlement === "not_completed" && outcome.result["recovery"] === "prepare_browser") {
        this.#pendingPreparations.set(nativeBindingKey, { native, authority, session, busy: false });
        return outcome;
      }
      await this.#client.callTool("end_session", { session }, { authority, signal }).catch(() => undefined);
      return outcome;
    }

    const installed = await this.#installContext(native, nativeBindingKey, authority, session, binding);
    if (installed === null) {
      await this.#client.callTool("end_session", { session }, { authority, signal }).catch(() => undefined);
      return settled("not_completed", { status: "recovery_required", recovery: "observe_again" });
    }
    return this.#boundResult(installed, "bound");
  }

  async #prepare(argumentsValue: Readonly<Record<string, ComputerUseJson>>, authority: ComputerUseHostAuthorityScope, signal: AbortSignal, coordinated = false): Promise<ComputerUseContractHandlerResult> {
    const parsed = BROWSER_CONTRACT_SCHEMAS.prepare.input.safeParse(argumentsValue);
    const recovery = () => settled("not_completed" as const, {
      status: "recovery_required", recovery: "observe_again", observeAgain: true, doNotReplay: true,
    });
    if (!parsed.success) return settled("fenced", recovery().result);
    if (this.#revoked) return recovery();
    const nativeReference = nativeKey(parsed.data.window);
    const native = this.#resolveNativeWindow(parsed.data.window, authority);
    if (native === null || this.#retiredNativeWindows.has(nativeReference)) return recovery();
    if (signal.aborted) return settled("cancelled", recovery().result);
    if (!coordinated) return this.#coordinate(this.#nativeWindowClaims(authority, native, "write"), signal,
      () => this.#prepare(argumentsValue, authority, signal, true));

    const nativeBindingKey = `${authority.authorityLeaseId}\u0000${authority.authorityGeneration}\u0000${native.pid}\u0000${native.windowId}`;
    const retainedId = this.#contextsByNative.get(nativeBindingKey);
    const retained = retainedId === undefined ? undefined : this.#contexts.get(retainedId);
    if (retained !== undefined) {
      this.#retiredNativeWindows.add(nativeReference);
      return this.#preparedResult(retained, "already_prepared", this.#zeroPrepareSideEffects());
    }

    let pending = this.#pendingPreparations.get(nativeBindingKey);
    if (pending !== undefined && (!sameAuthority(pending.authority, authority)
      || pending.native.pid !== native.pid || pending.native.windowId !== native.windowId || pending.busy)) return recovery();
    if (pending?.failure !== undefined) return pending.failure;
    if (pending === undefined) {
      const session = randomReference("nautilo-browser", this.#random);
      const started = await this.#client.callTool("start_session", { session }, { authority, signal }).catch(() => null);
      if (started === null || started.isError) return settled("failed", recovery().result);
      if (signal.aborted || this.#revoked) {
        await this.#client.callTool("end_session", { session }, { authority, signal }).catch(() => undefined);
        return signal.aborted ? settled("cancelled", recovery().result) : recovery();
      }
      pending = { native, authority, session, busy: false };
      this.#pendingPreparations.set(nativeBindingKey, pending);
    }
    pending.busy = true;
    const session = pending.session;
    // Consume this observation. Changed/uncertain failures retain the session
    // for read-only reconciliation; proven pre-effect refusals can end cleanly.
    this.#retiredNativeWindows.add(nativeReference);
    let retainSession = false;
    const failed = (outcome: ComputerUseContractHandlerResult) => {
      pending.failure = outcome;
      retainSession = !this.#revoked;
      return outcome;
    };
    try {
      if (signal.aborted) return settled("cancelled", recovery().result);
      const response = await this.#client.callTool("browser_prepare", {
        pid: native.pid,
        window_id: native.windowId,
        strategy: { kind: "existing_profile" },
        session,
      }, { authority, signal }).catch(() => null);
      if (response === null) {
        return failed(settled("unknown_completion", {
          status: "unknown_completion", observeAgain: true, doNotReplay: true,
          failure: { ...browserFailure(null, "prepare", "unknown"), reason: "transport_unavailable" },
        }));
      }
      const prepared = this.#parsePrepared(response, native.pid);
      const afterPreparation = (reason: ComputerBrowserFailure["reason"], stage: "prepare" | "bind") => failed(settled("unknown_completion", {
        status: "unknown_completion", observeAgain: true, doNotReplay: true,
        failure: {
          ...browserFailure(null, stage, prepared === null ? "unknown"
            : Object.values(prepared.sideEffects).some(Boolean) ? "changed" : "not_changed"),
          reason, retryCondition: "inspect_effects_before_continuing",
        },
      }));
      if (this.#revoked) return afterPreparation("authority_revoked", "prepare");
      if (signal.aborted) return afterPreparation("cancelled", "prepare");
      if (prepared === null) {
        const outcome = prepareFailure(response);
        // Only prepareFailure's positively proven no-effect branch settles as
        // not_completed. Do not make that refusal a permanent per-window lock:
        // native recovery followed by a fresh observation may permit setup.
        return outcome.settlement === "not_completed" ? outcome : failed(outcome);
      }
      const bound = await this.#client.callTool("get_browser_state", {
        pid: native.pid,
        window_id: native.windowId,
        session,
      }, { authority, signal }).catch(() => null);
      if (bound === null) {
        return afterPreparation(signal.aborted ? "cancelled" : "transport_unavailable", "bind");
      }
      if (signal.aborted) return afterPreparation("cancelled", "bind");
      if (this.#revoked) return afterPreparation("authority_revoked", "bind");
      const binding = this.#parseBinding(bound);
      if (binding === null) {
        const failure = browserFailure(refusal(bound), "bind", "unknown");
        return afterPreparation(failure.reason, "bind");
      }
      const installed = await this.#installContext(native, nativeBindingKey, authority, session, binding);
      if (installed === null) return afterPreparation("authority_revoked", "bind");
      retainSession = true;
      return this.#preparedResult(installed, prepared.action, prepared.sideEffects);
    } finally {
      pending.busy = false;
      if ((!retainSession || pending.failure === undefined) && this.#pendingPreparations.get(nativeBindingKey) === pending) {
        this.#pendingPreparations.delete(nativeBindingKey);
      }
      if (!retainSession) await this.#client.callTool("end_session", { session }, { authority, signal }).catch(() => undefined);
    }
  }

  async #installContext(
    native: NativeWindowHandle,
    nativeBindingKey: string,
    authority: ComputerUseHostAuthorityScope,
    session: string,
    binding: Readonly<{
      targetId: string;
      tabs: readonly Readonly<{ tabId: string; title: string; url: string; active: boolean | null }>[];
    }>,
  ): Promise<BrowserContext | null> {
    if (this.#revoked) return null;
    const context = randomReference("dbctx", this.#random);
    const publicTarget = { version: 1, context, reference: randomReference("dbtgt", this.#random) } as const;
    const tabs = new Map<string, BrowserTab>();
    for (const tab of binding.tabs) {
      const target = { version: 1, context, reference: randomReference("dbtab", this.#random) } as const;
      tabs.set(publicKey(target), {
        public: target,
        cuaTabId: tab.tabId,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        busy: false,
        mutationAvailable: true,
      });
    }
    const previousId = this.#contextsByNative.get(nativeBindingKey);
    const previous = previousId === undefined ? undefined : this.#contexts.get(previousId);
    if (previous !== undefined) await this.#retireContext(previous);
    if (this.#revoked) return null;
    const installed = {
      context,
      nativeBindingKey,
      native,
      authority,
      session,
      publicTarget,
      cuaTargetId: binding.targetId,
      tabs,
      busy: false,
    } as const;
    this.#contexts.set(context, installed);
    this.#contextsByNative.set(nativeBindingKey, context);
    return installed;
  }

  #boundProjection(context: BrowserContext): Readonly<Record<string, unknown>> {
    return {
      target: context.publicTarget,
      bindingQuality: "exact",
      mutationAllowed: true,
      tabs: [...context.tabs.values()].map((tab) => ({
        target: tab.public,
        title: tab.title,
        url: tab.url,
        active: tab.active,
      })),
    };
  }

  #boundResult(context: BrowserContext, status: "bound"): ComputerUseContractHandlerResult {
    const checked = BROWSER_CONTRACT_SCHEMAS.bindWindow.result.safeParse({ status, ...this.#boundProjection(context) });
    if (!checked.success) throw new Error("browser_bind_projection_invalid");
    return settled("completed", checked.data);
  }

  #preparedResult(
    context: BrowserContext,
    action: "already_prepared" | "attached_existing_profile",
    sideEffects: BrowserPrepareSideEffects,
  ): ComputerUseContractHandlerResult {
    const checked = BROWSER_CONTRACT_SCHEMAS.prepare.result.safeParse({
      status: "prepared",
      action,
      sideEffects,
      doNotReplay: true,
      ...this.#boundProjection(context),
    });
    if (!checked.success) throw new Error("browser_prepare_projection_invalid");
    return settled("completed", checked.data);
  }

  #zeroPrepareSideEffects() {
    return {
      launchedBrowser: false,
      restartedBrowser: false,
      createdProfile: false,
      reusedDriverProfile: false,
      copiedProfileData: false,
      changedPreferences: false,
      displayedConsentPrompt: false,
      openedSetupPage: false,
      closedSetupPage: false,
      enabledRemoteDebugging: false,
      usedBoundedPixelFallback: false,
      focusedSetupAddressField: false,
      foregroundedWindow: false,
      injectedGlobalInput: false,
    } as const;
  }

  async #read(argumentsValue: Readonly<Record<string, ComputerUseJson>>, authority: ComputerUseHostAuthorityScope, signal: AbortSignal, coordinated = false): Promise<ComputerUseContractHandlerResult> {
    const parsed = BROWSER_CONTRACT_SCHEMAS.readPage.input.safeParse(argumentsValue);
    if (!parsed.success) return settled("fenced", { status: "recovery_required", recovery: "observe_again" });
    if (this.#revoked) return settled("not_completed", { status: "recovery_required", recovery: "observe_again" });
    const resolved = this.#resolveTab(parsed.data.target, parsed.data.tab, authority);
    if (resolved === null || signal.aborted) return settled(signal.aborted ? "cancelled" : "not_completed", { status: "recovery_required", recovery: "observe_again" });
    const { context, tab } = resolved;
    if (!coordinated) return this.#coordinate(this.#tabClaims(context, tab, "read"), signal,
      () => this.#read(argumentsValue, authority, signal, true));
    if (context.busy || tab.busy) return settled("fenced", { status: "recovery_required", recovery: "observe_again" });
    const scopeReference = "scope" in parsed.data ? parsed.data.scope : undefined;
    const continuationReference = "continuation" in parsed.data ? parsed.data.continuation : undefined;
    const query = "query" in parsed.data ? parsed.data.query : undefined;
    const scope = scopeReference === undefined ? undefined : this.#contents.get(publicKey(scopeReference));
    const continuation = continuationReference === undefined ? undefined : this.#continuations.get(publicKey(continuationReference));
    if ((scopeReference !== undefined && (scope === undefined || scope.tab !== tab))
      || (continuationReference !== undefined && (continuation === undefined || continuation.tab !== tab))) {
      return settled("not_completed", { status: "recovery_required", recovery: "observe_again" });
    }
    tab.busy = true;
    tab.mutationAvailable = false;
    this.#retireSnapshot(tab);
    try {
      const response = await this.#client.callTool("get_browser_state", {
        target_id: context.cuaTargetId,
        tab_id: tab.cuaTabId,
        session: context.session,
        snapshot_format: "semantic_v2",
        ...(query === undefined ? {} : { query }),
        ...(scope === undefined ? {} : { scope_ref: scope.cuaRef }),
        ...(continuation === undefined ? {} : { continuation: continuation.cuaContinuation }),
      }, { authority, signal }).catch(() => null);
      if (response === null) return settled("failed", { status: "recovery_required", recovery: "observe_again" });
      if (signal.aborted) return settled("cancelled", { status: "recovery_required", recovery: "observe_again" });
      if (this.#revoked) return settled("not_completed", { status: "recovery_required", recovery: "observe_again" });
      const snapshot = this.#parseSnapshot(response, context.cuaTargetId, tab.cuaTabId);
      if (snapshot === null) return readRecovery(response);

      const refs: Array<Readonly<Record<string, unknown>>> = [];
      for (const source of snapshot.actionRefs) {
        const actions = source.actions.filter((action): action is "click" | "type" | "pointer" | "scroll" => (
          action === "click" || action === "type" || action === "pointer" || action === "scroll"
        ));
        if (actions.length === 0) continue;
        const target = { version: 1, context: context.context, reference: randomReference("dbref", this.#random) } as const;
        this.#elements.set(publicKey(target), { tab, cuaRef: source.ref, actions: new Set(actions) });
        refs.push({ target, role: source.role, name: source.name, value: source.value, visibility: source.visibility, actions });
      }
      for (const source of snapshot.contentRefs) {
        const target = { version: 1, context: context.context, reference: randomReference("dbcontent", this.#random) } as const;
        this.#contents.set(publicKey(target), { tab, cuaRef: source.ref });
        refs.push({ target, role: source.role, name: source.name, value: source.value, visibility: source.visibility, actions: [] });
      }
      const nextContinuation = snapshot.continuation === null
        ? null
        : { version: 1, context: context.context, reference: randomReference("dbcont", this.#random) } as const;
      if (nextContinuation !== null && snapshot.continuation !== null) {
        this.#continuations.set(publicKey(nextContinuation), { tab, cuaContinuation: snapshot.continuation });
      }
      tab.mutationAvailable = true;
      const value = {
        status: "observed",
        target: context.publicTarget,
        tab: tab.public,
        page: snapshot.page,
        outline: snapshot.outline,
        refs,
        snapshot: { complete: snapshot.complete, omitted: snapshot.omitted, continuation: nextContinuation },
      } as const;
      const checked = BROWSER_CONTRACT_SCHEMAS.readPage.result.safeParse(value);
      if (!checked.success) throw new Error("browser_snapshot_projection_invalid");
      return settled("completed", checked.data);
    } finally {
      tab.busy = false;
    }
  }

  async #openUrl(argumentsValue: Readonly<Record<string, ComputerUseJson>>, authority: ComputerUseHostAuthorityScope, signal: AbortSignal, coordinated = false): Promise<ComputerUseContractHandlerResult> {
    const parsed = BROWSER_CONTRACT_SCHEMAS.openUrl.input.safeParse(argumentsValue);
    if (!parsed.success) return this.#openNotDelivered("observe_again", "fenced");
    if (this.#revoked) return this.#openNotDelivered("observe_again");
    const initial = this.#resolveContext(parsed.data.target, authority);
    if (initial === null || signal.aborted) {
      return signal.aborted
        ? settled("cancelled", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" })
        : this.#openNotDelivered("observe_again");
    }
    if (!coordinated) return this.#coordinate(this.#contextClaims(initial, "write"), signal,
      () => this.#openUrl(argumentsValue, authority, signal, true));
    if (initial.busy || [...initial.tabs.values()].some((tab) => tab.busy)) return this.#openNotDelivered("observe_again", "fenced");

    let active = initial;
    let crossedTabBoundary = false;
    let retireInitial = false;
    initial.busy = true;
    for (const tab of initial.tabs.values()) {
      tab.busy = true;
      tab.mutationAvailable = false;
      this.#retireSnapshot(tab);
    }
    try {
      const baselineResponse = await this.#client.callTool("get_browser_state", {
        pid: initial.native.pid,
        window_id: initial.native.windowId,
        session: initial.session,
      }, { authority, signal }).catch(() => null);
      if (baselineResponse === null || signal.aborted) {
        return signal.aborted
          ? settled("cancelled", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" })
          : this.#openNotDelivered("observe_again", "failed");
      }
      const baseline = this.#parseBinding(baselineResponse);
      if (baseline === null) return readRecovery(baselineResponse);

      const foregrounded = await this.#client.callTool("bring_to_front", {
        pid: initial.native.pid,
        window_id: initial.native.windowId,
        session: initial.session,
      }, { authority, signal }).catch(() => null);
      if (foregrounded === null || signal.aborted) {
        return signal.aborted
          ? settled("cancelled", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" })
          : this.#openNotDelivered("observe_again");
      }
      const windows = await this.#client.callTool("list_windows", {
        pid: initial.native.pid,
        session: initial.session,
      }, { authority, signal }).catch(() => null);
      if (windows === null || signal.aborted) {
        return signal.aborted
          ? settled("cancelled", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" })
          : this.#openNotDelivered("observe_again", "failed");
      }
      if (!this.#exactWindowIsCurrent(windows, initial.native.windowId)) return this.#openNotDelivered("observe_again");

      const created = await this.#client.callTool("hotkey", {
        pid: initial.native.pid,
        window_id: initial.native.windowId,
        keys: ["cmd", "t"],
        delivery_mode: "foreground",
        session: initial.session,
      }, { authority, signal }).catch(() => null);
      const createdAttempt = created === null ? "unknown" : this.#nativeAttempt(created);
      if (createdAttempt === "refused") return this.#openNotDelivered("observe_again");
      if (createdAttempt === "unknown") {
        retireInitial = true;
        return this.#openUnknown();
      }
      crossedTabBoundary = true;

      // Foreground text synthesis under Chrome's omnibox can case-fold ASCII.
      // Keep the single-use marker lowercase while retaining over 200 bits of
      // private entropy, then require byte-exact readback before navigation.
      const markerReference = randomReference("nautilo", this.#random).slice("nautilo_".length).toLowerCase();
      const marker = `about:blank#nautilo-${markerReference}`;
      const nativeSequence: readonly Readonly<{ name: "bring_to_front" | "hotkey" | "type_text" | "press_key"; args: Readonly<Record<string, unknown>> }>[] = [
        {
          name: "bring_to_front",
          args: { pid: initial.native.pid, window_id: initial.native.windowId, session: initial.session },
        },
        {
          name: "hotkey",
          args: {
            pid: initial.native.pid, window_id: initial.native.windowId, keys: ["cmd", "l"],
            delivery_mode: "foreground", session: initial.session,
          },
        },
        {
          name: "type_text",
          args: {
            pid: initial.native.pid, window_id: initial.native.windowId, text: marker,
            delivery_mode: "foreground", session: initial.session,
          },
        },
        {
          name: "press_key",
          args: {
            pid: initial.native.pid, window_id: initial.native.windowId, key: "return", modifiers: [],
            delivery_mode: "foreground", session: initial.session,
          },
        },
      ];
      for (const [stepIndex, step] of nativeSequence.entries()) {
        if (signal.aborted) {
          retireInitial = true;
          return this.#openUnknown();
        }
        const response = await this.#client.callTool(step.name, step.args, { authority, signal }).catch(() => null);
        if (response === null || (step.name !== "bring_to_front" && response.isError)
          || (step.name !== "bring_to_front" && this.#nativeAttempt(response) !== "attempted")) {
          retireInitial = true;
          return this.#openUnknown();
        }
        if (stepIndex === 0) {
          const focusedWindows = await this.#client.callTool("list_windows", {
            pid: initial.native.pid,
            session: initial.session,
          }, { authority, signal }).catch(() => null);
          if (focusedWindows === null || !this.#exactWindowIsCurrent(focusedWindows, initial.native.windowId)) {
            retireInitial = true;
            return this.#openUnknown();
          }
        }
      }

      let rebound: BrowserBinding | null = null;
      let markerTabs: BrowserBinding["tabs"] = [];
      for (;;) {
        const reboundResponse = await this.#client.callTool("get_browser_state", {
          pid: initial.native.pid,
          window_id: initial.native.windowId,
          session: initial.session,
        }, { authority, signal }).catch(() => null);
        if (reboundResponse === null || signal.aborted) break;
        const candidate = this.#parseBinding(reboundResponse);
        if (candidate === null || candidate.tabs.length > baseline.tabs.length + 1) break;
        const candidates = candidate?.tabs.filter((tab) => tab.url === marker) ?? [];
        if (candidate !== null && candidate.tabs.length === baseline.tabs.length + 1 && candidates.length === 1) {
          rebound = candidate;
          markerTabs = candidates;
          break;
        }
        await this.#sleep(50, signal);
      }
      if (rebound === null || markerTabs.length !== 1) {
        retireInitial = true;
        return this.#openUnknown();
      }

      const reboundContext = this.#replaceContextSameSession(initial, rebound);
      if (reboundContext === null) return this.#openUnknown();
      active = reboundContext;
      active.busy = true;
      let selected = [...active.tabs.values()].find((tab) => tab.cuaTabId === markerTabs[0]!.tabId);
      if (selected === undefined) throw new Error("browser_open_marker_projection_invalid");
      selected.busy = true;
      selected.mutationAvailable = false;

      const markedUrl = new URL(parsed.data.url);
      markedUrl.hash = `nautilo-${markerReference}`;
      const markedDestination = markedUrl.toString();
      const navigated = await this.#client.callTool("browser_navigate", {
        target_id: active.cuaTargetId,
        tab_id: selected.cuaTabId,
        url: markedDestination,
        session: active.session,
      }, { authority, signal }).catch(() => null);
      if (navigated === null || signal.aborted) return this.#openUnknown(active, selected);
      const navigation = navigated.structuredContent;
      if (navigated.isError || navigation === null
        || !hasKeys(navigation, ["status", "target_id", "tab_id", "url", "refs_invalidated"])
        || navigation["status"] !== "ok" || navigation["target_id"] !== active.cuaTargetId
        || navigation["tab_id"] !== selected.cuaTabId || navigation["url"] !== markedDestination
        || navigation["refs_invalidated"] !== true) {
        return this.#openUnknown(active, selected);
      }

      let markedBinding: BrowserBinding | null = null;
      let markedTabs: BrowserBinding["tabs"] = [];
      for (;;) {
        const reboundResponse = await this.#client.callTool("get_browser_state", {
          pid: active.native.pid,
          window_id: active.native.windowId,
          session: active.session,
        }, { authority, signal }).catch(() => null);
        if (reboundResponse === null || signal.aborted) break;
        const candidate = this.#parseBinding(reboundResponse);
        if (candidate === null || candidate.tabs.length !== active.tabs.size) break;
        const candidates = candidate.tabs.filter((tab) => tab.url === markedDestination);
        if (candidates.length === 1) {
          markedBinding = candidate;
          markedTabs = candidates;
          break;
        }
        await this.#sleep(50, signal);
      }
      if (markedBinding === null || markedTabs.length !== 1) return this.#openUnknown(active, selected);

      const replacement = this.#replaceContextSameSession(active, markedBinding);
      if (replacement === null) return this.#openUnknown();
      active = replacement;
      active.busy = true;
      const finalTab = [...active.tabs.values()].find((tab) => tab.cuaTabId === markedTabs[0]!.tabId);
      if (finalTab === undefined) throw new Error("browser_open_destination_marker_projection_invalid");
      selected = finalTab;
      selected.busy = true;
      selected.mutationAvailable = false;

      const finalized = await this.#client.callTool("browser_navigate", {
        target_id: active.cuaTargetId,
        tab_id: selected.cuaTabId,
        url: parsed.data.url,
        session: active.session,
      }, { authority, signal }).catch(() => null);
      if (finalized === null || signal.aborted) return this.#openUnknown(active, selected);
      const finalNavigation = finalized.structuredContent;
      if (finalized.isError || finalNavigation === null
        || !hasKeys(finalNavigation, ["status", "target_id", "tab_id", "url", "refs_invalidated"])
        || finalNavigation["status"] !== "ok" || finalNavigation["target_id"] !== active.cuaTargetId
        || finalNavigation["tab_id"] !== selected.cuaTabId || finalNavigation["url"] !== parsed.data.url
        || finalNavigation["refs_invalidated"] !== true) {
        return this.#openUnknown(active, selected);
      }

      for (;;) {
        const pageResponse = await this.#client.callTool("get_browser_state", {
          target_id: active.cuaTargetId,
          tab_id: selected.cuaTabId,
          snapshot_format: "semantic_v2",
          session: active.session,
        }, { authority, signal }).catch(() => null);
        if (pageResponse === null || signal.aborted) break;
        const page = this.#parseSnapshot(pageResponse, active.cuaTargetId, selected.cuaTabId);
        if (page !== null && page.page.url === parsed.data.url) {
          if (this.#revoked) return this.#openUnknown();
          // The requested postcondition is this exact URL in the uniquely
          // attributed retained tab. A title is page content, not identity;
          // waiting for it to become nonblank or polished can stall after the
          // navigation has already completed and useful content is available.
          const checked = BROWSER_CONTRACT_SCHEMAS.openUrl.result.safeParse({
            status: "opened",
            target: active.publicTarget,
            tab: selected.public,
            page: page.page,
            outline: page.outline,
            doNotReplay: true,
          });
          if (!checked.success) throw new Error("browser_open_projection_invalid");
          return settled("completed", checked.data);
        }
        if (page === null) break;
        await this.#sleep(50, signal);
      }
      const checked = BROWSER_CONTRACT_SCHEMAS.openUrl.result.safeParse({
        status: "delivered",
        target: active.publicTarget,
        tab: selected.public,
        observeAgain: true,
        doNotReplay: true,
      });
      if (!checked.success) throw new Error("browser_open_projection_invalid");
      return settled("completed", checked.data);
    } finally {
      if (retireInitial && this.#contexts.get(initial.context) === initial) {
        await this.#retireContext(initial);
      }
      if (this.#contexts.get(active.context) === active) {
        active.busy = false;
        for (const tab of active.tabs.values()) {
          tab.busy = false;
          tab.mutationAvailable = true;
        }
      } else if (!crossedTabBoundary) {
        initial.busy = false;
        for (const tab of initial.tabs.values()) {
          tab.busy = false;
          tab.mutationAvailable = true;
        }
      }
    }
  }

  #openNotDelivered(
    recovery: ComputerBrowserRecoveryAction,
    settlement: "not_completed" | "fenced" | "failed" = "not_completed",
  ): ComputerUseContractHandlerResult {
    const checked = BROWSER_CONTRACT_SCHEMAS.openUrl.result.safeParse({
      status: "not_delivered",
      observeAgain: true,
      doNotReplay: true,
      recovery,
    });
    if (!checked.success) throw new Error("browser_open_projection_invalid");
    return settled(settlement, checked.data);
  }

  #openUnknown(context?: BrowserContext, tab?: BrowserTab): ComputerUseContractHandlerResult {
    const checked = BROWSER_CONTRACT_SCHEMAS.openUrl.result.safeParse({
      status: "unknown_completion",
      ...(context === undefined ? {} : { target: context.publicTarget }),
      ...(tab === undefined ? {} : { tab: tab.public }),
      observeAgain: true,
      doNotReplay: true,
    });
    if (!checked.success) throw new Error("browser_open_projection_invalid");
    return settled("unknown_completion", checked.data);
  }

  #nativeAttempt(result: CuaToolResult): "attempted" | "refused" | "unknown" {
    const action = parseActionResult(result);
    if (action === null || action.delivery === null
      || action.delivery.mode === "unknown" || action.delivery.mode === "not_applicable") return "unknown";
    if (action.effect === "refused" || action.effect === "suspected_noop" || action.delivery.deliveredCount === 0) return "refused";
    // Cua intentionally omits delivered_count for keyboard actions whose
    // semantic effect it cannot read back. This composition verifies the
    // entire chord/type/key sequence from a fresh exact tab-count + marker
    // binding before it navigates, so a canonical unverifiable attempt is
    // sufficient here while a partial or malformed action remains unknown.
    return action.effect === "partial" ? "unknown" : "attempted";
  }

  #exactWindowIsCurrent(result: CuaToolResult, windowId: number): boolean {
    const value = result.structuredContent;
    if (result.isError || value === null || !Array.isArray(value["windows"])) return false;
    const matches = value["windows"].map(record).filter((window) => window?.["window_id"] === windowId);
    if (matches.length !== 1) return false;
    const window = matches[0]!;
    return window["on_current_space"] === true && window["is_on_screen"] === true;
  }

  #replaceContextSameSession(
    previous: BrowserContext,
    binding: Readonly<{
      targetId: string;
      tabs: readonly Readonly<{ tabId: string; title: string; url: string; active: boolean | null }>[];
    }>,
  ): BrowserContext | null {
    if (this.#revoked) return null;
    this.#contexts.delete(previous.context);
    if (this.#contextsByNative.get(previous.nativeBindingKey) === previous.context) this.#contextsByNative.delete(previous.nativeBindingKey);
    for (const tab of previous.tabs.values()) this.#retireSnapshot(tab);

    const context = randomReference("dbctx", this.#random);
    const publicTarget = { version: 1, context, reference: randomReference("dbtgt", this.#random) } as const;
    const tabs = new Map<string, BrowserTab>();
    for (const tab of binding.tabs) {
      const target = { version: 1, context, reference: randomReference("dbtab", this.#random) } as const;
      tabs.set(publicKey(target), {
        public: target,
        cuaTabId: tab.tabId,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        busy: false,
        mutationAvailable: true,
      });
    }
    const replacement: BrowserContext = {
      context,
      nativeBindingKey: previous.nativeBindingKey,
      native: previous.native,
      authority: previous.authority,
      session: previous.session,
      publicTarget,
      cuaTargetId: binding.targetId,
      tabs,
      busy: false,
    };
    this.#contexts.set(context, replacement);
    this.#contextsByNative.set(replacement.nativeBindingKey, context);
    return replacement;
  }

  async #navigate(argumentsValue: Readonly<Record<string, ComputerUseJson>>, authority: ComputerUseHostAuthorityScope, signal: AbortSignal, coordinated = false): Promise<ComputerUseContractHandlerResult> {
    const parsed = BROWSER_CONTRACT_SCHEMAS.navigate.input.safeParse(argumentsValue);
    if (!parsed.success) return settled("fenced", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    if (this.#revoked) return settled("not_completed", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    const resolved = this.#resolveTab(parsed.data.target, parsed.data.tab, authority);
    if (resolved === null) return settled("not_completed", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    if (!coordinated) return this.#coordinate(this.#tabClaims(resolved.context, resolved.tab, "write"), signal,
      () => this.#navigate(argumentsValue, authority, signal, true));
    return this.#mutate(resolved.tab, authority, signal, "browser_navigate", {
      target_id: resolved.context.cuaTargetId,
      tab_id: resolved.tab.cuaTabId,
      url: parsed.data.url,
      session: resolved.context.session,
    }, (response) => {
      const structured = response.structuredContent;
      if (!response.isError && structured !== null && exactKeys(structured, ["status", "target_id", "tab_id", "url", "refs_invalidated"])
        && structured["status"] === "ok" && structured["target_id"] === resolved.context.cuaTargetId
        && structured["tab_id"] === resolved.tab.cuaTabId && structured["url"] === parsed.data.url
        && structured["refs_invalidated"] === true) return deliveredMutation();
      return mutationRecovery(response);
    });
  }

  async #click(argumentsValue: Readonly<Record<string, ComputerUseJson>>, authority: ComputerUseHostAuthorityScope, signal: AbortSignal, coordinated = false): Promise<ComputerUseContractHandlerResult> {
    const parsed = BROWSER_CONTRACT_SCHEMAS.click.input.safeParse(argumentsValue);
    if (!parsed.success) return settled("fenced", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    if (this.#revoked) return settled("not_completed", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    const resolved = this.#resolveTab(parsed.data.target, parsed.data.tab, authority);
    const element = this.#elements.get(publicKey(parsed.data.element));
    if (resolved === null || element === undefined || element.tab !== resolved.tab || !element.actions.has("click")) {
      return settled("not_completed", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    }
    if (!coordinated) return this.#coordinate(this.#tabClaims(resolved.context, resolved.tab, "write"), signal,
      () => this.#click(argumentsValue, authority, signal, true));
    return this.#mutate(resolved.tab, authority, signal, "browser_click", {
      target_id: resolved.context.cuaTargetId,
      tab_id: resolved.tab.cuaTabId,
      ref: element.cuaRef,
      input_route: parsed.data.inputRoute,
      session: resolved.context.session,
    }, (response) => classifyActionMutation(response, parsed.data.inputRoute === "dom_event" ? "dom" : "trusted_input"));
  }

  async #type(argumentsValue: Readonly<Record<string, ComputerUseJson>>, authority: ComputerUseHostAuthorityScope, signal: AbortSignal, coordinated = false): Promise<ComputerUseContractHandlerResult> {
    const parsed = BROWSER_CONTRACT_SCHEMAS.type.input.safeParse(argumentsValue);
    if (!parsed.success) return settled("fenced", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    if (this.#revoked) return settled("not_completed", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    const resolved = this.#resolveTab(parsed.data.target, parsed.data.tab, authority);
    const element = this.#elements.get(publicKey(parsed.data.element));
    if (resolved === null || element === undefined || element.tab !== resolved.tab || !element.actions.has("type")) {
      return settled("not_completed", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    }
    if (!coordinated) return this.#coordinate(this.#tabClaims(resolved.context, resolved.tab, "write"), signal,
      () => this.#type(argumentsValue, authority, signal, true));
    const requestedChars = [...parsed.data.text].length;
    return this.#mutate(resolved.tab, authority, signal, "browser_type", {
      target_id: resolved.context.cuaTargetId,
      tab_id: resolved.tab.cuaTabId,
      ref: element.cuaRef,
      text: parsed.data.text,
      mode: parsed.data.mode,
      replace: parsed.data.replace,
      session: resolved.context.session,
    }, (response) => classifyActionMutation(response, "trusted_input", requestedChars));
  }

  async #pointer(argumentsValue: Readonly<Record<string, ComputerUseJson>>, authority: ComputerUseHostAuthorityScope, signal: AbortSignal, coordinated = false): Promise<ComputerUseContractHandlerResult> {
    const parsed = BROWSER_CONTRACT_SCHEMAS.pointer.input.safeParse(argumentsValue);
    if (!parsed.success) return settled("fenced", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    if (this.#revoked) return settled("not_completed", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    const resolved = this.#resolveTab(parsed.data.target, parsed.data.tab, authority);
    const element = this.#elements.get(publicKey(parsed.data.element));
    const neededAction = parsed.data.action === "scroll" ? ["scroll", "pointer"] : ["pointer"];
    if (resolved === null || element === undefined || element.tab !== resolved.tab
      || !neededAction.some((action) => element.actions.has(action as "scroll" | "pointer"))) {
      return settled("not_completed", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    }
    if (!coordinated) return this.#coordinate(this.#tabClaims(resolved.context, resolved.tab, "write"), signal,
      () => this.#pointer(argumentsValue, authority, signal, true));
    const destination = parsed.data.action === "drag" ? this.#elements.get(publicKey(parsed.data.destination)) : undefined;
    if (parsed.data.action === "drag" && (destination === undefined || destination.tab !== resolved.tab || !destination.actions.has("pointer"))) {
      return settled("not_completed", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    }
    return this.#mutate(resolved.tab, authority, signal, "browser_pointer", {
      target_id: resolved.context.cuaTargetId,
      tab_id: resolved.tab.cuaTabId,
      ref: element.cuaRef,
      action: parsed.data.action,
      input_route: parsed.data.inputRoute,
      ...(parsed.data.action === "scroll" ? { delta_x: parsed.data.deltaX, delta_y: parsed.data.deltaY } : {}),
      ...(parsed.data.action === "drag" ? { destination_ref: destination!.cuaRef } : {}),
      session: resolved.context.session,
    }, (response) => classifyActionMutation(response, parsed.data.inputRoute === "dom_event" ? "dom" : "trusted_input"));
  }

  async #dialog(argumentsValue: Readonly<Record<string, ComputerUseJson>>, authority: ComputerUseHostAuthorityScope, signal: AbortSignal, coordinated = false): Promise<ComputerUseContractHandlerResult> {
    const parsed = BROWSER_CONTRACT_SCHEMAS.dialog.input.safeParse(argumentsValue);
    const failed = () => settled("not_completed" as const, { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    if (!parsed.success) return settled("fenced", failed().result);
    if (this.#revoked) return failed();
    const resolved = this.#resolveTab(parsed.data.target, parsed.data.tab, authority);
    if (resolved === null || signal.aborted) return signal.aborted ? settled("cancelled", failed().result) : failed();
    const { context, tab } = resolved;
    if (!coordinated) return this.#coordinate(
      this.#tabClaims(context, tab, parsed.data.action === "inspect" ? "read" : "write"), signal,
      () => this.#dialog(argumentsValue, authority, signal, true),
    );
    if (tab.busy || (parsed.data.action !== "inspect" && !tab.mutationAvailable)) return settled("fenced", failed().result);
    let retained: PrivateDialog | undefined;
    if (parsed.data.action !== "inspect") {
      retained = this.#dialogs.get(publicKey(parsed.data.dialog));
      if (retained === undefined || retained.tab !== tab
        || (parsed.data.action === "accept" && parsed.data.promptText !== undefined && retained.kind !== "prompt")) return failed();
    }
    tab.busy = true;
    if (parsed.data.action !== "inspect") {
      tab.mutationAvailable = false;
      this.#retireSnapshot(tab);
    }
    try {
      const response = await this.#client.callTool("browser_dialog", {
        target_id: context.cuaTargetId,
        tab_id: tab.cuaTabId,
        action: parsed.data.action,
        ...(parsed.data.action === "inspect" ? {} : {
          dialog_id: retained!.cuaDialogId,
          delivery_mode: parsed.data.deliveryMode,
          ...(parsed.data.action === "accept" && parsed.data.promptText !== undefined ? { prompt_text: parsed.data.promptText } : {}),
        }),
        session: context.session,
      }, { authority, signal }).catch(() => null);
      if (response === null) {
        if (signal.aborted) return parsed.data.action === "inspect"
          ? settled("cancelled", { status: "recovery_required", recovery: "observe_again" })
          : settled("cancelled", failed().result);
        return parsed.data.action === "inspect"
          ? settled("failed", { status: "recovery_required", recovery: "observe_again" })
          : settled("unknown_completion", { status: "unknown_completion", observeAgain: true, doNotReplay: true });
      }
      if (signal.aborted) return parsed.data.action === "inspect"
        ? settled("cancelled", { status: "recovery_required", recovery: "observe_again" })
        : settled("cancelled", failed().result);
      if (this.#revoked) return parsed.data.action === "inspect"
        ? settled("failed", { status: "recovery_required", recovery: "observe_again" })
        : settled("unknown_completion", { status: "unknown_completion", observeAgain: true, doNotReplay: true });
      if (parsed.data.action === "inspect") {
        const inspected = this.#parseDialogInspection(response, context.cuaTargetId, tab.cuaTabId);
        if (inspected === null) return readRecovery(response);
        tab.mutationAvailable = true;
        if (!inspected.present) return settled("completed", { status: "observed", present: false });
        const dialog = { version: 1, context: context.context, reference: randomReference("dbdlg", this.#random) } as const;
        this.#dialogs.set(publicKey(dialog), { tab, cuaDialogId: inspected.dialogId, kind: inspected.kind });
        return settled("completed", { status: "observed", present: true, dialog, kind: inspected.kind });
      }
      this.#dialogs.delete(publicKey(parsed.data.dialog));
      const resolvedDialog = this.#parseDialogResolution(response, context.cuaTargetId, tab.cuaTabId, retained!.cuaDialogId, parsed.data.action, retained!.kind);
      return resolvedDialog ? deliveredMutation() : mutationRecovery(response);
    } finally {
      tab.busy = false;
    }
  }

  async #mutate(
    tab: BrowserTab,
    authority: ComputerUseHostAuthorityScope,
    signal: AbortSignal,
    primitive: "browser_navigate" | "browser_click" | "browser_type" | "browser_pointer",
    argumentsValue: Readonly<Record<string, unknown>>,
    classify: (result: CuaToolResult) => ComputerUseContractHandlerResult,
  ): Promise<ComputerUseContractHandlerResult> {
    if (signal.aborted) return settled("cancelled", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    if (tab.busy || !tab.mutationAvailable) return settled("fenced", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
    tab.busy = true;
    tab.mutationAvailable = false;
    this.#retireSnapshot(tab);
    try {
      const response = await this.#client.callTool(primitive, argumentsValue, { authority, signal }).catch(() => null);
      if (response === null) {
        if (signal.aborted) return settled("cancelled", { status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again" });
        return settled("unknown_completion", { status: "unknown_completion", observeAgain: true, doNotReplay: true });
      }
      if (this.#revoked) return settled("unknown_completion", {
        status: "unknown_completion", observeAgain: true, doNotReplay: true,
      });
      const outcome = classify(response);
      const checked = BROWSER_CONTRACT_SCHEMAS.navigate.result.safeParse(outcome.result);
      if (!checked.success) throw new Error("browser_mutation_projection_invalid");
      return { settlement: outcome.settlement, result: asResult(checked.data) };
    } finally {
      tab.busy = false;
    }
  }

  #resolveTab(target: ComputerBrowserTargetReference, tabReference: ComputerBrowserTabReference, authority: ComputerUseHostAuthorityScope): Readonly<{ context: BrowserContext; tab: BrowserTab }> | null {
    if (this.#revoked) return null;
    if (target.context !== tabReference.context) return null;
    const context = this.#contexts.get(target.context);
    if (context === undefined || !sameAuthority(context.authority, authority) || publicKey(context.publicTarget) !== publicKey(target)) return null;
    const tab = context.tabs.get(publicKey(tabReference));
    return tab === undefined ? null : { context, tab };
  }

  #resolveContext(target: ComputerBrowserTargetReference, authority: ComputerUseHostAuthorityScope): BrowserContext | null {
    if (this.#revoked) return null;
    const context = this.#contexts.get(target.context);
    return context !== undefined
      && sameAuthority(context.authority, authority)
      && publicKey(context.publicTarget) === publicKey(target)
      ? context
      : null;
  }

  #retireSnapshot(tab: BrowserTab): void {
    for (const [key, value] of this.#elements) if (value.tab === tab) this.#elements.delete(key);
    for (const [key, value] of this.#contents) if (value.tab === tab) this.#contents.delete(key);
    for (const [key, value] of this.#continuations) if (value.tab === tab) this.#continuations.delete(key);
    for (const [key, value] of this.#dialogs) if (value.tab === tab) this.#dialogs.delete(key);
  }

  async #retireContext(context: BrowserContext): Promise<void> {
    if (this.#contexts.get(context.context) !== context) return;
    this.#contexts.delete(context.context);
    if (this.#contextsByNative.get(context.nativeBindingKey) === context.context) this.#contextsByNative.delete(context.nativeBindingKey);
    for (const tab of context.tabs.values()) this.#retireSnapshot(tab);
    await this.#client.callTool("end_session", { session: context.session }, { authority: context.authority }).catch(() => undefined);
  }

  #parseBinding(result: CuaToolResult): BrowserBinding | null {
    const value = result.structuredContent;
    if (result.isError || value === null || !hasKeys(value, [
      "status", "mode", "target_id", "binding_quality", "binding_route", "endpoint_transport", "endpoint_access_class",
      "mutation_allowed", "native_title", "tabs",
    ]) || value["status"] !== "ok" || value["mode"] !== "bind" || value["binding_quality"] !== "exact"
      || (value["binding_route"] !== "embedded_single_page" && value["binding_route"] !== "native_cdp_window")
      || !["dev_tools_active_port", "legacy_json_version", "embedded_descendant"].includes(String(value["endpoint_transport"]))
      || !["driver_owned", "existing_profile_approved", "embedded_application", "external_consumer_browser"].includes(String(value["endpoint_access_class"]))
      || value["mutation_allowed"] !== true || typeof value["target_id"] !== "string" || typeof value["native_title"] !== "string"
      || !Array.isArray(value["tabs"])) return null;
    const tabs: Array<Readonly<{ tabId: string; title: string; url: string; active: boolean | null }>> = [];
    for (const raw of value["tabs"]) {
      const tab = record(raw);
      if (tab === null || !hasKeys(tab, ["tab_id", "title", "url", "active"]) || typeof tab["tab_id"] !== "string"
        || typeof tab["title"] !== "string" || typeof tab["url"] !== "string"
        || (tab["active"] !== true && tab["active"] !== false && tab["active"] !== null)) return null;
      tabs.push({ tabId: tab["tab_id"], title: tab["title"], url: tab["url"], active: tab["active"] });
    }
    return { targetId: value["target_id"], tabs };
  }

  #parsePrepared(result: CuaToolResult, pid: number): Readonly<{
    action: "already_prepared" | "attached_existing_profile";
    sideEffects: Readonly<{
      launchedBrowser: boolean;
      restartedBrowser: boolean;
      createdProfile: boolean;
      reusedDriverProfile: boolean;
      copiedProfileData: boolean;
      changedPreferences: boolean;
      displayedConsentPrompt: boolean;
      openedSetupPage: boolean;
      closedSetupPage: boolean;
      enabledRemoteDebugging: boolean;
      usedBoundedPixelFallback: boolean;
      focusedSetupAddressField: boolean;
      foregroundedWindow: boolean;
      injectedGlobalInput: boolean;
    }>;
  }> | null {
    const value = result.structuredContent;
    if (result.isError || value === null || !hasKeys(value, [
      "status", "prepared", "action", "message", "endpoint_ownership", "prepared_pid", "side_effects", "attachment",
    ]) || value["status"] !== "ok" || value["prepared"] !== true
      || (value["action"] !== "already_prepared" && value["action"] !== "attached_existing_profile")
      || typeof value["message"] !== "string" || value["message"].length === 0
      || value["prepared_pid"] !== pid) return null;
    const ownership = record(value["endpoint_ownership"]);
    const sideEffects = record(value["side_effects"]);
    const attachment = value["attachment"] === null ? null : record(value["attachment"]);
    if (ownership === null || !hasKeys(ownership, ["method", "owner_pid", "detail"])
      || !["listening_socket_pid", "devtools_active_ports_file", "spawned_by_driver", "platform_attested"].includes(String(ownership["method"]))
      || ownership["owner_pid"] !== pid
      || (ownership["listener_pid"] !== undefined && (!Number.isSafeInteger(ownership["listener_pid"]) || (ownership["listener_pid"] as number) <= 0))
      || (ownership["detail"] !== null && typeof ownership["detail"] !== "string")
      || sideEffects === null || !exactKeys(sideEffects, [
        "launched_browser", "restarted_browser", "created_profile", "reused_driver_profile", "copied_profile_data",
        "changed_preferences", "displayed_consent_prompt", "opened_setup_page", "closed_setup_page",
        "enabled_remote_debugging", "used_bounded_pixel_fallback", "focused_setup_address_field",
        "foregrounded_window", "injected_global_input",
      ]) || Object.values(sideEffects).some((effect) => typeof effect !== "boolean")) return null;
    if (attachment !== null && !(
      hasKeys(attachment, ["kind", "browser", "capabilities_invalidated", "next_action"])
      && attachment["kind"] === "existing_profile" && typeof attachment["browser"] === "string"
      && attachment["capabilities_invalidated"] === true && attachment["next_action"] === "get_browser_state"
    )) return null;
    return {
      action: value["action"],
      sideEffects: {
        launchedBrowser: sideEffects["launched_browser"] as boolean,
        restartedBrowser: sideEffects["restarted_browser"] as boolean,
        createdProfile: sideEffects["created_profile"] as boolean,
        reusedDriverProfile: sideEffects["reused_driver_profile"] as boolean,
        copiedProfileData: sideEffects["copied_profile_data"] as boolean,
        changedPreferences: sideEffects["changed_preferences"] as boolean,
        displayedConsentPrompt: sideEffects["displayed_consent_prompt"] as boolean,
        openedSetupPage: sideEffects["opened_setup_page"] as boolean,
        closedSetupPage: sideEffects["closed_setup_page"] as boolean,
        enabledRemoteDebugging: sideEffects["enabled_remote_debugging"] as boolean,
        usedBoundedPixelFallback: sideEffects["used_bounded_pixel_fallback"] as boolean,
        focusedSetupAddressField: sideEffects["focused_setup_address_field"] as boolean,
        foregroundedWindow: sideEffects["foregrounded_window"] as boolean,
        injectedGlobalInput: sideEffects["injected_global_input"] as boolean,
      },
    };
  }

  #parseDialogInspection(result: CuaToolResult, targetId: string, tabId: string): Readonly<{
    present: false;
  }> | Readonly<{
    present: true;
    dialogId: string;
    kind: "alert" | "confirm" | "prompt" | "beforeunload";
  }> | null {
    const value = result.structuredContent;
    if (result.isError || value === null || !hasKeys(value, ["status", "target_id", "tab_id", "present"])
      || value["status"] !== "ok" || value["target_id"] !== targetId || value["tab_id"] !== tabId
      || typeof value["present"] !== "boolean") return null;
    if (value["present"] === false) return { present: false };
    if (!hasKeys(value, ["dialog_id", "kind"]) || typeof value["dialog_id"] !== "string"
      || !["alert", "confirm", "prompt", "beforeunload"].includes(String(value["kind"]))) return null;
    return { present: true, dialogId: value["dialog_id"], kind: value["kind"] as "alert" | "confirm" | "prompt" | "beforeunload" };
  }

  #parseDialogResolution(
    result: CuaToolResult,
    targetId: string,
    tabId: string,
    dialogId: string,
    action: "accept" | "dismiss",
    kind: PrivateDialog["kind"],
  ): boolean {
    const value = result.structuredContent;
    return !result.isError && value !== null && hasKeys(value, ["status", "target_id", "tab_id", "dialog_id", "kind", "action"])
      && value["status"] === "ok" && value["target_id"] === targetId && value["tab_id"] === tabId
      && value["dialog_id"] === dialogId && value["kind"] === kind && value["action"] === action;
  }

  #parseSnapshot(result: CuaToolResult, targetId: string, tabId: string): Readonly<{
    page: Readonly<{ title: string; url: string }>;
    outline: string;
    actionRefs: readonly ParsedSemanticRef[];
    contentRefs: readonly ParsedSemanticRef[];
    complete: boolean;
    omitted: Readonly<Record<"cssHidden" | "offscreen" | "pageOccluded" | "noLayout" | "unknown" | "budget" | "unprovableFrame", number>>;
    continuation: string | null;
  }> | null {
    const value = result.structuredContent;
    if (result.isError || value === null || !hasKeys(value, [
      "status", "mode", "target_id", "tab_id", "snapshot", "page", "outline", "refs", "content_refs", "oopif",
    ]) || value["status"] !== "ok" || value["mode"] !== "snapshot" || value["target_id"] !== targetId
      || value["tab_id"] !== tabId || typeof value["outline"] !== "string" || !Array.isArray(value["refs"])
      || !Array.isArray(value["content_refs"])) return null;
    const page = record(value["page"]);
    const snapshot = record(value["snapshot"]);
    const omitted = snapshot === null ? null : record(snapshot["omitted"]);
    const oopif = record(value["oopif"]);
    if (page === null || !hasKeys(page, ["url", "title"]) || typeof page["url"] !== "string" || typeof page["title"] !== "string"
      || snapshot === null || !hasKeys(snapshot, ["id", "format", "complete", "scope", "selected_nodes", "total_nodes", "node_budget", "omitted", "continuation"])
      || typeof snapshot["id"] !== "string" || snapshot["format"] !== "semantic_v2" || typeof snapshot["complete"] !== "boolean"
      || typeof snapshot["scope"] !== "string" || !safeNonnegativeInteger(snapshot["selected_nodes"])
      || !safeNonnegativeInteger(snapshot["total_nodes"]) || !safeNonnegativeInteger(snapshot["node_budget"])
      || (snapshot["continuation"] !== null && typeof snapshot["continuation"] !== "string") || omitted === null
      || !hasKeys(omitted, ["css_hidden", "offscreen", "page_occluded", "no_layout", "unknown", "budget", "unprovable_frame"])
      || oopif === null || !hasKeys(oopif, ["status", "frames"])
      || (oopif["status"] !== "attached" && oopif["status"] !== "unsupported")
      || !safeNonnegativeInteger(oopif["frames"])
      || (oopif["status"] === "unsupported" && oopif["frames"] !== 0)) return null;
    for (const count of Object.values(omitted)) if (!safeNonnegativeInteger(count)) return null;
    const actionRefs = this.#parseSemanticRefs(value["refs"]);
    const contentRefs = this.#parseSemanticRefs(value["content_refs"]);
    if (actionRefs === null || contentRefs === null) return null;
    return {
      page: { title: page["title"], url: page["url"] },
      outline: value["outline"],
      actionRefs,
      contentRefs,
      complete: snapshot["complete"],
      omitted: {
        cssHidden: omitted["css_hidden"] as number,
        offscreen: omitted["offscreen"] as number,
        pageOccluded: omitted["page_occluded"] as number,
        noLayout: omitted["no_layout"] as number,
        unknown: omitted["unknown"] as number,
        budget: omitted["budget"] as number,
        unprovableFrame: omitted["unprovable_frame"] as number,
      },
      continuation: snapshot["continuation"],
    };
  }

  #parseSemanticRefs(values: readonly unknown[]): readonly ParsedSemanticRef[] | null {
    const parsed: ParsedSemanticRef[] = [];
    for (const raw of values) {
      const value = record(raw);
      if (value === null || !hasKeys(value, ["ref", "role", "name", "value", "states", "actions", "frame", "visibility"])
        || typeof value["ref"] !== "string" || typeof value["role"] !== "string"
        || (value["name"] !== null && typeof value["name"] !== "string")
        || (value["value"] !== null && typeof value["value"] !== "string") || record(value["states"]) === null
        || !Array.isArray(value["actions"]) || !value["actions"].every((action) => typeof action === "string")
        || (value["frame"] !== "main" && value["frame"] !== "iframe" && value["frame"] !== "oopif")
        || !["in_viewport", "near_viewport", "offscreen", "css_hidden", "no_layout", "page_occluded", "unknown"].includes(String(value["visibility"]))) return null;
      parsed.push({
        ref: value["ref"], role: value["role"], name: value["name"], value: value["value"],
        actions: value["actions"], visibility: value["visibility"] as ParsedSemanticRef["visibility"],
      });
    }
    return parsed;
  }
}

type ParsedSemanticRef = Readonly<{
  ref: string;
  role: string;
  name: string | null;
  value: string | null;
  actions: readonly string[];
  visibility: "in_viewport" | "near_viewport" | "offscreen" | "css_hidden" | "no_layout" | "page_occluded" | "unknown";
}>;
