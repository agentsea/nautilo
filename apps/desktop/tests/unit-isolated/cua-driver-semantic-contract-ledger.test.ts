import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type LedgerRow = {
  id: string;
  providerOperation: string;
  literalProviderRequest: { acceptedKeys: string[]; schemaRequiredKeys: string[] };
  nautiloNarrowedRequest: { acceptedKeys: string[]; requiredKeys: string[]; excludedProviderKeys: string[] };
  successStructured: { requiredKeys: string[]; optionalKeys: string[] };
  toolLocalStructured?: { requiredKeys: string[]; optionalKeys: string[]; visibility: string };
  envelopeDescriptors: Array<{ name: string; transport: string; structuredContent?: string; exactKeys: string[]; requiredKeys: string[]; optionalKeys: string[]; constraints: Record<string, unknown> }>;
  closedFamilies: Record<string, unknown>;
  compactProjection: Record<string, unknown>;
  ordinaryRoomSummary: Record<string, unknown>;
};

type Ledger = {
  schemaVersion: number;
  pinnedProvider: { version: string; sourceSha: string; platform: string };
  baselineEvidence: { providerObservationBytes: { lower: number; upper: number }; inputTokens: { firstObserved: number; repeatedObserved: number } };
  projectionInvariant: { launchCommonPath: string; deduplication: string; serialization: string; noHardCeiling: string };
  projectionBoundary: { providerPrivateOrSensitiveFields: string[]; modelProjectionFields: string[]; ordinaryRoomSummaryFields: string[]; rule: string };
  rows: LedgerRow[];
  openErrorBoundary: string;
};

const ledger = JSON.parse(readFileSync(
  new URL("../../cua-driver/semantic-contract-ledger.json", import.meta.url),
  "utf8",
)) as Ledger;

const LEGACY_OBSERVATION_LOWER_BOUND_BYTES = 8 * 1024;
const SOURCE_SHA = "e88e9d899ac5effaeae38619527ebaa46b26ce72";

function row(id: string): LedgerRow {
  const found = ledger.rows.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing ledger row ${id}`);
  return found;
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}

describe("D516 Cua semantic contract ledger", () => {
  test("pins the reviewed macOS Cua revision and records the measured Qualification baseline", () => {
    expect(ledger.schemaVersion).toBe(1);
    expect(ledger.pinnedProvider).toMatchObject({ version: "0.23.2", sourceSha: SOURCE_SHA, platform: "macos" });
    expect(ledger.baselineEvidence.providerObservationBytes).toMatchObject({ lower: 8192, upper: 12288 });
    expect(ledger.baselineEvidence.inputTokens).toMatchObject({ firstObserved: 24020, repeatedObserved: 102052 });
    expect(ledger.projectionInvariant.noHardCeiling).toMatch(/No hard byte ceiling/);
  });

  test("contains the reviewed provider/scope rows plus the first vertical's private Cua composition", () => {
    expect(ledger.rows.map((entry) => entry.id)).toEqual([
      "launch_app",
      "get_window_state",
      "press_key_window",
      "press_key_desktop",
      "create_window_textedit",
      "type_text_element_background",
      "set_value_element_background",
      "scroll_element_background",
      "click_element_background",
      "right_click_element_background",
      "double_click_element_background",
      "click_window_snapshot_background",
      "drag_drop_window_foreground",
      "verify_state_exact",
    ]);

    expect(row("launch_app").literalProviderRequest).toMatchObject({
      acceptedKeys: ["bundle_id", "name", "urls", "webkit_inspector_port", "creates_new_application_instance", "additional_arguments"],
      schemaRequiredKeys: [],
    });
    expect(row("get_window_state").literalProviderRequest).toMatchObject({
      acceptedKeys: ["session", "pid", "window_id", "query", "capture_mode", "include_screenshot", "screenshot_out_file", "max_elements", "max_depth"],
      schemaRequiredKeys: ["pid", "window_id"],
    });
    const pressLiteral = {
      acceptedKeys: ["session", "pid", "key", "modifiers", "window_id", "element_index", "element_token", "snapshot_id", "x", "y", "scope", "delivery_mode"],
      schemaRequiredKeys: ["key"],
    };
    expect(row("press_key_window").literalProviderRequest).toMatchObject(pressLiteral);
    expect(row("press_key_desktop").literalProviderRequest).toMatchObject(pressLiteral);
    expect(row("create_window_textedit").literalProviderRequest).toMatchObject({
      acceptedKeys: ["pid", "window_id", "path"], schemaRequiredKeys: ["pid", "window_id", "path"],
    });
    expect(row("type_text_element_background").literalProviderRequest).toMatchObject({
      acceptedKeys: ["pid", "window_id", "element_token", "text", "delivery_mode"], schemaRequiredKeys: ["text"],
    });
    expect(row("set_value_element_background").literalProviderRequest).toMatchObject({
      acceptedKeys: ["session", "pid", "window_id", "element_index", "element_token", "snapshot_id", "value"], schemaRequiredKeys: ["pid", "value"],
    });
    expect(row("scroll_element_background").literalProviderRequest).toMatchObject({
      acceptedKeys: ["session", "pid", "window_id", "element_index", "element_token", "snapshot_id", "direction", "by", "amount", "x", "y", "scope", "delivery_mode"],
      schemaRequiredKeys: ["direction"],
      runtimeRequirement: expect.stringContaining("amount 5"),
    });
    expect(row("click_element_background").literalProviderRequest).toMatchObject({
      acceptedKeys: ["session", "pid", "window_id", "element_index", "element_token", "snapshot_id", "x", "y", "action", "button", "count", "modifier", "from_zoom", "debug_image_out", "delivery_mode", "scope"],
      schemaRequiredKeys: [],
      runtimeRequirement: expect.stringContaining("default AXPress action and background delivery"),
    });
    expect(row("right_click_element_background").literalProviderRequest).toMatchObject({
      acceptedKeys: ["session", "pid", "element_index", "element_token", "snapshot_id", "window_id", "x", "y", "modifier", "delivery_mode"],
      schemaRequiredKeys: ["pid"],
      runtimeRequirement: expect.stringContaining("background delivery"),
    });
    expect(row("double_click_element_background").literalProviderRequest).toMatchObject({
      acceptedKeys: ["session", "pid", "x", "y", "window_id", "element_index", "element_token", "snapshot_id", "delivery_mode"],
      schemaRequiredKeys: ["pid"],
      runtimeRequirement: expect.stringContaining("background delivery"),
    });
    expect(row("drag_drop_window_foreground").literalProviderRequest).toMatchObject({
      acceptedKeys: ["session", "pid", "window_id", "from_x", "from_y", "to_x", "to_y", "duration_ms", "steps", "modifier", "button", "from_zoom", "scope", "delivery_mode"],
      schemaRequiredKeys: ["from_x", "from_y", "to_x", "to_y"],
      runtimeRequirement: expect.stringContaining("duration_ms 700, steps 30"),
    });
    expect(row("verify_state_exact").literalProviderRequest).toMatchObject({
      acceptedKeys: ["pid", "window_id", "expect", "timeout_ms", "stable_samples", "include_screenshot"], schemaRequiredKeys: ["pid", "window_id", "expect"],
    });
  });

  test("keeps the Nautilo launch and desktop-key requests narrower than Cua", () => {
    const launch = row("launch_app").nautiloNarrowedRequest;
    expect(launch.acceptedKeys).toEqual(["app"]);
    expect(launch.requiredKeys).toEqual(["app"]);
    expect(launch.excludedProviderKeys).toEqual(expect.arrayContaining([
      "urls", "webkit_inspector_port", "additional_arguments", "creates_new_application_instance", "pid", "window_id",
    ]));

    const desktop = row("press_key_desktop").nautiloNarrowedRequest;
    expect(desktop.acceptedKeys).toEqual(["key", "modifiers"]);
    expect(desktop.requiredKeys).toEqual(["key"]);
    expect(desktop.excludedProviderKeys).toEqual(expect.arrayContaining([
      "pid", "window_id", "session", "element_index", "element_token", "snapshot_id", "delivery_mode",
    ]));
  });

  test("locks every narrowed mapping and its structured success shape", () => {
    expect(row("launch_app").nautiloNarrowedRequest.acceptedKeys).toEqual(["app"]);
    expect(row("launch_app").successStructured).toMatchObject({
      requiredKeys: ["pid", "bundle_id", "name", "windows", "launch_state"],
      optionalKeys: ["self_activation_suppressed"],
    });

    expect(row("get_window_state").nautiloNarrowedRequest).toMatchObject({
      acceptedKeys: ["window", "intent"],
      requiredKeys: ["window"],
      excludedProviderKeys: ["session", "pid", "window_id", "query", "capture_mode", "include_screenshot", "screenshot_out_file", "max_elements", "max_depth"],
    });
    expect(row("get_window_state").successStructured.requiredKeys).toEqual([
      "window_id", "pid", "element_count", "total_element_count", "returned_element_count", "elements_complete", "tree_markdown", "elements", "_note",
    ]);

    expect(row("press_key_window").nautiloNarrowedRequest).toMatchObject({
      acceptedKeys: ["window", "key", "modifiers", "delivery"],
      requiredKeys: ["window", "key"],
    });
    expect(row("press_key_window").successStructured).toEqual({
      requiredKeys: ["effect", "route"],
      optionalKeys: ["delivery", "evidence", "escalation"],
      providerActionBoundary: expect.stringContaining("publish_action_result"),
      sessionAndScopePrerequisites: expect.any(String),
      mutationReplayCancellation: expect.stringContaining("Never replay"),
      verificationRoute: expect.stringContaining("action-level evidence"),
    });
    expect(row("press_key_window").toolLocalStructured).toEqual({
      requiredKeys: ["path", "verified", "effect"],
      optionalKeys: [],
      visibility: expect.stringContaining("internal only"),
    });

    expect(row("press_key_desktop").nautiloNarrowedRequest).toMatchObject({
      acceptedKeys: ["key", "modifiers"],
      requiredKeys: ["key"],
    });
    expect(row("press_key_desktop").successStructured).toEqual({
      requiredKeys: ["effect", "route"],
      optionalKeys: ["delivery", "evidence", "escalation"],
      providerActionBoundary: expect.stringContaining("publish_action_result"),
      sessionAndScopePrerequisites: expect.any(String),
      mutationReplayCancellation: expect.stringContaining("Never replay"),
      verificationRoute: expect.stringContaining("action-level evidence"),
    });
    expect(row("press_key_desktop").toolLocalStructured).toEqual({
      requiredKeys: ["scope", "path", "effect"],
      optionalKeys: [],
      visibility: expect.stringContaining("internal only"),
    });
  });

  test("locks the closed refusal, degraded, and indeterminate classifications", () => {
    expect(row("launch_app").closedFamilies).toMatchObject({
      refusalOrFailureCodes: ["APP_NOT_INSTALLED", "PROTECTED_HOST_ENTRYPOINT", "NSWORKSPACE_LAUNCH_FAILED", "LAUNCH_RESULT_MISSING", "LAUNCH_CALLBACK_TIMEOUT", "APP_URL_INVALID", "LAUNCH_FAILED", "FILE_NOT_FOUND"],
    });
    expect(row("get_window_state").closedFamilies).toMatchObject({
      refusalCodes: ["window_id_not_found", "window_owner_pid_mismatch"],
      degradedReasons: ["ax_tree_empty", "ax_window_unresolved", "px_frame_mismatch", "px_capture_unavailable"],
    });
    expect(row("press_key_window").closedFamilies).toMatchObject({
      refusalCodes: ["window_not_found", "owner_pid_mismatch", "off_space_or_ax_unresolved", "minimized_or_hidden_window", "same_pid_keyboard_ambiguity", "element_outside_target_window"],
      deliveryFailureCodes: ["delivery_failed"],
      indeterminateEffects: ["effect:unverifiable"],
    });
    expect(row("press_key_desktop").closedFamilies).toMatchObject({ indeterminateEffects: ["effect:unverifiable"] });
    expect(row("create_window_textedit").closedFamilies).toMatchObject({
      refusalCodes: ["menu_path_unavailable"], postObservation: ["none_observed", "unique", "ambiguous", "incomplete"],
    });
    expect(row("type_text_element_background").closedFamilies).toMatchObject({
      noForegroundFallback: true,
      refusalCodes: ["window_not_found", "owner_pid_mismatch", "element_outside_target_window", "stale_element_token", "generation_mismatch", "invalid_element_token", "conflicting_element_target"],
    });
    expect(row("set_value_element_background").closedFamilies).toMatchObject({
      noForegroundFallback: true,
      refusalCodes: ["window_not_found", "owner_pid_mismatch", "element_outside_target_window", "stale_element_token", "generation_mismatch", "invalid_element_token", "conflicting_element_target"],
      indeterminateEffects: ["effect:unverifiable"],
    });
    expect(row("scroll_element_background").closedFamilies).toMatchObject({
      noForegroundFallback: true,
      indeterminateEffects: ["effect:unverifiable accessibility", "effect:unverifiable synthetic_events"],
      source: expect.stringContaining("CUA-LAB-0037"),
    });
    expect(row("click_element_background").closedFamilies).toMatchObject({
      noForegroundFallback: true,
      refusalCodes: ["window_not_found", "owner_pid_mismatch", "element_outside_target_window", "stale_element_token", "generation_mismatch", "invalid_element_token", "conflicting_element_target"],
      indeterminateEffects: ["effect:unverifiable", "effect:suspected_noop"],
    });
    expect(row("right_click_element_background").closedFamilies).toMatchObject({
      noForegroundFallback: true,
      refusalCodes: ["window_not_found", "owner_pid_mismatch", "element_outside_target_window", "stale_element_token", "generation_mismatch", "invalid_element_token", "conflicting_element_target"],
      indeterminateEffects: ["effect:unverifiable"],
    });
    expect(row("double_click_element_background").closedFamilies).toMatchObject({
      noForegroundFallback: true,
      refusalCodes: ["window_not_found", "owner_pid_mismatch", "element_outside_target_window", "stale_element_token", "generation_mismatch", "invalid_element_token", "conflicting_element_target"],
      indeterminateEffects: ["effect:unverifiable"],
    });
    expect(row("drag_drop_window_foreground").closedFamilies).toMatchObject({
      refusalCodes: ["background_unavailable"],
      indeterminateEffects: ["effect:unverifiable"],
      foregroundOnly: true,
      labCounterexample: expect.stringContaining("(248,776)->(720,776)"),
    });
    expect((row("verify_state_exact").successStructured as Record<string, unknown>).verificationRoute).toContain("samples >= 2");
    expect(ledger.openErrorBoundary).toMatch(/not closed or model-visible/);
  });

  test("locks every reviewed success, refusal, degraded, and open-error envelope", () => {
    expect(row("launch_app").envelopeDescriptors).toEqual([
      expect.objectContaining({ name: "launch_success", transport: "success", exactKeys: ["pid", "bundle_id", "name", "windows", "launch_state", "self_activation_suppressed"], requiredKeys: ["pid", "bundle_id", "name", "windows", "launch_state"], optionalKeys: ["self_activation_suppressed"] }),
      expect.objectContaining({ name: "launch_app_not_installed", exactKeys: ["error", "name", "bundle_id"], requiredKeys: ["error"], optionalKeys: ["name", "bundle_id"], constraints: { error: ["APP_NOT_INSTALLED"], oneOfExactly: ["name", "bundle_id"] } }),
      expect.objectContaining({ name: "launch_protected_entrypoint", exactKeys: ["error"], requiredKeys: ["error"], optionalKeys: [], constraints: { error: ["PROTECTED_HOST_ENTRYPOINT"] } }),
      expect.objectContaining({ name: "launch_failure_with_state", exactKeys: ["error", "launch_state"], requiredKeys: ["error", "launch_state"], optionalKeys: [], constraints: expect.objectContaining({ error: ["NSWORKSPACE_LAUNCH_FAILED", "LAUNCH_RESULT_MISSING", "LAUNCH_CALLBACK_TIMEOUT", "APP_URL_INVALID", "LAUNCH_FAILED"] }) }),
      expect.objectContaining({ name: "launch_file_not_found", exactKeys: ["error", "url", "path"], requiredKeys: ["error", "url", "path"], optionalKeys: [], constraints: { error: ["FILE_NOT_FOUND"] } }),
      expect.objectContaining({ name: "launch_null_structured_error", structuredContent: "null", exactKeys: [], constraints: { content: "arbitrary native/task/transport text; open and provider-private" } }),
    ]);
    expect(row("get_window_state").envelopeDescriptors).toEqual([
      expect.objectContaining({ name: "window_state_success", transport: "success", requiredKeys: ["window_id", "pid", "element_count", "total_element_count", "returned_element_count", "elements_complete", "tree_markdown", "elements", "_note"], constraints: { degraded: "when present, boolean", degraded_reason: { prefixes: ["ax_tree_empty:", "ax_window_unresolved:", "px_frame_mismatch:", "px_capture_unavailable:"] } } }),
      expect.objectContaining({ name: "window_scope_not_found", transport: "error", exactKeys: ["code", "pid", "window_id", "suggestion"], requiredKeys: ["code", "pid", "window_id", "suggestion"], optionalKeys: [], constraints: { code: ["window_id_not_found"] } }),
      expect.objectContaining({ name: "window_scope_owner_mismatch", transport: "error", exactKeys: ["code", "pid", "window_id", "owner_pid", "owner_app_name", "suggestion"], requiredKeys: ["code", "pid", "window_id", "owner_pid", "owner_app_name", "suggestion"], optionalKeys: [], constraints: { code: ["window_owner_pid_mismatch"] } }),
      expect.objectContaining({ name: "window_state_null_structured_error", structuredContent: "null", exactKeys: [], constraints: { content: "arbitrary native/task/transport text; open and provider-private" } }),
    ]);
    expect(row("press_key_window").envelopeDescriptors).toEqual([
      expect.objectContaining({ name: "window_background_confirmed", constraints: expect.objectContaining({ effect: ["confirmed"], route: ["synthetic_events"] }) }),
      expect.objectContaining({ name: "window_background_unverifiable", exactKeys: ["effect", "route", "delivery"], requiredKeys: ["effect", "route", "delivery"], optionalKeys: [], constraints: expect.objectContaining({ effect: ["unverifiable"], route: ["synthetic_events"], evidence: "absent" }) }),
      expect.objectContaining({ name: "window_foreground_confirmed", constraints: expect.objectContaining({ effect: ["confirmed"], route: ["global_input"] }) }),
      expect.objectContaining({ name: "window_foreground_unverifiable", exactKeys: ["effect", "route", "delivery"], requiredKeys: ["effect", "route", "delivery"], optionalKeys: [], constraints: expect.objectContaining({ effect: ["unverifiable"], route: ["global_input"], evidence: "absent" }) }),
      expect.objectContaining({ name: "background_refusal", exactKeys: ["code", "effect", "pid", "reason", "window_id", "escalation"], requiredKeys: ["code", "effect", "pid", "reason", "window_id"], optionalKeys: ["escalation"], constraints: expect.objectContaining({ effect: ["refused"], escalation: { exactKeys: ["recommended", "reason"] } }) }),
      expect.objectContaining({ name: "delivery_failed", exactKeys: ["code", "message"], requiredKeys: ["code", "message"], optionalKeys: [], constraints: { code: ["delivery_failed"], message: "nonempty provider-private string" } }),
      expect.objectContaining({ name: "press_key_null_structured_error", structuredContent: "null", exactKeys: [], constraints: { content: "arbitrary native/task/transport text; open and provider-private" } }),
    ]);
    expect(row("press_key_desktop").envelopeDescriptors).toEqual([
      expect.objectContaining({ name: "desktop_unverifiable", exactKeys: ["effect", "route", "delivery"], requiredKeys: ["effect", "route", "delivery"], optionalKeys: [], constraints: { effect: ["unverifiable"], route: ["global_input"], delivery: { exactKeys: ["mode"], mode: ["not_applicable"] }, evidence: "absent" } }),
      expect.objectContaining({ name: "press_key_null_structured_error", structuredContent: "null", exactKeys: [], constraints: { content: "arbitrary native/task/transport text; open and provider-private" } }),
    ]);
    expect(row("type_text_element_background").envelopeDescriptors).toEqual([
      expect.objectContaining({ name: "element_background_confirmed", transport: "success" }),
      expect.objectContaining({ name: "element_token_refusal", exactKeys: ["status", "refusal"], constraints: expect.objectContaining({ "refusal.code": ["stale_element_token", "generation_mismatch", "invalid_element_token", "conflicting_element_target"] }) }),
      expect.objectContaining({ name: "element_background_refusal", exactKeys: ["code", "effect", "pid", "reason", "window_id", "escalation"], requiredKeys: ["code", "effect", "pid", "reason", "window_id"], optionalKeys: ["escalation"] }),
    ]);
    expect(row("set_value_element_background").envelopeDescriptors).toEqual([
      expect.objectContaining({ name: "set_value_confirmed", exactKeys: ["effect", "route", "delivery", "evidence"], constraints: expect.objectContaining({ effect: ["confirmed"], route: ["accessibility"], evidence: [{ kind: "value_readback" }] }) }),
      expect.objectContaining({ name: "set_value_unverifiable", exactKeys: ["effect", "route", "delivery", "escalation"], optionalKeys: ["escalation"], constraints: expect.objectContaining({ effect: ["unverifiable"], route: ["accessibility"], evidence: "absent", escalationWhenPresent: { target: ["pixel"], reason: ["effect_unconfirmed"] } }) }),
      expect.objectContaining({ name: "set_value_element_token_refusal", constraints: expect.objectContaining({ "refusal.code": ["stale_element_token", "generation_mismatch", "invalid_element_token", "conflicting_element_target"] }) }),
      expect.objectContaining({ name: "set_value_background_refusal", constraints: expect.objectContaining({ code: ["window_not_found", "owner_pid_mismatch", "element_outside_target_window"] }) }),
      expect.objectContaining({ name: "set_value_null_structured_error", structuredContent: "null" }),
    ]);
    expect(row("scroll_element_background").envelopeDescriptors).toEqual([
      expect.objectContaining({ name: "scroll_background_unverifiable", exactKeys: ["effect", "route", "delivery"], constraints: expect.objectContaining({ effect: ["unverifiable"], route: ["accessibility"], delivery: { exactKeys: ["mode"], mode: ["background"] } }) }),
      expect.objectContaining({ name: "scroll_synthetic_background_unverifiable", exactKeys: ["effect", "route", "delivery"], constraints: expect.objectContaining({ route: ["synthetic_events"], evidence: "absent", escalation: "absent", outcome: "unknown_no_replay" }) }),
      expect.objectContaining({ name: "scroll_element_token_refusal", constraints: expect.objectContaining({ "refusal.code": ["stale_element_token", "generation_mismatch", "invalid_element_token", "conflicting_element_target"] }) }),
      expect.objectContaining({ name: "scroll_background_refusal_window_owner", exactKeys: ["code", "effect", "pid", "reason", "window_id"], constraints: expect.objectContaining({ code: ["window_not_found", "owner_pid_mismatch"], escalation: "absent", outcome: "unknown_no_replay" }) }),
      expect.objectContaining({ name: "scroll_background_refusal_element", constraints: expect.objectContaining({ code: ["element_outside_target_window"], outcome: "unknown_no_replay" }) }),
      expect.objectContaining({ name: "scroll_background_refusal_off_space", constraints: expect.objectContaining({ code: ["off_space_or_ax_unresolved"], escalation: expect.objectContaining({ recommended: ["foreground"] }), outcome: "unknown_no_replay" }) }),
      expect.objectContaining({ name: "scroll_background_refusal_minimized", constraints: expect.objectContaining({ code: ["minimized_or_hidden_window"], escalation: expect.objectContaining({ recommended: ["accessibility"] }), outcome: "unknown_no_replay" }) }),
      expect.objectContaining({ name: "scroll_background_unavailable", exactKeys: ["code"], constraints: { code: ["background_unavailable"], outcome: "pre_effect_not_completed" } }),
      expect.objectContaining({ name: "scroll_null_structured_error", structuredContent: "null" }),
    ]);
    expect(row("click_element_background").envelopeDescriptors).toEqual([
      expect.objectContaining({ name: "click_element_confirmed", exactKeys: ["effect", "route", "delivery", "evidence"], constraints: expect.objectContaining({ effect: ["confirmed"], route: ["accessibility"], evidence: [{ kind: "value_readback" }] }) }),
      expect.objectContaining({ name: "click_element_unverifiable", exactKeys: ["effect", "route", "delivery"], constraints: expect.objectContaining({ effect: ["unverifiable"], route: ["accessibility"], evidence: "absent" }) }),
      expect.objectContaining({ name: "click_element_suspected_noop", exactKeys: ["effect", "route", "delivery", "escalation"], constraints: expect.objectContaining({ effect: ["suspected_noop"], route: ["accessibility"], escalation: { target: ["pixel"], reason: ["suspected_noop"] } }) }),
      expect.objectContaining({ name: "click_element_token_refusal", constraints: expect.objectContaining({ "refusal.code": ["stale_element_token", "generation_mismatch", "invalid_element_token", "conflicting_element_target"] }) }),
      expect.objectContaining({ name: "click_element_background_refusal", constraints: expect.objectContaining({ code: ["window_not_found", "owner_pid_mismatch", "element_outside_target_window"] }) }),
      expect.objectContaining({ name: "click_element_null_structured_error", structuredContent: "null" }),
    ]);
    expect(row("right_click_element_background").envelopeDescriptors).toEqual([
      expect.objectContaining({ name: "right_click_element_unverifiable", exactKeys: ["effect", "route", "delivery"], constraints: { effect: ["unverifiable"], route: ["synthetic_events"], delivery: { exactKeys: ["mode"], mode: ["unknown"] }, evidence: "absent" } }),
      expect.objectContaining({ name: "right_click_element_token_refusal", constraints: expect.objectContaining({ "refusal.code": ["stale_element_token", "generation_mismatch", "invalid_element_token", "conflicting_element_target"] }) }),
      expect.objectContaining({ name: "right_click_element_background_refusal", constraints: expect.objectContaining({ code: ["window_not_found", "owner_pid_mismatch", "element_outside_target_window"] }) }),
      expect.objectContaining({ name: "right_click_element_null_structured_error", structuredContent: "null" }),
    ]);
    expect(row("double_click_element_background").envelopeDescriptors).toEqual([
      expect.objectContaining({ name: "double_click_element_unverifiable", constraints: { effect: ["unverifiable"], route: ["synthetic_events"], delivery: { exactKeys: ["mode"], mode: ["unknown"] }, evidence: "absent" } }),
      expect.objectContaining({ name: "double_click_element_token_refusal" }),
      expect.objectContaining({ name: "double_click_element_background_refusal" }),
      expect.objectContaining({ name: "double_click_element_null_structured_error", structuredContent: "null" }),
    ]);
    expect(row("drag_drop_window_foreground").envelopeDescriptors).toEqual([
      expect.objectContaining({ name: "drag_foreground_unverifiable", constraints: { effect: ["unverifiable"], route: ["global_input"], delivery: { exactKeys: ["mode"], mode: ["foreground"] }, evidence: "absent" } }),
      expect.objectContaining({ name: "drag_background_unavailable", exactKeys: ["code"], constraints: expect.objectContaining({ code: ["background_unavailable"] }) }),
      expect.objectContaining({ name: "drag_null_structured_error", structuredContent: "null" }),
    ]);
  });

  test("measures compact fixture serialization and proves repeat growth contains no retained provider payload", () => {
    const compactProjection = {
      operation: "launch_app",
      target: { app: "TextEdit", window: "Untitled document" },
      outcome: "launched",
      verification: { status: "required", route: "get_window_state" },
      nextStep: "observe selected window",
    };
    const serialized = JSON.stringify(compactProjection);
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    console.info(`D516 compact launch projection: ${serializedBytes} bytes; observed legacy lower bound: ${LEGACY_OBSERVATION_LOWER_BOUND_BYTES} bytes`);
    expect(serializedBytes).toBeLessThan(LEGACY_OBSERVATION_LOWER_BOUND_BYTES);

    const once = serialized;
    const twice = [serialized, serialized].join("\n");
    const thrice = [serialized, serialized, serialized].join("\n");
    expect(Buffer.byteLength(twice, "utf8") - Buffer.byteLength(once, "utf8")).toBe(serializedBytes + 1);
    expect(Buffer.byteLength(thrice, "utf8") - Buffer.byteLength(twice, "utf8")).toBe(serializedBytes + 1);
    expect(thrice).not.toMatch(/pid|window_id|tree_markdown|elements|screenshot|diagnostics|bundle_id/);
  });

  test("forbids provider-private raw fields from every compact model and Room projection", () => {
    const privateFields = ledger.projectionBoundary.providerPrivateOrSensitiveFields;
    for (const entry of ledger.rows) {
      const projectionKeys = collectKeys(entry.compactProjection);
      const roomKeys = collectKeys(entry.ordinaryRoomSummary);
      for (const privateField of privateFields) {
        expect(projectionKeys).not.toContain(privateField);
        expect(roomKeys).not.toContain(privateField);
      }
    }
    expect(ledger.projectionInvariant.launchCommonPath).toMatch(/at most one semantic app target.*unique semantic window target/);
    expect(ledger.projectionInvariant.deduplication).toMatch(/never repeat/);
    expect(ledger.projectionInvariant.serialization).toMatch(/exact representative fixture serialization/);
    expect(ledger.projectionBoundary.rule).toMatch(/never a serialized provider response/);
  });
});
