import {
  BROWSER_CONTRACT_SCHEMAS,
  COMPUTER_USE_BROWSER_CONTRACTS,
} from "@nautilo/computer-use-contracts";
import {
  COMPUTER_USE_NATIVE_CONTRACTS,
  NATIVE_CONTRACT_SCHEMAS,
} from "@nautilo/computer-use-contracts/native";
import { z } from "zod";
import {
  computeComputerUseContractSchemaDigestV1,
  computerUseContractCatalogueV1Schema,
  type ComputerUseContractCatalogueEntry,
  type ComputerUseContractCatalogueV1,
} from "./schema";

const provenance = (schemaDigest: string) => ({
  reviewedSchemaDigest: schemaDigest,
  effectClass: "server_reviewed" as const,
  replayClass: "server_reviewed" as const,
  authorityClass: "server_reviewed" as const,
  attachmentClass: "server_reviewed" as const,
  disclosureClass: "server_reviewed" as const,
});

const entry = (
  descriptor: ComputerUseContractCatalogueEntry["descriptor"],
  schemas: Readonly<{ input: z.ZodType; result: z.ZodType }>,
  projection: ComputerUseContractCatalogueEntry["projection"],
  executionLane: ComputerUseContractCatalogueEntry["executionLane"],
  scheduling?: ComputerUseContractCatalogueEntry["scheduling"],
): ComputerUseContractCatalogueEntry => {
  const asJsonDocument = (schema: z.ZodType) => JSON.parse(
    JSON.stringify(z.toJSONSchema(schema)),
  ) as ComputerUseContractCatalogueEntry["publicSchemas"]["input"]["jsonSchema"];
  const publicSchemas = {
    input: {
      schemaId: `${descriptor.contractNamespace}.${descriptor.contractId}.input`,
      schemaVersion: descriptor.contractVersion,
      jsonSchema: asJsonDocument(schemas.input),
    },
    result: {
      schemaId: `${descriptor.contractNamespace}.${descriptor.contractId}.result`,
      schemaVersion: descriptor.contractVersion,
      jsonSchema: asJsonDocument(schemas.result),
    },
  };
  const schemaDigest = computeComputerUseContractSchemaDigestV1(publicSchemas);
  return {
    descriptor: { ...descriptor, schemaDigest },
    executionLane,
    publicSchemas,
    projection,
    classificationProvenance: provenance(schemaDigest),
    ...(scheduling === undefined ? {} : { scheduling }),
  };
};

export const bundledComputerUseContractCatalogue: ComputerUseContractCatalogueV1 =
  computerUseContractCatalogueV1Schema.parse({
    formatVersion: 1,
    catalogueVersion: "2026-09-20.1",
    publishedAt: "2026-09-20T00:42:14.000Z",
    provenance: "bundled",
    modelGuidance: `### Computer Use
For native window_state without a selector, controlCollection exposes the received controls together with local id/parent relationships, observed labels/state and opaque action targets. Use a returned target directly for the requested native action; do not reselect by role/label when duplicate labels already have distinct references. Local ids describe this observation only, not stable application identity. Missing targets are informational controls, not writable capabilities. The collection is partial: absent controls are not proof of absence; use an appropriate query/traversal effort or fresh visual evidence when needed. An action retires sibling controls from that snapshot, so observe again before the next action. No role or advisory action list determines which operation a control accepts; Cua reports the actual result. If the controls cannot be distinguished semantically, use current visual evidence rather than guessing.
For a unique window_state control selection, element.state reports the provider's current value, valueDescription, selected state and numeric range when exposed. Missing fields are unknown, not empty, unchecked, or zero. State is partial accessibility evidence: a reported value may be a placeholder or renderer echo. Use it to choose the requested set_value/key/pointer action, then obtain fresh state and verify the actual effect; do not infer a slider's value from how many keys were sent. No eligible decision model is required to use these native controls.

For a single-file rename, first verify that only the intended file is selected. A filename editor may initially select the basename but leave the extension outside the selection: type_text inserts at that selection, whereas set_value replaces the whole native value. To replace an exact filename, use set_value on a current editable field; if semantic delivery is unavailable, use a fresh screenshot to identify the active editor, select its whole value (including the extension), and type the full filename. Verify the draft, commit once, then verify the editor has closed and the new filename exists. An edited draft is not a committed rename. Window images can omit app-level menus and inline editors; inspect a fresh desktop image when the pending UI is missing from the window image. If a semantic write is not_delivered with targetCondition unavailable, do not repeatedly reselect the same semantic control: take fresh visual evidence and use the supported pixel/desktop route. Never remove window identity checks, assume a different window owns the editor, or replay an uncertain commit.
Prefer current semantic or accessibility targets and use returned opaque targets directly; reacquire only when a result says the target is stale or invalid, the requested scope changes, or fresh evidence is needed, rather than reflexively rediscovering applications, windows, tabs, or elements. A query is a literal case-insensitive substring matched against accessibility labels and values, not a place for instructions; use a short expected text such as "Settings" or "Submit", and omit query for unfiltered enumeration. Application-window inventory completeness is separate from non-exhaustive content matching: zero matches never means zero windows, and queried candidates still return fresh usable window targets. A query-unavailable candidate was not searched and is not a zero match; follow its focus_target or observe_again recovery using that fresh target. Escalate from semantic state to a fresh matching pixel region, and use exact foreground or focus recovery only when instructed, then reacquire fresh authority. Bind one existing browser window, prepare only when requested, and retain its returned browser and tab lifecycle. Scope reads and follow continuations when needed; omissions and zero matches are not proof of absence. Trust Host-verified postconditions and finish when they establish the requested outcome. After a delivered effect without a verified postcondition, obtain fresh state; after an uncertain effect, observe without replaying the mutation.`,
    contracts: [
      entry(COMPUTER_USE_BROWSER_CONTRACTS.bindWindow, BROWSER_CONTRACT_SCHEMAS.bindWindow, {
        toolName: "computer_browser_bind_window",
        modelDescription: "Bind one exact opaque native browser window before browser-specific reading or actions.",
        label: "Bind browser window",
        summary: "Bind one exact native browser window to a browser automation context.",
        argumentsSummary: "One opaque native window target.",
        resultSummary: "An exact browser target with its current tabs, or bounded recovery.",
      }, "host"),
      entry(COMPUTER_USE_BROWSER_CONTRACTS.prepare, BROWSER_CONTRACT_SCHEMAS.prepare, {
        toolName: "computer_browser_prepare",
        modelDescription: "Explicitly prepare one authorized existing browser profile after bind reports setup is required. On success use the returned exact browser target and tabs from that same retained session without binding again. On failure follow failure.reason, stage, stateChangeCertainty and retryCondition: a setup-control ambiguity needs a supported native route or driver repair, not another observation/preparation loop. After changed or unknown effects obtain a fresh native target for the same window and call computer_browser_bind_window to inspect the retained session without replaying preparation. If that bind succeeds, continue with its browser target and tabs; otherwise follow the native recovery route. Never interpret a failed follow-up bind as proof that setup changed nothing.",
        label: "Prepare existing browser",
        summary: "Prepare and bind the authorized existing browser endpoint in one retained session.",
        argumentsSummary: "One fresh opaque native browser-window target.",
        resultSummary: "Bounded setup side effects plus an exact usable browser target and tabs, or recovery.",
      }, "host"),
      entry(COMPUTER_USE_BROWSER_CONTRACTS.openUrl, BROWSER_CONTRACT_SCHEMAS.openUrl, {
        toolName: "computer_browser_open_url",
        modelDescription: "Open one HTTP, HTTPS, or about URL in exactly one new tab of an already-bound existing browser window. This operation performs tab creation, exact URL attribution, navigation, and a fresh semantic page read; do not bind, create a browser window, or replay it.",
        label: "Open URL in new browser tab",
        summary: "Open and read one URL in exactly one new tab of an existing bound browser window.",
        argumentsSummary: "One opaque browser target plus the public destination URL.",
        resultSummary: "A fresh semantic page outline and exact new tab, delivered-with-observe recovery, or bounded no-replay failure.",
      }, "host"),
      entry(COMPUTER_USE_BROWSER_CONTRACTS.click, BROWSER_CONTRACT_SCHEMAS.click, {
        toolName: "computer_browser_click",
        modelDescription: "Click one exact opaque element in a bound browser tab, then obtain fresh state before further action. Choose inputRoute explicitly: trusted requests real browser input; dom_event requests a synthetic page event suitable for ordinary links and controls when that semantics satisfies the task. Standalone macOS/Linux browsers may refuse trusted background input. After not_delivered, inspect failure.inputRoute and escalation, obtain a fresh element reference, and explicitly choose dom_event if suitable or the native action route. Do not silently change trust class, assume a synthetic event satisfies a trust-gated control, or replay unknown completion.",
        label: "Click browser element",
        summary: "Click one exact element in one exact bound browser tab.",
        argumentsSummary: "Opaque browser, tab, and element targets plus the requested input route.",
        resultSummary: "Delivery certainty and a mandatory fresh-observation instruction.",
      }, "host"),
      entry(COMPUTER_USE_BROWSER_CONTRACTS.navigate, BROWSER_CONTRACT_SCHEMAS.navigate, {
        toolName: "computer_browser_navigate",
        modelDescription: "Navigate one exact opaque bound browser tab without using a browser-specific provider path.",
        label: "Navigate browser",
        summary: "Navigate one exact bound browser tab to an HTTP, HTTPS, or about URL.",
        argumentsSummary: "Opaque browser and tab targets plus a public destination URL.",
        resultSummary: "Delivery certainty and a mandatory fresh-observation instruction.",
      }, "host"),
      entry(COMPUTER_USE_BROWSER_CONTRACTS.readPage, BROWSER_CONTRACT_SCHEMAS.readPage, {
        toolName: "computer_browser_read_page",
        modelDescription: "Read bounded semantic content and opaque element references from one exact bound browser tab. Reads never activate, reload, or navigate a tab. For failure.reason page_unavailable, use native observation to inspect the same existing tab; if it is discarded or needs activation, select that exact tab through a fresh native target or screenshot when foreground control is authorized, then retry the read with the retained browser/tab targets. Do not create a replacement tab, repeat preparation, or assume every unavailable page is discarded. An inactive but loaded tab can be read in the background.",
        label: "Read browser page",
        summary: "Read bounded semantic content and references from one exact browser tab.",
        argumentsSummary: "Opaque browser and tab targets with optional query, scope, or continuation.",
        resultSummary: "Bounded page outline, references, omissions, and continuation or recovery.",
      }, "host", { readConcurrency: "host_coordinated" }),
      entry(COMPUTER_USE_BROWSER_CONTRACTS.type, BROWSER_CONTRACT_SCHEMAS.type, {
        toolName: "computer_browser_type",
        modelDescription: "Type into one exact opaque browser element; do not replay uncertain completion.",
        label: "Type in browser element",
        summary: "Type text into one exact element in one exact bound browser tab.",
        argumentsSummary: "Opaque browser, tab, and element targets plus text and input mode.",
        resultSummary: "Delivery certainty and a mandatory fresh-observation instruction.",
      }, "host"),
      entry(COMPUTER_USE_BROWSER_CONTRACTS.pointer, BROWSER_CONTRACT_SCHEMAS.pointer, {
        toolName: "computer_browser_pointer",
        modelDescription: "Hover, right-click, double-click, scroll, or drag using current opaque semantic browser references; never replay uncertain completion.",
        label: "Use browser pointer",
        summary: "Perform one semantic pointer action in one exact bound browser tab.",
        argumentsSummary: "Opaque browser, tab, origin, and optional destination targets plus the exact pointer action.",
        resultSummary: "Delivery certainty and a mandatory fresh-observation instruction.",
      }, "host"),
      entry(COMPUTER_USE_NATIVE_CONTRACTS.do, NATIVE_CONTRACT_SCHEMAS.do, {
        toolName: "computer_do",
        modelDescription: "Perform one exact context-bound native Computer Use action. Select an existing control with computer_observe window_state selector: {role: the observed role, action: type_text, set_value, scroll, or click}; use labelEquals when needed. type_text inserts at the control's current selection; it does not require an empty or newly created document. set_value replaces the native value; supply its string representation and let Cua perform native coercion. Scroll can target a nested scroll area, list, outline, or other observed control without requiring text-area geometry. Role names and advisory AX actions are not capability whitelists: Cua reports whether the operation worked. For an ordinary click-selected element, axAction can request press, show_menu, pick, confirm, cancel, or open. A fresh snapshot click supports button left/right/middle, positive count, and cmd/shift/option/alt/ctrl modifiers. Modified window clicks require deliveryMode foreground; unmodified window clicks default to background. Desktop snapshot clicks are inherently foreground. Preserve Cua's actual delivery mode and obtain fresh state to verify the effect; never replay an uncertain click. For drag_drop, choose a window/precision image for local gestures or one fresh desktop image for a gesture across visible windows; both endpoints must be grounded in that image. Supply durationMs, steps, button and modifiers when needed, or omit them for Cua defaults. macOS drag uses foreground input. Delivery is not proof of a file move, copy or selection: observe the destination and source afterward. Preserve any pixel-verification recommendation; an AX value echo alone cannot override it.",
        label: "Control native computer state",
        summary: "Perform one exact Cua native action under a fresh context-bound authority.",
        argumentsSummary: "One native action on an opaque target. press_key sends a key plus optional modifiers. hotkey sends keys such as [cmd, shift, s]: supported Cua modifiers followed by one base key, not a sequence; no app-specific shortcut whitelist. Both accept a window, a control selected with action: press_key, a fresh window/region screenshot point, or explicit scope: desktop with a fresh desktop snapshot and no coordinates. Pixel keyboard input focuses that point before delivery; desktop keyboard input uses current focus. Element/window input accepts deliveryMode: foreground when background delivery is unsuitable. type_text inserts at the selection and accepts optional delayMs for Cua synthesis pacing. move_pointer uses scope: desktop and presented_snapshot_pixels to move the real pointer for hover, not the overlay. Scroll up/down/left/right by line/page on a control or fresh screenshot. An acknowledged chord may still suggest foreground; observe its effect before deciding what to do, and never automatically replay it. Keep the result receipt and reacquire fresh state after any unverified input.",
        resultSummary: "A content-safe action receipt with completion certainty, verification, and replay guidance.",
      }, "host"),
      entry(COMPUTER_USE_NATIVE_CONTRACTS.observe, NATIVE_CONTRACT_SCHEMAS.observe, {
        toolName: "computer_observe",
        modelDescription: "Observe compact native Computer Use state and obtain opaque follow-up targets. For a native click, select with the role reported by observation and action: click; add interaction: right_click or double_click when needed, then pass the returned element target to computer_do click. Role names are evidence labels, not a list of allowed controls. Use labelEquals to disambiguate; advisory AX actions do not prohibit an attempt. One exact-window request may combine a literal query, control selector, window snapshot, and traversal effort so all returned evidence belongs to one fresh provider read. Query is a short case-insensitive substring matched against accessibility labels and values, such as `Settings` or `Submit`; it is not an instruction field. Omit query to enumerate windows without searching their content. When window titles are insufficient, query one exact window or the complete private candidate set for bounded positive label/value snippets. Application-window inventory completeness is separate from non-exhaustive content matching: queried candidates retain fresh usable window targets even with zero matches. A semanticQueryUnavailable candidate was not searched and is not a zero match; use its fresh target with the reported focus_target or observe_again recovery. Omit effort to use Cua's provider defaults; when missing or ambiguous evidence matters, repeat with explicitly greater maxElements and/or maxDepth. Every query remains non-exhaustive, so zero never proves absence and increased effort never promises a match. If an exact window observation returns recovery focus_target, focus that same opaque window target once with computer_do, then reacquire fresh authority before inspecting or acting. Use window_region on a fresh window snapshot to isolate a difficult visual area; its replacement snapshot supports precise click, type, key, and scroll coordinates. Multiple positive candidates remain ambiguous.",
        label: "Observe native computer state",
        summary: "Observe bounded desktop, exact-window, application-window, or precision-region state with fresh opaque targets.",
        argumentsSummary: "A typed observation using opaque context-bound targets, an optional literal label/value substring query with exact traversal effort, or an exact rectangle in a fresh snapshot.",
        resultSummary: "Compact semantic state, window-inventory completeness separate from non-exhaustive literal-match truth, recovery, and separately framed actionable visual evidence.",
      }, "host", { readConcurrency: "host_coordinated" }),
      entry(COMPUTER_USE_NATIVE_CONTRACTS.verify, NATIVE_CONTRACT_SCHEMAS.verify, {
        toolName: "computer_verify",
        modelDescription: "Verify one exact opaque native Computer Use target without exposing raw driver data.",
        label: "Verify native computer state",
        summary: "Verify bounded predicates against one exact native window target.",
        argumentsSummary: "One opaque window target and one or more public predicates within the admitted control frame.",
        resultSummary: "Predicate statuses, stability, timing, and normalized recovery without observed values.",
      }, "host"),
    ].sort((left, right) => {
      const a = left.descriptor;
      const b = right.descriptor;
      return `${a.contractNamespace}\u0000${a.contractId}\u0000${a.contractVersion}`
        .localeCompare(`${b.contractNamespace}\u0000${b.contractId}\u0000${b.contractVersion}`);
    }),
  });

export type ComputerUseContractProjection = Readonly<{
  catalogueVersion: string;
  contracts: readonly Readonly<{
    contractId: string;
    contractVersion: number;
    label: string;
    summary: string;
    effectClass: ComputerUseContractCatalogueEntry["descriptor"]["effectClass"];
    replayClass: ComputerUseContractCatalogueEntry["descriptor"]["replayClass"];
    disclosureClass: ComputerUseContractCatalogueEntry["descriptor"]["disclosureClass"];
  }>[];
}>;

/** Compact model-facing metadata; schema IDs, digests, and release proof stay server-private. */
export function projectComputerUseContractCatalogue(
  catalogue: ComputerUseContractCatalogueV1,
): ComputerUseContractProjection {
  return {
    catalogueVersion: catalogue.catalogueVersion,
    contracts: catalogue.contracts.map(({ descriptor, projection }) => ({
      contractId: descriptor.contractId,
      contractVersion: descriptor.contractVersion,
      label: projection.label,
      summary: projection.summary,
      effectClass: descriptor.effectClass,
      replayClass: descriptor.replayClass,
      disclosureClass: descriptor.disclosureClass,
    })),
  };
}
