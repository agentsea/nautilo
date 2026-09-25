import { z } from "zod";
import { CUA_MACOS_KEY_PATTERN, CUA_MACOS_KEY_MODIFIERS, normalizeCuaMacosHotkey } from "./native-keyboard.js";
export { CUA_MACOS_KEY_NAMES, CUA_MACOS_KEY_PATTERN, CUA_MACOS_KEY_MODIFIERS, normalizeCuaMacosKey, normalizeCuaMacosHotkey } from "./native-keyboard.js";
import { computeComputerUseSchemaDigest } from "./schema-digest.js";
import {
  computerAppTargetReferenceSchema as sharedComputerAppTargetReferenceSchema,
  computerContextReferenceSchema as sharedComputerContextReferenceSchema,
  computerElementTargetReferenceSchema as sharedComputerElementTargetReferenceSchema,
  computerOperationOutcomeSchema,
  computerScreenSnapshotReferenceSchema as sharedComputerScreenSnapshotReferenceSchema,
  computerTargetReferenceSchema as sharedComputerTargetReferenceSchema,
  computerWindowTargetReferenceSchema as sharedComputerWindowTargetReferenceSchema,
} from "./index.js";

export { computerOperationOutcomeSchema };

const computerContextReferenceSchema = sharedComputerContextReferenceSchema
  .describe("Opaque context reference returned by computer_observe");

const computerWindowTargetReferenceSchema = sharedComputerWindowTargetReferenceSchema
  .describe("Exact opaque window target reference from the same observation context");

const computerAppTargetReferenceSchema = sharedComputerAppTargetReferenceSchema
  .describe("Exact opaque application target reference from the same observation context");

const computerScreenSnapshotReferenceSchema = sharedComputerScreenSnapshotReferenceSchema
  .describe("Exact opaque screen snapshot reference from the same observation context");

const computerElementTargetReferenceSchema = sharedComputerElementTargetReferenceSchema
  .describe("Exact opaque element target returned by a fresh window observation");

const computerTargetReferenceSchema = sharedComputerTargetReferenceSchema
  .describe("Exact opaque desktop target reference from the same observation context");

const positiveSafeIntegerSchema = z
  .number()
  .finite()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "must be a positive safe integer");
const nonnegativeSafeIntegerSchema = z
  .number()
  .finite()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "must be a nonnegative safe integer");
const nonnegativeFinitePresentedCoordinateSchema = z
  .number()
  .finite()
  .nonnegative()
  .describe("Nonnegative coordinate in presented snapshot pixels");

const computerScreenSnapshotDimensionsSchema = z
  .object({
    width: positiveSafeIntegerSchema,
    height: positiveSafeIntegerSchema,
  })
  .strict();

/**
 * Content-free PNG evidence for one exact snapshot. `origin` gives the
 * display-local image an explicit desktop coordinate placement. Native and
 * presented pixel dimensions are exact ratio facts; click operations name the
 * presented frame explicitly. There is no arbitrary dimension ceiling here:
 * the provider's actual capture bounds are reported rather than silently
 * resized or truncated.
 */
const computerScreenSnapshotMetadataSchema = z
  .object({
    format: z.literal("png"),
    nativeDimensions: computerScreenSnapshotDimensionsSchema,
    presentedDimensions: computerScreenSnapshotDimensionsSchema,
    display: z
      .object({
        coordinateSpace: z.literal("desktop_pixels"),
        origin: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
      })
      .strict(),
  })
  .strict();

/**
 * An opaque snapshot plus enough non-content geometry to bind subsequent
 * coordinate actions. PNG bytes, base64, paths, provider identifiers, PIDs,
 * windows and session data never cross this contract.
 */
const computerScreenSnapshotSchema = z
  .object({
    target: computerScreenSnapshotReferenceSchema,
    evidence: z.object({ kind: z.literal("screen") }).strict(),
    metadata: computerScreenSnapshotMetadataSchema,
  })
  .strict();

/** Exact fresh window image used as Cua's window-local pixel frame. */
const computerWindowSnapshotSchema = z
  .object({
    target: computerScreenSnapshotReferenceSchema,
    evidence: z.object({ kind: z.literal("screen") }).strict(),
    metadata: z.object({
      format: z.literal("png"),
      dimensions: computerScreenSnapshotDimensionsSchema,
      coordinateSpace: z.literal("window_snapshot_pixels"),
    }).strict(),
  })
  .strict();

/** Host-derived precision view whose pixels map privately to one exact window. */
const computerWindowRegionSnapshotSchema = z
  .object({
    target: computerScreenSnapshotReferenceSchema,
    evidence: z.object({ kind: z.literal("screen") }).strict(),
    metadata: z.object({
      format: z.literal("png"),
      dimensions: computerScreenSnapshotDimensionsSchema,
      coordinateSpace: z.literal("presented_snapshot_pixels"),
    }).strict(),
  })
  .strict();

const computerSnapshotRegionSchema = z.object({
  x: nonnegativeSafeIntegerSchema,
  y: nonnegativeSafeIntegerSchema,
  width: positiveSafeIntegerSchema,
  height: positiveSafeIntegerSchema,
}).strict();

const computerWindowRegionObserveInputSchema = z.object({
  operation: z.literal("window_region"),
  target: computerScreenSnapshotReferenceSchema,
  coordinateSpace: z.enum(["window_snapshot_pixels", "presented_snapshot_pixels"]),
  region: computerSnapshotRegionSchema,
}).strict();

const computerDesktopStateObserveInputSchema = z
  .object({
    operation: z.literal("desktop_state"),
    continuation: z
      .object({
        version: z.literal(1),
        context: computerContextReferenceSchema,
        reference: z.string().regex(/^dcont_[A-Za-z0-9_-]{43}$/),
      })
      .strict()
      .optional()
      .describe("Opaque continuation returned by a prior partial desktop_state observation"),
    maxWindows: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum windows to return; omit for the bounded default"),
  })
  .strict();

const computerObservationBoundarySchema = z
  .object({
    kind: z.enum(["none", "response_limit", "provider_limit", "permission_limit"]),
    retryable: z.boolean(),
  })
  .strict();

/**
 * A normalized, content-free operational disposition. It lets Genie decide
 * whether to retry, re-observe, request access, or stop without inspecting
 * provider stderr or guessing whether an action may have happened.
 */
const computerObservationAlternativeSchema = z
  .object({
    kind: z.enum(["observe_again", "request_access", "focus_target"]),
    available: z.boolean(),
  })
  .strict();

const computerObservationContinuationSchema = z
  .object({
    version: z.literal(1),
    reference: z.string().regex(/^dcont_[A-Za-z0-9_-]{43}$/),
  })
  .strict();

const computerUninspectedObservationSchema = z
  .object({
    /** Exact number of application records not queried due to a provider fan-out bound. */
    applications: z.number().int().nonnegative(),
    /** Exact lower bound for windows not retained after their provider list was read. */
    knownWindows: z.number().int().nonnegative(),
    /** False means unqueried applications may contain further unknown windows. */
    windowCountExact: z.boolean(),
  })
  .strict();

const sanitizedTargetLabelSchema = z
  .string()
  .min(1)
  // Use a published JSON-Schema pattern rather than an opaque Zod refinement:
  // the signed catalogue and Host must accept the same public byte language.
  .regex(/^(?![\s\S]*[\p{Cc}\p{Zl}\p{Zp}])[\s\S]+$/u, "target labels cannot contain control or line-separator characters")
  .describe("Provider-observed label with control and line separators removed; the enclosing control frame supplies the byte boundary");

/**
 * A Human-readable application identity is the only launch selector Genie may
 * provide. Provider bundle IDs, paths, URLs, arguments and native launch
 * controls remain adapter-local.
 */
const computerSemanticAppNameSchema = sanitizedTargetLabelSchema
  .regex(
    /^(?!\s)(?![\s\S]*\s$)(?![\s\S]*[\\/])(?![A-Za-z][A-Za-z0-9+.-]*:)(?![A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$)[\s\S]+$/u,
    "application name cannot be a path, URL, or bundle identifier",
  )
  .describe("Semantic application name; never a bundle id, path, URL, argument or provider identifier");

/** Role labels select evidence; they are not an operation allowlist. */
const computerNativeRoleSchema = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u)
  .describe("Observed native role in snake_case, for example row, link, radio_button or outline. Not an app-specific whitelist.");
const explicitTextSelectorSchema = z.object({ role: computerNativeRoleSchema, action: z.literal("type_text"), labelEquals: sanitizedTargetLabelSchema.optional() }).strict();
const explicitValueSelectorSchema = z.object({ role: computerNativeRoleSchema, action: z.literal("set_value"), labelEquals: sanitizedTargetLabelSchema.optional() }).strict();
// Omitted actions preserve legacy convenience calls; explicit actions select
// any observed role, not a second list of approved control classes.
const legacyTextSelectorSchema = z.object({ role: z.literal("text_area"), labelEquals: sanitizedTargetLabelSchema.optional() }).strict();
const legacyValueSelectorSchema = z.object({ role: z.enum(["text_field", "combo_box", "slider"]), labelEquals: sanitizedTargetLabelSchema.optional() }).strict();
const computerTextElementSelectorSchema = z.union([legacyTextSelectorSchema, explicitTextSelectorSchema]);
const computerValueElementSelectorSchema = z.union([legacyValueSelectorSchema, explicitValueSelectorSchema]);
const computerTextElementResultSelectorSchema = z.union([legacyTextSelectorSchema.omit({ labelEquals: true }), explicitTextSelectorSchema.omit({ labelEquals: true })]);
const computerValueElementResultSelectorSchema = z.union([legacyValueSelectorSchema.omit({ labelEquals: true }), explicitValueSelectorSchema.omit({ labelEquals: true })]);
const computerClickElementRoleSchema = computerNativeRoleSchema;
const computerScrollElementSelectorSchema = z.object({ role: computerNativeRoleSchema, action: z.literal("scroll"), labelEquals: sanitizedTargetLabelSchema.optional() }).strict();
const computerKeyElementSelectorSchema = z.object({ role: computerNativeRoleSchema, action: z.literal("press_key"), labelEquals: sanitizedTargetLabelSchema.optional() }).strict();
const computerClickElementSelectorSchema = z.union([
  z.object({
    role: z.enum(["button", "checkbox"]),
    /** Omitted means the ordinary AXPress path. */
    interaction: z.enum(["right_click", "double_click"]).optional(),
    /** Exact semantic disambiguator supplied by Genie; never echoed by the result. */
    labelEquals: sanitizedTargetLabelSchema.optional(),
  }).strict(),
  z.object({
    role: computerNativeRoleSchema,
    action: z.literal("click"),
    interaction: z.enum(["right_click", "double_click"]).optional(),
    labelEquals: sanitizedTargetLabelSchema.optional(),
  }).strict(),
]);
const computerClickElementResultSelectorSchema = z.union([
  z.object({ role: z.enum(["button", "checkbox"]), interaction: z.enum(["right_click", "double_click"]).optional() }).strict(),
  z.object({ role: computerNativeRoleSchema, action: z.literal("click"), interaction: z.enum(["right_click", "double_click"]).optional() }).strict(),
]);
const computerElementRequestSelectorSchema = z.union([
  computerTextElementSelectorSchema,
  computerValueElementSelectorSchema,
  computerClickElementSelectorSchema,
  computerScrollElementSelectorSchema,
  computerKeyElementSelectorSchema,
]);

/** Fresh provider-reported content, separate from retained action authority.
 * Missing attributes are unknown, not empty/false. Accessibility values can
 * include placeholders or renderer echoes; task verification remains explicit.
 */
export const computerNativeControlStateSchema = z.object({
  completeness: z.literal("partial"),
  value: z.string().optional(),
  valueDescription: z.string().optional(),
  selected: z.boolean().optional(),
  range: z.object({ minimum: z.number().finite(), maximum: z.number().finite() }).strict()
    .refine((range) => range.maximum > range.minimum, "a provider range must have increasing endpoints").optional(),
}).strict().describe("Partial accessibility state for the selected control. Missing fields are unknown. Provider values may include placeholders or renderer echoes; they are not independent proof of task completion.");
export type ComputerNativeControlState = z.infer<typeof computerNativeControlStateSchema>;

/** A compact view of all rows received from one native snapshot. References
 * identify controls, not guessed capabilities; ordinary action schemas still
 * govern dispatch, and Cua reports whether the control accepts the operation. */
export const computerNativeControlCollectionSchema = z.object({
  completeness: z.literal("partial"),
  received: nonnegativeSafeIntegerSchema,
  omitted: nonnegativeSafeIntegerSchema,
  controls: z.array(z.object({
    id: z.string().regex(/^c[0-9]+$/),
    parent: z.string().regex(/^c[0-9]+$/).optional(),
    role: computerNativeRoleSchema,
    label: sanitizedTargetLabelSchema.optional(),
    enabled: z.boolean().optional(),
    target: computerElementTargetReferenceSchema.optional(),
    state: computerNativeControlStateSchema,
  }).strict()),
}).strict().superRefine((value, context) => {
  const ids = new Set(value.controls.map((control) => control.id));
  if (ids.size !== value.controls.length || value.received !== value.controls.length + value.omitted) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "control collection identity and accounting must agree" });
  }
  for (const control of value.controls) {
    if (control.parent !== undefined && (control.parent === control.id || !ids.has(control.parent))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "control parent must name another returned control" });
    }
    if (control.enabled === false && control.target !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "disabled controls cannot publish action targets" });
    }
  }
});
export type ComputerNativeControlCollection = z.infer<typeof computerNativeControlCollectionSchema>;

const computerTextElementEvidenceSchema = z
  .object({
    kind: z.literal("element"),
    role: computerNativeRoleSchema,
    action: z.literal("type_text"),
    enabled: z.boolean().optional(),
  })
  .strict();

const computerTextElementSelectionSchema = z
  .object({
    selector: computerTextElementResultSelectorSchema,
    disposition: z.enum(["zero", "unique", "ambiguous", "incomplete"]),
    target: computerElementTargetReferenceSchema.optional(),
    evidence: computerTextElementEvidenceSchema.optional(),
    state: computerNativeControlStateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const unique = value.disposition === "unique";
    if (unique !== (value.target !== undefined) || unique !== (value.evidence !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "only a unique text-element resolution may publish an element target" });
    }
    if (value.evidence !== undefined && value.evidence.role !== value.selector.role) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "text-element evidence must preserve the selected role" });
    }
  });

const computerValueElementEvidenceSchema = z
  .object({
    kind: z.literal("element"),
    role: computerNativeRoleSchema,
    action: z.literal("set_value"),
    enabled: z.boolean().optional(),
  })
  .strict();

const computerValueElementSelectionSchema = z
  .object({
    selector: computerValueElementResultSelectorSchema,
    disposition: z.enum(["zero", "unique", "ambiguous", "incomplete"]),
    target: computerElementTargetReferenceSchema.optional(),
    evidence: computerValueElementEvidenceSchema.optional(),
    state: computerNativeControlStateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const unique = value.disposition === "unique";
    if (unique !== (value.target !== undefined) || unique !== (value.evidence !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "only a unique value-control resolution may publish an element target" });
    }
    if (value.evidence !== undefined && value.evidence.role !== value.selector.role) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "value-control evidence must preserve the selected semantic role" });
    }
  });

const computerClickElementEvidenceSchema = z
  .object({
    kind: z.literal("element"),
    role: computerClickElementRoleSchema,
    action: z.enum(["click", "right_click", "double_click"]),
    enabled: z.boolean().optional(),
  })
  .strict();

const computerClickElementSelectionSchema = z
  .object({
    selector: computerClickElementResultSelectorSchema,
    disposition: z.enum(["zero", "unique", "ambiguous", "incomplete"]),
    target: computerElementTargetReferenceSchema.optional(),
    evidence: computerClickElementEvidenceSchema.optional(),
    state: computerNativeControlStateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const unique = value.disposition === "unique";
    if (unique !== (value.target !== undefined) || unique !== (value.evidence !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "only a unique click-control resolution may publish an element target" });
    }
    if (value.evidence !== undefined && value.evidence.role !== value.selector.role) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "click-control evidence must preserve the selected semantic role" });
    }
    const expectedAction = value.selector.interaction ?? "click";
    if (value.evidence !== undefined && value.evidence.action !== expectedAction) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "click-control evidence must preserve the selected semantic interaction" });
    }
  });

const computerScrollElementEvidenceSchema = z
  .object({ kind: z.literal("element"), role: computerNativeRoleSchema, action: z.literal("scroll"), enabled: z.boolean().optional() })
  .strict();

const computerScrollElementSelectionSchema = z
  .object({
    selector: computerScrollElementSelectorSchema.omit({ labelEquals: true }),
    disposition: z.enum(["zero", "unique", "ambiguous", "incomplete"]),
    target: computerElementTargetReferenceSchema.optional(),
    evidence: computerScrollElementEvidenceSchema.optional(),
    state: computerNativeControlStateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const unique = value.disposition === "unique";
    if (unique !== (value.target !== undefined) || unique !== (value.evidence !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "only a unique scroll-candidate resolution may publish an element target" });
    }
    if (value.evidence !== undefined && value.evidence.role !== value.selector.role) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "scroll-candidate evidence must preserve the selected role" });
    }
  });

const computerKeyElementEvidenceSchema = z.object({
  kind: z.literal("element"), role: computerNativeRoleSchema, action: z.literal("press_key"), enabled: z.boolean().optional(),
}).strict();
const computerKeyElementSelectionSchema = z.object({
  selector: computerKeyElementSelectorSchema.omit({ labelEquals: true }),
  disposition: z.enum(["zero", "unique", "ambiguous", "incomplete"]),
  target: computerElementTargetReferenceSchema.optional(),
  evidence: computerKeyElementEvidenceSchema.optional(),
  state: computerNativeControlStateSchema.optional(),
}).strict().superRefine((value, context) => {
  const unique = value.disposition === "unique";
  if (unique !== (value.target !== undefined) || unique !== (value.evidence !== undefined)
    || value.evidence !== undefined && value.evidence.role !== value.selector.role) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "only a unique same-role key target may publish element authority" });
  }
});

const computerElementSelectionSchema = z.union([
  computerTextElementSelectionSchema,
  computerValueElementSelectionSchema,
  computerClickElementSelectionSchema,
  computerScrollElementSelectionSchema,
  computerKeyElementSelectionSchema,
]).superRefine((value, context) => {
  if (value.state !== undefined && value.disposition !== "unique") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "control state belongs only to one freshly selected element" });
  }
});

const computerWindowSemanticQuerySchema = sanitizedTargetLabelSchema
  .max(240)
  .refine((value) => value.trim() === value, "window semantic query cannot have surrounding whitespace")
  .describe("Literal case-insensitive substring to match against window accessibility labels and values; omit it to enumerate windows without filtering content");

const computerWindowTraversalEffortSchema = z.union([
  z.object({
    maxElements: positiveSafeIntegerSchema,
    maxDepth: positiveSafeIntegerSchema.optional(),
  }).strict(),
  z.object({
    maxElements: positiveSafeIntegerSchema.optional(),
    maxDepth: positiveSafeIntegerSchema,
  }).strict(),
]);

const computerWindowSemanticMatchRoleSchema = computerNativeRoleSchema;

const computerWindowSemanticMatchSchema = z
  .object({
    role: computerWindowSemanticMatchRoleSchema,
    label: sanitizedTargetLabelSchema.optional(),
    value: sanitizedTargetLabelSchema.optional(),
    labelTruncated: z.boolean(),
    valueTruncated: z.boolean(),
  })
  .strict()
  .refine((value) => value.label !== undefined || value.value !== undefined, "a semantic match requires a label or value")
  .refine((value) => value.label !== undefined || !value.labelTruncated, "an absent semantic label cannot be truncated")
  .refine((value) => value.value !== undefined || !value.valueTruncated, "an absent semantic value cannot be truncated");

const computerWindowSemanticQueryResultSchema = z
  .object({
    query: computerWindowSemanticQuerySchema,
    effort: computerWindowTraversalEffortSchema.optional(),
    exhaustive: z.literal(false),
    matched: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
    matches: z.array(computerWindowSemanticMatchSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.returned + value.omitted !== value.matched || value.matches.length !== value.returned) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "semantic-query accounting must match returned snippets" });
    }
  });

const computerWindowSemanticQueryUnavailableSchema = z.object({
  query: computerWindowSemanticQuerySchema,
  status: z.literal("unavailable"),
  recovery: z.enum(["focus_target", "observe_again"]),
}).strict();

const computerWindowStateObserveBaseShape = {
  operation: z.literal("window_state"),
  target: computerWindowTargetReferenceSchema,
} as const;

const computerWindowStateObserveInputSchema = z.object({
  ...computerWindowStateObserveBaseShape,
  selector: computerElementRequestSelectorSchema.optional(),
  capture: z.literal("window_snapshot").optional(),
  query: computerWindowSemanticQuerySchema.optional(),
  effort: computerWindowTraversalEffortSchema.optional(),
}).strict();

const computerWindowStateObserveWithoutElementInputSchema = z.object({
  ...computerWindowStateObserveBaseShape,
  capture: z.literal("window_snapshot").optional(),
  query: computerWindowSemanticQuerySchema.optional(),
  effort: computerWindowTraversalEffortSchema.optional(),
}).strict();

const computerApplicationWindowsObserveInputSchema = z.union([
  z.object({
    operation: z.literal("application_windows"),
    target: computerAppTargetReferenceSchema,
  }).strict(),
  z.object({
    operation: z.literal("application_windows"),
    target: computerAppTargetReferenceSchema,
    query: computerWindowSemanticQuerySchema,
    effort: computerWindowTraversalEffortSchema.optional(),
  }).strict(),
]);

/** Exact semantic observation grammar; desktop and window scopes never mix. */
export const computerObserveInputSchema = z.union([
  computerDesktopStateObserveInputSchema,
  computerWindowStateObserveInputSchema,
  computerApplicationWindowsObserveInputSchema,
  computerWindowRegionObserveInputSchema,
]);

/** Targeted observation needs an explicit route fact; it is never provider-inferred. */
export function createComputerObserveInputSchema(
  supportsTargetedObservation: boolean,
  supportsElementTargeting = false,
) {
  if (!supportsTargetedObservation) return computerDesktopStateObserveInputSchema;
  if (supportsElementTargeting) return computerObserveInputSchema;
  return z.union([
    computerDesktopStateObserveInputSchema,
    computerWindowStateObserveWithoutElementInputSchema,
    computerApplicationWindowsObserveInputSchema,
    computerWindowRegionObserveInputSchema,
  ]);
}

const computerTargetEvidenceSchema = z
  .object({
    kind: z.enum(["app", "window", "element", "screen"]),
    appLabel: sanitizedTargetLabelSchema.optional(),
    windowLabel: sanitizedTargetLabelSchema.optional(),
    role: sanitizedTargetLabelSchema.optional(),
    focused: z.boolean().optional(),
    hidden: z.boolean().optional(),
    bounds: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().nonnegative(),
        height: z.number().finite().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.kind === "screen" || value.appLabel !== undefined || value.windowLabel !== undefined || value.role !== undefined,
    "a non-screen target must include bounded semantic evidence",
  );

const computerWindowTargetEvidenceSchema = computerTargetEvidenceSchema.refine(
  (evidence) => evidence.kind === "window",
  "a scoped window observation requires window evidence",
);

/** Receipt-only fact for an app capability that failed before it could resolve. */
const computerUnavailableAppReceiptEvidenceSchema = z
  .object({ kind: z.literal("app"), state: z.literal("unavailable") })
  .strict();

/** Receipt-only fact for a consumed or stale one-shot element capability. */
const computerUnavailableElementReceiptEvidenceSchema = z
  .object({ kind: z.literal("element"), state: z.literal("unavailable") })
  .strict();

const computerMutationResolvedTargetEvidenceSchema = z.union([
  computerTargetEvidenceSchema,
  // Preserve the observed role and selected operation, not document contents.
  computerTextElementEvidenceSchema,
  computerValueElementEvidenceSchema,
  computerClickElementEvidenceSchema,
  computerScrollElementEvidenceSchema,
  computerKeyElementEvidenceSchema,
  computerUnavailableAppReceiptEvidenceSchema,
  computerUnavailableElementReceiptEvidenceSchema,
]);

const observedComputerTargetSchema = z
  .object({
    target: computerWindowTargetReferenceSchema,
    evidence: computerTargetEvidenceSchema,
  })
  .strict();

const observedComputerAppTargetSchema = z
  .object({
    target: computerAppTargetReferenceSchema,
    evidence: computerTargetEvidenceSchema.refine(
      // An app capability needs an exact semantic identity, but it must not
      // claim visibility or focus when the active provider did not observe
      // those states.  Cua's list_apps, for example, can establish an app
      // name while leaving hidden/focused absent.  Those optional facts retain
      // their ordinary evidence meaning when a provider can prove them.
      (evidence) => evidence.kind === "app" && evidence.appLabel !== undefined,
      "an application target requires a bounded semantic application label",
    ),
  })
  .strict();

/**
 * App and window discovery are independently accounted for. In particular,
 * `maxWindows` never truncates or redefines this app-wide capability set.
 */
const computerApplicationTargetSetSchema = z
  .object({
    discovered: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
    targets: z.array(observedComputerAppTargetSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.returned + value.omitted !== value.discovered) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "returned plus omitted application targets must equal discovered" });
    }
    if (value.targets.length !== value.returned) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "application target references must account for every returned application" });
    }
  });

/**
 * The stable response contract for the first `desktop_state` observation.
 * Providers normalize their raw data into this shape before it reaches Genie.
 */
export const desktopStateObservationSchema = z
  .object({
    version: z.literal(1),
    operation: z.literal("desktop_state"),
    context: computerContextReferenceSchema,
    completeness: z.enum(["complete", "partial"]),
    discovered: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
    boundary: computerObservationBoundarySchema,
    uninspected: computerUninspectedObservationSchema.nullable(),
    continuation: computerObservationContinuationSchema.nullable(),
    alternatives: z.array(computerObservationAlternativeSchema),
    targets: z.array(observedComputerTargetSchema),
    /** Separate app-wide action capabilities; independent of maxWindows. */
    applicationTargets: computerApplicationTargetSetSchema,
    /** Optional until a checked route advertises screenshot observation. */
    screenSnapshot: computerScreenSnapshotSchema.optional(),
    outcome: computerOperationOutcomeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.returned + value.omitted !== value.discovered) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "returned plus omitted must equal discovered",
      });
    }
    if (value.targets.length !== value.returned) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "target references must account for every returned result",
      });
    }
    if (value.completeness === "complete" && value.omitted !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a complete observation cannot omit discovered results",
      });
    }
    if (value.completeness === "complete" && value.boundary.kind !== "none") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a complete observation cannot report a limiting boundary",
      });
    }
    if (value.completeness === "complete" && value.continuation !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a complete observation cannot include a continuation",
      });
    }
    if (value.completeness === "complete" && value.uninspected !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a complete observation cannot retain uninspected provider state",
      });
    }
    if (value.boundary.kind === "provider_limit" && value.uninspected === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a provider-limited observation must account for uninspected provider state",
      });
    }
    if (value.boundary.kind === "provider_limit"
      && (value.outcome.retrySafety !== "never"
        || value.outcome.recovery.length !== 0
        || value.outcome.requiredCapability !== "provider_narrowing_or_cursor"
        || value.alternatives.some((alternative) => alternative.kind === "observe_again" && alternative.available))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a provider limit cannot advertise re-observation as recovery without a provider-native cursor or narrowing operation",
      });
    }
    if (value.uninspected !== null && value.boundary.kind !== "provider_limit") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "uninspected provider state requires the provider_limit boundary",
      });
    }
    if (value.completeness === "partial" && value.boundary.kind === "none") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a partial observation must name its boundary",
      });
    }
    for (const observed of value.targets) {
      if (observed.target.context !== value.context) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "every target must be bound to this observation context",
        });
      }
    }
    for (const observed of value.applicationTargets.targets) {
      if (observed.target.context !== value.context) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "every application target must be bound to this observation context",
        });
      }
    }
    if (value.screenSnapshot !== undefined && value.screenSnapshot.target.context !== value.context) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a screen snapshot must be bound to this observation context",
      });
    }
  });

/**
 * Compact observation of exactly one already-selected window. The adapter may
 * use Cua AX/screenshot data internally, but neither raw tree/token/image nor
 * native or provider diagnostics are part of this model-facing result.
 */
export const windowStateObservationSchema = z
  .object({
    version: z.literal(1),
    operation: z.literal("window_state"),
    target: computerWindowTargetReferenceSchema,
    evidence: computerWindowTargetEvidenceSchema.nullable(),
    completeness: z.enum(["sufficient", "partial", "unavailable"]),
    degraded: z.boolean(),
    verification: z.enum(["supported", "indeterminate", "unavailable"]),
    /** Present only when the request selected one admitted semantic control role. */
    element: computerElementSelectionSchema.optional(),
    /** Current structured controls when no single-control selector was requested. */
    controlCollection: computerNativeControlCollectionSchema.optional(),
    /** Exact Cua window-local pixel frame from the same read as any query or token selection. */
    windowSnapshot: computerWindowSnapshotSchema.optional(),
    /** Bounded positive semantic evidence from one exact Cua query. */
    semanticQuery: computerWindowSemanticQueryResultSchema.optional(),
    outcome: computerOperationOutcomeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.completeness === "unavailable" && value.evidence !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "unavailable window state cannot claim fresh evidence" });
    }
    if (value.completeness !== "unavailable" && value.evidence === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "available window state requires bounded semantic evidence" });
    }
    if (value.completeness === "sufficient" && (value.degraded || value.verification !== "supported")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "sufficient state must be non-degraded and verification-supported" });
    }
    if (value.completeness === "partial" && !value.degraded && value.verification !== "indeterminate") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "partial state requires degradation or indeterminate verification" });
    }
    if (value.completeness === "unavailable" && (value.degraded || value.verification !== "unavailable")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "unavailable state cannot fabricate degradation or verification" });
    }
    if (value.element?.target !== undefined && value.element.target.context !== value.target.context) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "a selected element must share the observed window context" });
    }
    if (value.controlCollection?.controls.some((control) => control.target !== undefined && control.target.context !== value.target.context)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "control references must share the observed window context" });
    }
    if (value.windowSnapshot !== undefined && value.windowSnapshot.target.context !== value.target.context) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "a window snapshot must share the observed window context" });
    }
  });

/**
 * One exact Host-derived precision view. The source snapshot is retired when
 * this result is minted; coordinates in the returned image remain actionable
 * through the replacement opaque target.
 */
export const windowRegionObservationSchema = z
  .object({
    version: z.literal(1),
    operation: z.literal("window_region"),
    source: computerScreenSnapshotReferenceSchema,
    regionSnapshot: computerWindowRegionSnapshotSchema,
    outcome: computerOperationOutcomeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.regionSnapshot.target.context !== value.source.context) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "a precision view must share its source snapshot context" });
    }
    if (value.regionSnapshot.target.reference === value.source.reference) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "a precision view must replace its source snapshot authority" });
    }
  });

/**
 * Compact, app-scoped candidate set used only after launch. It never becomes a
 * desktop-wide inventory and contains no native process/window identifiers.
 */
export const applicationWindowsObservationSchema = z
  .object({
    version: z.literal(1),
    operation: z.literal("application_windows"),
    target: computerAppTargetReferenceSchema,
    completeness: z.enum(["complete", "partial", "unavailable"]),
    discovered: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
    candidates: z.array(
      z.object({
        target: computerWindowTargetReferenceSchema,
        evidence: computerWindowTargetEvidenceSchema,
        semanticQuery: computerWindowSemanticQueryResultSchema.optional(),
        semanticQueryUnavailable: computerWindowSemanticQueryUnavailableSchema.optional(),
      }).strict(),
    ),
    /** Literal content-search accounting over the separately reported window inventory. */
    semanticQuery: z.object({
      query: computerWindowSemanticQuerySchema,
      exhaustive: z.literal(false),
      inspected: z.number().int().nonnegative(),
      uninspected: z.number().int().nonnegative(),
      effort: computerWindowTraversalEffortSchema.optional(),
    }).strict().optional(),
    outcome: computerOperationOutcomeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.returned + value.omitted !== value.discovered || value.candidates.length !== value.returned) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "candidate accounting must match discovered application windows" });
    }
    if (value.completeness === "complete" && value.omitted !== 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "a complete application window observation cannot omit candidates" });
    }
    if (value.completeness === "partial" && value.omitted === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "a partial application window observation must account for omitted candidates" });
    }
    if (value.completeness === "unavailable" && (value.discovered !== 0 || value.returned !== 0 || value.omitted !== 0 || value.candidates.length !== 0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "an unavailable application window observation cannot claim candidates" });
    }
    for (const candidate of value.candidates) {
      if (candidate.target.context !== value.target.context) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "application window candidates must share the app target context" });
      }
    }
    const queried = value.semanticQuery !== undefined;
    if (value.semanticQuery !== undefined && value.semanticQuery.inspected + value.semanticQuery.uninspected !== value.discovered) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "application-window query availability must account for every inventoried window" });
    }
    if (value.candidates.some((candidate) => queried !== (candidate.semanticQuery !== undefined || candidate.semanticQueryUnavailable !== undefined))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "application-window query availability must be present on every and only queried candidate" });
    }
    if (value.candidates.some((candidate) => candidate.semanticQuery !== undefined && candidate.semanticQueryUnavailable !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "an application window cannot report both query evidence and query unavailability" });
    }
    if (value.candidates.some((candidate) => candidate.semanticQuery !== undefined
      && candidate.semanticQuery.query !== value.semanticQuery?.query)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "candidate semantic evidence must preserve the aggregate query" });
    }
    if (value.candidates.some((candidate) => candidate.semanticQuery?.effort !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "application-window traversal effort is reported once on the aggregate query" });
    }
    if (value.candidates.some((candidate) => candidate.semanticQueryUnavailable !== undefined
      && candidate.semanticQueryUnavailable.query !== value.semanticQuery?.query)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "candidate query unavailability must preserve the aggregate query" });
    }
    if (value.semanticQuery !== undefined
      && value.candidates.filter((candidate) => candidate.semanticQuery !== undefined).length !== value.semanticQuery.inspected) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "inspected window accounting must match returned query evidence" });
    }
    if (value.semanticQuery !== undefined
      && value.candidates.filter((candidate) => candidate.semanticQueryUnavailable !== undefined).length !== value.semanticQuery.uninspected) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "uninspected window accounting must match query-unavailable candidates" });
    }
  });

/** The canonical action order shared with the route capability receipt. */
export const COMPUTER_DO_ACTIONS = [
  "focus",
  "click",
  "type_text",
  "set_value",
  "press_key",
  "drag_drop",
  "scroll",
  "invoke_menu",
  "set_window_frame",
  "launch_app",
  "create_window",
  "move_pointer",
  "hotkey",
] as const;
export type ComputerDoAction = (typeof COMPUTER_DO_ACTIONS)[number];

const computerSnapshotCoordinateSpaceSchema = z.enum([
  "presented_snapshot_pixels",
  "window_snapshot_pixels",
]);

/**
 * Coordinates are always nonnegative literal pixels in the exact fresh
 * snapshot frame. The snapshot advertises whether that frame is a whole
 * desktop presentation or one exact window image.
 */
const computerCoordinateClickOperationSchema = z
  .object({
    kind: z.literal("click"),
    target: computerScreenSnapshotReferenceSchema,
    coordinateSpace: computerSnapshotCoordinateSpaceSchema,
    x: nonnegativeFinitePresentedCoordinateSchema,
    y: nonnegativeFinitePresentedCoordinateSchema,
    button: z.enum(["left", "right", "middle"]).optional(),
    count: z.number().int().positive().optional().describe("Number of clicks passed unchanged to Cua; defaults to one."),
    modifiers: z.array(z.enum(["cmd", "shift", "option", "alt", "ctrl"])).optional(),
    deliveryMode: z.enum(["background", "foreground"]).optional()
      .describe("Window snapshots and their precision regions default to background; macOS modifier clicks require foreground. Desktop-wide snapshots are inherently foreground and reject an explicit background request."),
  })
  .strict();

/** Press one exact role-selected accessibility control. */
const computerElementClickOperationSchema = z
  .object({
    kind: z.literal("click"),
    target: computerElementTargetReferenceSchema,
    axAction: z.enum(["press", "show_menu", "pick", "confirm", "cancel", "open"]).optional()
      .describe("Native accessibility operation for an ordinary click-selected control; defaults to press. Advisory AX actions do not prohibit an attempt."),
    button: z.enum(["left", "right", "middle"]).optional(),
    modifiers: z.array(z.enum(["cmd", "shift", "option", "alt", "ctrl"])).optional(),
    deliveryMode: z.enum(["background", "foreground"]).optional(),
  })
  .strict();

const computerClickOperationSchema = z.union([
  computerCoordinateClickOperationSchema,
  computerElementClickOperationSchema,
]);

// Pinned Cua 0.23.2 drag input schema; these are provider ranges, not product defaults.
export const CUA_DRAG_MAX_DURATION_MS = 10_000;
export const CUA_DRAG_MAX_STEPS = 200;

/** Drag within a window/region or across visible windows in one fresh desktop image. */
const computerDragDropOperationSchema = z.object({
  kind: z.literal("drag_drop"),
  target: computerScreenSnapshotReferenceSchema,
  coordinateSpace: computerSnapshotCoordinateSpaceSchema,
  from: z.object({ x: nonnegativeFinitePresentedCoordinateSchema, y: nonnegativeFinitePresentedCoordinateSchema }).strict(),
  to: z.object({ x: nonnegativeFinitePresentedCoordinateSchema, y: nonnegativeFinitePresentedCoordinateSchema }).strict(),
  durationMs: z.number().int().min(0).max(CUA_DRAG_MAX_DURATION_MS).optional().describe("Cua drag duration; omit for its 500 ms default."),
  steps: z.number().int().min(1).max(CUA_DRAG_MAX_STEPS).optional().describe("Cua interpolated drag events; omit for its 20-step default."),
  button: z.enum(["left", "right", "middle"]).optional(),
  modifiers: z.array(z.enum(["cmd", "shift", "option", "alt", "ctrl"])).optional(),
  deliveryMode: z.enum(["background", "foreground"]).optional().describe("Defaults to foreground: pinned macOS Cua cannot deliver a background drag. Desktop-wide input is inherently foreground."),
}).strict();

const computerScrollDirectionSchema = z.enum(["up", "down", "left", "right"]);
const computerScrollAmountSchema = z.number().int().min(1).max(50);
const computerScrollBySchema = z.enum(["line", "page"]);

/** Scroll one fresh role-selected accessibility target. */
const computerElementScrollOperationSchema = z.object({
  kind: z.literal("scroll"),
  target: computerElementTargetReferenceSchema,
  direction: computerScrollDirectionSchema,
  amount: computerScrollAmountSchema,
  by: computerScrollBySchema,
  deliveryMode: z.enum(["background", "foreground"]).optional(),
}).strict();

/** Scroll the surface under one literal point in a fresh exact window PNG. */
const computerCoordinateScrollOperationSchema = z.object({
  kind: z.literal("scroll"),
  target: computerScreenSnapshotReferenceSchema,
  coordinateSpace: computerSnapshotCoordinateSpaceSchema,
  x: nonnegativeFinitePresentedCoordinateSchema,
  y: nonnegativeFinitePresentedCoordinateSchema,
  direction: computerScrollDirectionSchema,
  amount: computerScrollAmountSchema,
  by: computerScrollBySchema,
  deliveryMode: z.enum(["background", "foreground"]).optional(),
}).strict();

const computerScrollOperationSchema = z.union([
  computerElementScrollOperationSchema,
  computerCoordinateScrollOperationSchema,
]);

/** Exact public click shape, admitted only for a route that advertises click. */
export const computerClickInputSchema = z.object({ operation: computerClickOperationSchema }).strict();

/**
 * Cua's portable `type_text` contract requires text and does not constrain its
 * size. Historical window-scoped input retains an opaque window target; the
 * first useful TextEdit vertical uses a fresh, single-use opaque text-element
 * target. The signed Host alone resolves either form to native provider arguments.
 */
/** Pinned Cua type_text schema: pacing applies to synthesis, not AX writes. */
export const CUA_TYPE_TEXT_MAX_DELAY_MS = 200;
const computerTextDelaySchema = z.number().int().min(0).max(CUA_TYPE_TEXT_MAX_DELAY_MS).optional();

const computerSemanticTypeTextOperationSchema = z
  .object({
    kind: z.literal("type_text"),
    target: z.union([computerWindowTargetReferenceSchema, computerElementTargetReferenceSchema]),
    text: z.string(),
    delayMs: computerTextDelaySchema,
    deliveryMode: z.enum(["background", "foreground"]).optional(),
  })
  .strict();

/** Focus one literal point in a fresh exact window PNG, then type once. */
const computerCoordinateTypeTextOperationSchema = z
  .object({
    kind: z.literal("type_text"),
    target: computerScreenSnapshotReferenceSchema,
    coordinateSpace: computerSnapshotCoordinateSpaceSchema,
    x: nonnegativeFinitePresentedCoordinateSchema,
    y: nonnegativeFinitePresentedCoordinateSchema,
    text: z.string(),
    delayMs: computerTextDelaySchema,
    deliveryMode: z.enum(["background", "foreground"]).optional(),
  })
  .strict();

/** Desktop input uses current focus, never an implied point or window. */
const computerDesktopTypeTextOperationSchema = z.object({
  kind: z.literal("type_text"),
  scope: z.literal("desktop"),
  target: computerScreenSnapshotReferenceSchema,
  text: z.string(),
  delayMs: computerTextDelaySchema,
}).strict();

const computerTypeTextOperationSchema = z.union([
  computerSemanticTypeTextOperationSchema,
  computerCoordinateTypeTextOperationSchema,
  computerDesktopTypeTextOperationSchema,
]);

/** Set one semantic AX value through a one-shot role-selected element target. */
const computerSetValueOperationSchema = z
  .object({
    kind: z.literal("set_value"),
    target: computerElementTargetReferenceSchema,
    value: z.string(),
  })
  .strict();

/**
 * Cua's pinned macOS runtime documents this exact key vocabulary and modifier
 * set. `alt` is retained as Cua's documented alias for `option`; the Host
 * adapter canonicalizes aliases and removes duplicates before Cua dispatch.
 */
const computerSemanticPressKeyOperationSchema = z
  .object({
    kind: z.literal("press_key"),
    target: z.union([computerWindowTargetReferenceSchema, computerElementTargetReferenceSchema]),
    key: z.string().regex(CUA_MACOS_KEY_PATTERN),
    modifiers: z.array(z.enum(CUA_MACOS_KEY_MODIFIERS)).optional(),
    deliveryMode: z.enum(["background", "foreground"]).optional(),
  })
  .strict();

/** Focus one literal point in a fresh exact window PNG, then press one key. */
const computerCoordinatePressKeyOperationSchema = z
  .object({
    kind: z.literal("press_key"),
    target: computerScreenSnapshotReferenceSchema,
    coordinateSpace: computerSnapshotCoordinateSpaceSchema,
    x: nonnegativeFinitePresentedCoordinateSchema,
    y: nonnegativeFinitePresentedCoordinateSchema,
    key: z.string().regex(CUA_MACOS_KEY_PATTERN),
    modifiers: z.array(z.enum(CUA_MACOS_KEY_MODIFIERS)).optional(),
    deliveryMode: z.enum(["background", "foreground"]).optional(),
  })
  .strict();

const computerDesktopPressKeyOperationSchema = z.object({
  kind: z.literal("press_key"),
  scope: z.literal("desktop"),
  target: computerScreenSnapshotReferenceSchema,
  key: z.string().regex(CUA_MACOS_KEY_PATTERN),
  modifiers: z.array(z.enum(CUA_MACOS_KEY_MODIFIERS)).optional(),
}).strict();

/** Real pointer movement, not Cua's window-scoped cursor overlay. */
const computerMovePointerOperationSchema = z.object({
  kind: z.literal("move_pointer"),
  scope: z.literal("desktop"),
  target: computerScreenSnapshotReferenceSchema,
  coordinateSpace: z.literal("presented_snapshot_pixels"),
  x: nonnegativeFinitePresentedCoordinateSchema,
  y: nonnegativeFinitePresentedCoordinateSchema,
}).strict();

const computerPressKeyOperationSchema = z.union([
  computerSemanticPressKeyOperationSchema,
  computerCoordinatePressKeyOperationSchema,
  computerDesktopPressKeyOperationSchema,
]);

const computerHotkeyFields = {
  kind: z.literal("hotkey"),
  keys: z.array(z.string().regex(CUA_MACOS_KEY_PATTERN)).min(2).refine((keys) => normalizeCuaMacosHotkey(keys) !== null,
    "Use Cua modifiers followed by exactly one supported non-modifier key; a chord is not a sequence"),
};

/** Reuse keyboard targeting, including action:press_key element authority. */
const computerHotkeyOperationSchema = z.union([
  computerSemanticPressKeyOperationSchema.omit({ key: true, modifiers: true }).extend(computerHotkeyFields),
  computerCoordinatePressKeyOperationSchema.omit({ key: true, modifiers: true }).extend(computerHotkeyFields),
  computerDesktopPressKeyOperationSchema.omit({ key: true, modifiers: true }).extend(computerHotkeyFields),
]);

/** Launch accepts an app name only; every Cua-specific control is excluded. */
const computerLaunchAppOperationSchema = z
  .object({
    kind: z.literal("launch_app"),
    app: z.object({ name: computerSemanticAppNameSchema }).strict(),
  })
  .strict();

const computerNativeMenuPathSegmentSchema = sanitizedTargetLabelSchema
  .max(200)
  .regex(/^\S(?:[\s\S]*\S)?$/u, "native menu path labels must not have surrounding whitespace")
  .describe("Exact case-sensitive native menu label; matches Cua invoke_menu's per-segment contract");

/**
 * Create one fresh window for an exact semantic application. The caller names
 * the application's known native new-window menu path; Host privately owns
 * native identity, the complete before-set, live menu resolution, bounded
 * post-effect polling, and unique set-difference attribution.
 */
const computerCreateWindowOperationSchema = z
  .object({
    kind: z.literal("create_window"),
    target: computerAppTargetReferenceSchema,
    menuPath: z.array(computerNativeMenuPathSegmentSchema)
      .min(1)
      .max(16)
      .describe("Known native menu path that creates one ordinary window in the exact target application"),
  })
  .strict();

/** Invoke one exact live native menu path against one exact opaque window. */
const computerInvokeMenuOperationSchema = z
  .object({
    kind: z.literal("invoke_menu"),
    target: computerWindowTargetReferenceSchema,
    menuPath: z.array(computerNativeMenuPathSegmentSchema)
      .min(1)
      .max(16),
  })
  .strict();

/** Set one exact window frame in Cua's desktop-coordinate space. */
const computerSetWindowFrameOperationSchema = z
  .object({
    kind: z.literal("set_window_frame"),
    target: computerWindowTargetReferenceSchema,
    frame: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
    }).strict(),
  })
  .strict();

const computerDoOperationSchemas = {
  focus: z.object({ kind: z.literal("focus"), target: computerWindowTargetReferenceSchema }).strict(),
  click: computerClickOperationSchema,
  type_text: computerTypeTextOperationSchema,
  set_value: computerSetValueOperationSchema,
  press_key: computerPressKeyOperationSchema,
  hotkey: computerHotkeyOperationSchema,
  drag_drop: computerDragDropOperationSchema,
  move_pointer: computerMovePointerOperationSchema,
  scroll: computerScrollOperationSchema,
  invoke_menu: computerInvokeMenuOperationSchema,
  set_window_frame: computerSetWindowFrameOperationSchema,
  launch_app: computerLaunchAppOperationSchema,
  create_window: computerCreateWindowOperationSchema,
} as const;

function isCanonicalComputerDoActionSet(
  actions: readonly ComputerDoAction[],
): boolean {
  let previousIndex = -1;
  return actions.length > 0 && actions.every((action) => {
    const index = COMPUTER_DO_ACTIONS.indexOf(action);
    if (index <= previousIndex) return false;
    previousIndex = index;
    return true;
  });
}

/**
 * Builds the route-narrowed action argument. A one-action route deliberately
 * uses its exact object schema: Zod rejects a one-option discriminated union.
 */
export function createComputerDoInputSchema(
  actions: readonly ComputerDoAction[],
  supportsElementTargeting = true,
) {
  if (!isCanonicalComputerDoActionSet(actions)) {
    return z.object({ operation: z.never() }).strict();
  }

  let operation: z.ZodTypeAny;
  if (actions.length === 1) {
    const action = actions[0]!;
    operation = action === "click" && !supportsElementTargeting
      ? computerCoordinateClickOperationSchema
      : action === "scroll" && !supportsElementTargeting
        ? computerCoordinateScrollOperationSchema
      : computerDoOperationSchemas[action];
  } else {
    const selected = actions.map((action) => action === "click" && !supportsElementTargeting
      ? computerCoordinateClickOperationSchema
      : action === "scroll" && !supportsElementTargeting
        ? computerCoordinateScrollOperationSchema
      : computerDoOperationSchemas[action]);
    operation = z.union(selected as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }
  return z.object({ operation }).strict();
}

/**
 * The full static contract remains available to direct contract parsers. The
 * catalog instantiates the route-narrowed form through createComputerDoTool.
 */
export const computerDoInputSchema = createComputerDoInputSchema(COMPUTER_DO_ACTIONS);

/**
 * Result of Electron's private complete native-window set difference after
 * one exact semantic create-window effect. It publishes an opaque target only for one observed
 * new window. A timeout, inaccessible response or competing windows is not a
 * lesser target-selection mode and must stop the sequence.
 */
const computerAppearedWindowHandoffSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("appeared_window"),
    disposition: z.enum(["none_observed", "unique", "ambiguous", "incomplete"]),
    app: z
      .object({
        target: computerAppTargetReferenceSchema,
        evidence: z.object({ kind: z.literal("app"), appLabel: computerSemanticAppNameSchema }).strict(),
      })
      .strict()
      .optional(),
    window: z
      .object({
        target: computerWindowTargetReferenceSchema,
        // The handoff establishes identity by local native set difference,
        // not by a title, PID, bounds, or any provider-supplied label.
        evidence: z.object({ kind: z.literal("window") }).strict(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const unique = value.disposition === "unique";
    if (unique !== (value.window !== undefined) || unique !== (value.app !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "only a unique appeared-window handoff may publish refreshed app and window targets" });
    }
    if (unique && value.app !== undefined && value.window !== undefined && value.app.target.context !== value.window.target.context) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "refreshed application and created window must share one new context" });
    }
  });

/**
 * Persisted immediately after every attempted mutation. It intentionally
 * contains opaque references instead of screen text, keystrokes, or content.
 */
export const computerMutationReceiptSchema = z
  .object({
    version: z.literal(1),
    timing: z.literal("immediate"),
    action: z.enum(["focus", "click", "type_text", "set_value", "press_key", "hotkey", "drag_drop", "scroll", "invoke_menu", "set_window_frame", "create_window", "move_pointer"]),
    target: z.union([computerTargetReferenceSchema, computerScreenSnapshotReferenceSchema]),
    resolvedTarget: computerMutationResolvedTargetEvidenceSchema,
    provider: z.literal("cua"),
    deliveryMode: z.enum(["background", "foreground", "foreground_escalated", "not_delivered", "not_applicable", "unknown"]),
    completionCertainty: z.enum(["completed", "partially_completed", "not_completed", "unknown_completion"]),
    verification: z.enum(["not_requested", "verified", "not_verified", "unavailable"]),
    unexecutedRemainder: z
      .object({
        count: z.number().int().nonnegative(),
        reason: z.enum(["none", "failed", "unknown_completion", "cancelled"]),
      })
      .strict(),
    /** Content-free accounting for Cua `type_text` delivery; never echoes text. */
    textDelivery: z
      .object({
        requestedCharacters: z.number().int().nonnegative(),
        deliveredCharacters: z.number().int().nonnegative().nullable(),
        /** Dynamic Cua synthesis refusal fact; this is not a Nautilo text ceiling. */
        maxChunkCharacters: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /** Content-free, lossless projection of Cua's closed ActionResult. */
    providerAction: z
      .object({
        effect: z.enum(["confirmed", "partial", "unverifiable", "suspected_noop", "refused"]),
        route: z.enum(["accessibility", "synthetic_events", "global_input", "system_api", "dom", "trusted_input"]),
        delivery: z.object({
          mode: z.enum(["background", "foreground", "not_applicable", "unknown"]),
          deliveredCount: z.number().int().min(0).max(2 ** 32 - 1).optional(),
        }).strict().nullable(),
        evidenceKinds: z.array(z.enum(["value_readback", "window_change", "native_api_result"])),
        escalation: z.object({
          target: z.enum(["pixel", "foreground", "page", "session"]),
          reason: z.enum(["route_unavailable", "delivery_failed", "effect_unconfirmed", "suspected_noop", "permission_required"]),
        }).strict().nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    /** Present exactly for the first-vertical create-window handoff. */
    postObservation: computerAppearedWindowHandoffSchema.optional(),
    outcome: computerOperationOutcomeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const unavailableAppEvidence = computerUnavailableAppReceiptEvidenceSchema.safeParse(value.resolvedTarget).success;
    const unavailableElementEvidence = computerUnavailableElementReceiptEvidenceSchema.safeParse(value.resolvedTarget).success;
    // Before dispatch, evidence describes what was selected, not what the
    // requested action could operate on. Keep that evidence truthful when an
    // incompatible selection, cancellation, or Human takeover prevents input.
    // This exception never admits delivered or ambiguous action results.
    const undispatchedElementOutcome = value.outcome.requiredCapability === undefined
      && value.outcome.recovery.length === 1
      && (value.outcome.phase === "resolve_target"
        && value.unexecutedRemainder.reason === "failed"
        && value.outcome.retrySafety === "observe_before_retry"
        && value.outcome.recovery[0] === "observe_again"
        && (value.outcome.providerCondition === "ready" && value.outcome.targetCondition === "unavailable"
          && value.outcome.externalInterference === undefined
          || value.outcome.providerCondition === "unknown" && value.outcome.targetCondition === "unknown")
        || value.outcome.phase === "pre_effect_dispatch"
        && value.unexecutedRemainder.reason === "failed"
        && value.outcome.providerCondition === "cancelled" && value.outcome.targetCondition === "current"
        && value.outcome.retrySafety === "safe" && value.outcome.recovery[0] === "retry_same_request"
        && value.outcome.externalInterference === undefined);
    const undispatchedElement = computerElementTargetReferenceSchema.safeParse(value.target).success
      && value.resolvedTarget.kind === "element" && !unavailableElementEvidence
      && value.completionCertainty === "not_completed"
      && value.deliveryMode === "not_delivered"
      && value.verification === "unavailable"
      && value.providerAction === null
      && value.unexecutedRemainder.count === (value.action === "type_text" ? value.textDelivery?.requestedCharacters : 1)
      && undispatchedElementOutcome
      && value.outcome.stateChangeCertainty === "not_changed"
      && (value.action !== "type_text" || value.textDelivery?.deliveredCharacters === 0);
    if (unavailableAppEvidence && !(value.action === "create_window" && value.completionCertainty === "not_completed")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "unavailable app evidence is only valid for a preboundary create_window failure" });
    }
    if (unavailableElementEvidence) {
      const exactUnavailableElementFailure = (value.action === "type_text" || value.action === "set_value" || value.action === "click" || value.action === "scroll")
        && computerElementTargetReferenceSchema.safeParse(value.target).success
        && value.completionCertainty === "not_completed"
        && value.deliveryMode === "not_delivered"
        && value.verification === "unavailable"
        && value.providerAction === null
        && (value.action === "set_value" || value.action === "click" || value.action === "scroll" || value.textDelivery?.deliveredCharacters === 0)
        && value.outcome.phase === "resolve_target"
        && value.outcome.stateChangeCertainty === "not_changed"
        && value.outcome.targetCondition === "stale"
        && value.outcome.recovery.includes("observe_again")
        && !value.outcome.recovery.includes("do_not_replay");
      if (!exactUnavailableElementFailure) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "unavailable element evidence is only valid for an exact preboundary detgt_ resolution failure" });
      }
    }
    if (value.unexecutedRemainder.count === 0 && value.unexecutedRemainder.reason !== "none") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an empty remainder must have reason none",
      });
    }
    if (value.unexecutedRemainder.count > 0 && value.unexecutedRemainder.reason === "none") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a non-empty remainder must state why it was not executed",
      });
    }
    if (value.completionCertainty === "completed" && value.unexecutedRemainder.count !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a completed single action cannot have an unexecuted remainder",
      });
    }
    if (value.completionCertainty === "partially_completed" && value.unexecutedRemainder.count === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "partial completion must name an unexecuted remainder" });
    }
    if (value.deliveryMode === "unknown" && value.completionCertainty !== "unknown_completion") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unknown delivery requires unknown completion",
      });
    }
    if (value.deliveryMode === "not_delivered" && value.completionCertainty !== "not_completed") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "not-delivered mode requires known non-completion",
      });
    }
    if (value.provider === "cua"
      && value.completionCertainty === "completed"
      && (value.action === "click" || value.action === "type_text" || value.action === "set_value" || value.action === "press_key" || value.action === "hotkey" || value.action === "drag_drop" || value.action === "scroll" || value.action === "move_pointer")
      && (value.providerAction === undefined || value.providerAction === null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "completed Cua input receipts must retain the provider action truth" });
    }
    const providerAction = value.providerAction;
    if (providerAction !== undefined && providerAction !== null) {
      if (value.provider !== "cua") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "only Cua may publish a Cua provider action" });
      }
      if (providerAction.effect === "confirmed" && providerAction.evidenceKinds.length === 0) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "confirmed Cua action requires evidence kinds" });
      }
      if (providerAction.effect === "partial" && providerAction.delivery?.deliveredCount === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "partial Cua action requires delivered count" });
      }
      if (providerAction.effect === "refused" && (providerAction.delivery !== null || providerAction.evidenceKinds.length !== 0)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "refused Cua action cannot carry delivery or evidence" });
      }
      const deliveryMode = providerAction.delivery?.mode;
      const matchingDelivery = deliveryMode === "background"
        ? value.deliveryMode === "background"
        : deliveryMode === "foreground"
          ? value.deliveryMode === "foreground" || value.deliveryMode === "foreground_escalated"
          : deliveryMode === "not_applicable"
            ? value.deliveryMode === "not_applicable"
            : value.deliveryMode === "unknown";
      if (providerAction.effect !== "refused" && !matchingDelivery) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "receipt delivery mode must preserve Cua's actual delivery fact" });
      }
      if (providerAction.effect === "confirmed"
        && (value.completionCertainty !== "completed" || value.verification !== "verified")) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "confirmed Cua action requires completed, verified receipt truth" });
      }
      if (providerAction.effect === "partial") {
        const deliveredCount = providerAction.delivery?.deliveredCount;
        if (value.action !== "type_text"
          || value.completionCertainty !== "partially_completed"
          || value.verification !== "not_verified"
          || deliveredCount === undefined
          || value.textDelivery?.deliveredCharacters !== deliveredCount
          || value.unexecutedRemainder.reason !== "failed") {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "partial Cua action must exactly account for delivered text and failed remainder" });
        }
      }
      if (providerAction.effect === "refused") {
        if (value.completionCertainty !== "not_completed"
          || value.deliveryMode !== "not_delivered"
          || value.verification !== "unavailable"
          || value.unexecutedRemainder.reason !== "failed"
          || (value.action === "type_text" && value.textDelivery?.deliveredCharacters !== 0)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "refused Cua action must report known non-delivery without text delivery" });
        }
      }
      const independentlyVerifiedSetValue = value.action === "set_value"
        && providerAction.effect === "unverifiable"
        && providerAction.escalation === null
        && value.completionCertainty === "completed"
        && value.verification === "verified"
        && value.outcome.stateChangeCertainty === "unknown"
        && value.outcome.retrySafety === "never"
        && value.outcome.recovery.length === 1 && value.outcome.recovery[0] === "do_not_replay"
        && value.unexecutedRemainder.count === 0
        && value.unexecutedRemainder.reason === "none";
      if ((providerAction.effect === "unverifiable" || providerAction.effect === "suspected_noop")
        && (value.action === "type_text" || value.action === "set_value" || value.action === "press_key" || value.action === "hotkey")
        && !independentlyVerifiedSetValue
        && (value.completionCertainty !== "unknown_completion"
          || value.verification !== "not_verified"
          || value.outcome.stateChangeCertainty !== "unknown"
          || !value.outcome.recovery.includes("do_not_replay")
          || value.unexecutedRemainder.reason !== "unknown_completion"
          || (value.action === "type_text" && value.textDelivery?.deliveredCharacters !== null))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "indeterminate Cua input effects require unknown-completion fencing and no replay",
        });
      }
    }
    if (value.action === "focus"
      && (!computerWindowTargetReferenceSchema.safeParse(value.target).success || value.resolvedTarget.kind !== "window")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "focus requires window-wide target evidence" });
    }
    if ((value.action === "press_key" || value.action === "hotkey")
      && !((computerWindowTargetReferenceSchema.safeParse(value.target).success && value.resolvedTarget.kind === "window")
        || (computerElementTargetReferenceSchema.safeParse(value.target).success && (computerKeyElementEvidenceSchema.safeParse(value.resolvedTarget).success || unavailableElementEvidence || undispatchedElement))
        || (computerScreenSnapshotReferenceSchema.safeParse(value.target).success && value.resolvedTarget.kind === "screen"))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "keyboard actions require exact window or fresh window-snapshot evidence" });
    }
    if (value.action === "drag_drop" || value.action === "move_pointer") {
      if (!computerScreenSnapshotReferenceSchema.safeParse(value.target).success || value.resolvedTarget.kind !== "screen" || value.provider !== "cua") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "pointer movement and drag require one exact Cua snapshot" });
      }
      if (providerAction !== undefined && providerAction !== null) {
        const exactDrag = providerAction.effect === "unverifiable" && providerAction.route === "global_input"
          && (providerAction.delivery?.mode === "not_applicable" || value.action === "drag_drop" && providerAction.delivery?.mode === "foreground") && providerAction.delivery.deliveredCount === undefined
          && providerAction.evidenceKinds.length === 0 && providerAction.escalation === null;
        if (!exactDrag || value.completionCertainty !== "completed" || value.verification !== "not_verified"
          || value.deliveryMode !== providerAction.delivery?.mode || value.outcome.stateChangeCertainty !== "unknown"
          || value.unexecutedRemainder.count !== 0 || value.unexecutedRemainder.reason !== "none"
          || value.outcome.retrySafety !== "never" || !value.outcome.recovery.includes("do_not_replay")) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "drag_drop must preserve delivered input without claiming a verified effect or permitting replay" });
        }
      }
    }
    if (value.action === "type_text") {
      const isWindow = computerWindowTargetReferenceSchema.safeParse(value.target).success;
      const isTextElement = computerElementTargetReferenceSchema.safeParse(value.target).success
        && computerTextElementEvidenceSchema.safeParse(value.resolvedTarget).success;
      const isUnavailableTextElement = computerElementTargetReferenceSchema.safeParse(value.target).success
        && unavailableElementEvidence;
      const isScreen = computerScreenSnapshotReferenceSchema.safeParse(value.target).success
        && value.resolvedTarget.kind === "screen";
      if ((!isWindow || value.resolvedTarget.kind !== "window") && !isTextElement && !isUnavailableTextElement && !isScreen && !undispatchedElement) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "type_text requires exact window, fresh window-snapshot, or role-selected text-element evidence" });
      }
      if (isTextElement && value.provider !== "cua") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "element type_text requires the admitted Cua provider" });
      }
    }
    if (value.action === "invoke_menu") {
      if (!computerWindowTargetReferenceSchema.safeParse(value.target).success || value.resolvedTarget.kind !== "window") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "invoke_menu requires one exact opaque window target" });
      }
      if (providerAction !== undefined && providerAction !== null) {
        const exactMenu = providerAction.effect === "unverifiable"
          && providerAction.route === "accessibility"
          && providerAction.delivery?.mode === "foreground"
          && providerAction.delivery.deliveredCount === undefined
          && providerAction.evidenceKinds.length === 0
          && providerAction.escalation === null;
        if (!exactMenu || value.completionCertainty !== "unknown_completion" || value.verification !== "not_verified"
          || value.unexecutedRemainder.count !== 1 || value.unexecutedRemainder.reason !== "unknown_completion"
          || value.outcome.stateChangeCertainty !== "unknown" || !value.outcome.recovery.includes("do_not_replay")) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "invoke_menu must preserve Cua's foreground delivery while keeping its semantic effect unknown" });
        }
      }
    }
    if (value.action === "set_window_frame") {
      if (!computerWindowTargetReferenceSchema.safeParse(value.target).success || value.resolvedTarget.kind !== "window") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "set_window_frame requires one exact opaque window target" });
      }
      if (providerAction !== undefined && providerAction !== null) {
        const exactFrame = providerAction.effect === "confirmed"
          && providerAction.route === "accessibility"
          && providerAction.delivery?.mode === "not_applicable"
          && providerAction.delivery.deliveredCount === undefined
          && providerAction.evidenceKinds.length === 1
          && providerAction.evidenceKinds[0] === "value_readback"
          && providerAction.escalation === null;
        if (!exactFrame || value.completionCertainty !== "completed" || value.verification !== "verified"
          || value.unexecutedRemainder.count !== 0 || value.unexecutedRemainder.reason !== "none"
          || value.outcome.stateChangeCertainty !== "changed" || value.outcome.targetCondition !== "current") {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "set_window_frame requires Cua confirmation plus exact fresh window-bounds readback" });
        }
      }
    }
    if (value.action === "set_value") {
      const isValueElement = computerElementTargetReferenceSchema.safeParse(value.target).success
        && computerValueElementEvidenceSchema.safeParse(value.resolvedTarget).success;
      const isUnavailableValueElement = computerElementTargetReferenceSchema.safeParse(value.target).success
        && unavailableElementEvidence;
      if (!isValueElement && !isUnavailableValueElement && !undispatchedElement) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "set_value requires one role-selected value-control element" });
      }
      if (isValueElement && value.provider !== "cua") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "element set_value requires the admitted Cua provider" });
      }
      if (value.textDelivery !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "set_value receipts never expose value delivery or content accounting" });
      }
      if (providerAction !== undefined && providerAction !== null) {
        const exactConfirmed = providerAction.effect === "confirmed"
          && providerAction.route === "accessibility"
          && providerAction.delivery?.mode === "background"
          && providerAction.delivery.deliveredCount === undefined
          && providerAction.evidenceKinds.length === 1
          && providerAction.evidenceKinds[0] === "value_readback"
          && providerAction.escalation === null;
        const exactUnverifiable = providerAction.effect === "unverifiable"
          && providerAction.route === "accessibility"
          && providerAction.delivery?.mode === "background"
          && providerAction.delivery.deliveredCount === undefined
          && providerAction.evidenceKinds.length === 0
          && (providerAction.escalation === null
            || (providerAction.escalation.target === "pixel"
              && providerAction.escalation.reason === "effect_unconfirmed"));
        if (!exactConfirmed && !exactUnverifiable) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "set_value requires one exact pinned Cua 0.23.2 action result" });
        }
      }
    }
    if (value.action === "scroll") {
      const isScrollCandidateElement = computerElementTargetReferenceSchema.safeParse(value.target).success
        && computerScrollElementEvidenceSchema.safeParse(value.resolvedTarget).success;
      const isUnavailableScrollCandidateElement = computerElementTargetReferenceSchema.safeParse(value.target).success
        && unavailableElementEvidence;
      const isScreenScroll = computerScreenSnapshotReferenceSchema.safeParse(value.target).success
        && value.resolvedTarget.kind === "screen";
      if (!isScrollCandidateElement && !isUnavailableScrollCandidateElement && !isScreenScroll && !undispatchedElement) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "scroll requires one role-selected scroll candidate or exact window snapshot" });
      }
      if ((isScrollCandidateElement || isScreenScroll) && value.provider !== "cua") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "scroll requires the admitted Cua provider" });
      }
      if (value.textDelivery !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "scroll receipts never expose content accounting" });
      }
      const exactAccessibilityUnverifiable = providerAction !== undefined && providerAction !== null
        && providerAction.effect === "unverifiable"
          && providerAction.route === "accessibility"
          && (providerAction.delivery?.mode === "background" || providerAction.delivery?.mode === "foreground")
          && providerAction.delivery.deliveredCount === undefined
          && providerAction.evidenceKinds.length === 0
          && providerAction.escalation === null;
      const exactSyntheticFallback = providerAction !== undefined && providerAction !== null
        && providerAction.effect === "unverifiable"
          && (providerAction.route === "synthetic_events" && providerAction.delivery?.mode === "background"
            || providerAction.route === "global_input" && (providerAction.delivery?.mode === "foreground"
              || isScreenScroll && providerAction.delivery?.mode === "not_applicable"))
          && providerAction.delivery.deliveredCount === undefined
          && providerAction.evidenceKinds.length === 0
          && providerAction.escalation === null;
      const unknownFreshFrameChange = value.completionCertainty === "unknown_completion"
          && value.verification === "not_verified"
          && value.unexecutedRemainder.count === 1
          && value.unexecutedRemainder.reason === "unknown_completion"
          && value.outcome.phase === "post_effect_verification"
          && value.outcome.retrySafety === "observe_before_retry"
          && value.outcome.stateChangeCertainty === "unknown"
          && value.outcome.targetCondition === "unknown"
          && value.outcome.recovery.length === 2
          && value.outcome.recovery[0] === "observe_again"
          && value.outcome.recovery[1] === "do_not_replay";
      const unavailableResolveTarget = isUnavailableScrollCandidateElement
        && providerAction === null
        && value.completionCertainty === "not_completed"
        && value.deliveryMode === "not_delivered"
        && value.verification === "unavailable"
        && value.unexecutedRemainder.count === 1
        && value.unexecutedRemainder.reason === "failed"
        && value.outcome.phase === "resolve_target"
        && value.outcome.stateChangeCertainty === "not_changed"
        && value.outcome.targetCondition === "stale"
        && value.outcome.recovery.length === 1
        && value.outcome.recovery[0] === "observe_again";
      const preEffectBackgroundUnavailable = isScrollCandidateElement
        && providerAction === null
        && value.completionCertainty === "not_completed"
        && value.deliveryMode === "not_delivered"
        && value.verification === "unavailable"
        && value.unexecutedRemainder.count === 1
        && value.unexecutedRemainder.reason === "failed"
        && value.outcome.phase === "pre_effect_dispatch"
        && value.outcome.stateChangeCertainty === "not_changed"
        && value.outcome.providerCondition === "ready"
        && value.outcome.targetCondition === "current"
        && value.outcome.retrySafety === "never"
        && value.outcome.recovery.length === 1
        && value.outcome.recovery[0] === "observe_again";
      const preEffectTokenRefusal = isScrollCandidateElement
        && providerAction === null
        && value.completionCertainty === "not_completed"
        && value.deliveryMode === "not_delivered"
        && value.verification === "unavailable"
        && value.unexecutedRemainder.count === 1
        && value.unexecutedRemainder.reason === "failed"
        && value.outcome.phase === "pre_effect_dispatch"
        && value.outcome.retrySafety === "observe_before_retry"
        && value.outcome.stateChangeCertainty === "not_changed"
        && value.outcome.providerCondition === "ready"
        && value.outcome.targetCondition === "stale"
        && value.outcome.recovery.length === 1
        && value.outcome.recovery[0] === "observe_again";
      const preEffectCancelled = isScrollCandidateElement
        && providerAction === null
        && value.completionCertainty === "not_completed"
        && value.deliveryMode === "not_delivered"
        && value.verification === "unavailable"
        && value.unexecutedRemainder.count === 1
        && value.unexecutedRemainder.reason === "failed"
        && value.outcome.phase === "pre_effect_dispatch"
        && value.outcome.retrySafety === "safe"
        && value.outcome.stateChangeCertainty === "not_changed"
        && value.outcome.providerCondition === "cancelled"
        && value.outcome.targetCondition === "current"
        && value.outcome.recovery.length === 1
        && value.outcome.recovery[0] === "retry_same_request";
      const preEffectCancelledUnavailable = isScrollCandidateElement
        && providerAction === null
        && value.completionCertainty === "not_completed"
        && value.deliveryMode === "not_delivered"
        && value.verification === "unavailable"
        && value.unexecutedRemainder.count === 1
        && value.unexecutedRemainder.reason === "failed"
        && value.outcome.phase === "pre_effect_dispatch"
        && value.outcome.retrySafety === "safe"
        && value.outcome.stateChangeCertainty === "not_changed"
        && value.outcome.providerCondition === "cancelled"
        && value.outcome.targetCondition === "unavailable"
        && value.outcome.recovery.length === 1
        && value.outcome.recovery[0] === "retry_same_request";
      const preEffectPreflightFailure = isScrollCandidateElement
        && providerAction === null
        && value.completionCertainty === "not_completed"
        && value.deliveryMode === "not_delivered"
        && value.verification === "unavailable"
        && value.unexecutedRemainder.count === 1
        && value.unexecutedRemainder.reason === "failed"
        && value.outcome.phase === "pre_effect_dispatch"
        && value.outcome.retrySafety === "observe_before_retry"
        && value.outcome.stateChangeCertainty === "not_changed"
        && (value.outcome.providerCondition === "ready" || value.outcome.providerCondition === "unknown" || value.outcome.providerCondition === "malformed_response")
        && (value.outcome.targetCondition === "unavailable" || value.outcome.targetCondition === "unknown")
        && value.outcome.recovery.length === 1
        && value.outcome.recovery[0] === "observe_again";
      const resolveCandidateUnavailableOrClaimStale = isScrollCandidateElement
        && providerAction === null
        && value.completionCertainty === "not_completed"
        && value.deliveryMode === "not_delivered"
        && value.verification === "unavailable"
        && value.unexecutedRemainder.count === 1
        && value.unexecutedRemainder.reason === "failed"
        && value.outcome.phase === "resolve_target"
        && value.outcome.retrySafety === "observe_before_retry"
        && value.outcome.stateChangeCertainty === "not_changed"
        && value.outcome.providerCondition === "ready"
        && (value.outcome.targetCondition === "unavailable" || value.outcome.targetCondition === "stale")
        && value.outcome.recovery.length === 1
        && value.outcome.recovery[0] === "observe_again";
      const resolveHumanStateUnknown = isScrollCandidateElement
        && providerAction === null
        && value.completionCertainty === "not_completed"
        && value.deliveryMode === "not_delivered"
        && value.verification === "unavailable"
        && value.unexecutedRemainder.count === 1
        && value.unexecutedRemainder.reason === "failed"
        && value.outcome.phase === "resolve_target"
        && value.outcome.retrySafety === "observe_before_retry"
        && value.outcome.stateChangeCertainty === "not_changed"
        && value.outcome.providerCondition === "unknown"
        && value.outcome.targetCondition === "unknown"
        && value.outcome.recovery.length === 1
        && value.outcome.recovery[0] === "observe_again";
      const crossedUnknownNullProviderFailure = isScrollCandidateElement
        && providerAction === null
        && value.completionCertainty === "unknown_completion"
        && value.deliveryMode === "unknown"
        && value.verification === "unavailable"
        && value.unexecutedRemainder.count === 1
        && value.unexecutedRemainder.reason === "unknown_completion"
        && value.outcome.phase === "post_effect_verification"
        && value.outcome.retrySafety === "observe_before_retry"
        && value.outcome.stateChangeCertainty === "unknown"
        && value.outcome.targetCondition === "unknown"
        && (value.outcome.providerCondition === "cancelled"
          || value.outcome.providerCondition === "unknown"
          || value.outcome.providerCondition === "malformed_response")
        && value.outcome.recovery.length === 2
        && value.outcome.recovery[0] === "observe_again"
        && value.outcome.recovery[1] === "do_not_replay";
      const crossedUnknownStageAmbiguous = isScrollCandidateElement
        && providerAction === null
        && unknownFreshFrameChange
        && value.deliveryMode === "unknown"
        && value.outcome.providerCondition === "ready";
      const crossedUnknownSyntheticFallback = isScrollCandidateElement
        && unknownFreshFrameChange
        && value.deliveryMode === providerAction?.delivery?.mode
        && value.outcome.providerCondition === "ready"
        && exactSyntheticFallback;
      const crossedUnknownAccessibilityFailure = isScrollCandidateElement
        && unknownFreshFrameChange
        && value.deliveryMode === providerAction?.delivery?.mode
        && (value.outcome.providerCondition === "ready"
          || value.outcome.providerCondition === "cancelled"
          || value.outcome.providerCondition === "unknown"
          || value.outcome.providerCondition === "malformed_response")
        && exactAccessibilityUnverifiable;
      const screenPreEffectFailure = isScreenScroll
        && providerAction === null
        && value.completionCertainty === "not_completed"
        && value.deliveryMode === "not_delivered"
        && value.verification === "unavailable"
        && value.unexecutedRemainder.count === 1
        && value.unexecutedRemainder.reason === "failed"
        && (value.outcome.phase === "resolve_target" || value.outcome.phase === "pre_effect_dispatch")
        && value.outcome.stateChangeCertainty === "not_changed"
        && value.outcome.recovery.length === 1
        && (value.outcome.recovery[0] === "observe_again" || value.outcome.recovery[0] === "retry_same_request");
      const screenUnknownSynthetic = isScreenScroll
        && unknownFreshFrameChange
        && value.deliveryMode === providerAction?.delivery?.mode
        && value.outcome.providerCondition === "ready"
        && exactSyntheticFallback;
      const screenUnknownProviderFailure = isScreenScroll
        && providerAction === null
        && unknownFreshFrameChange
        && value.deliveryMode === "unknown"
        && (value.outcome.providerCondition === "cancelled"
          || value.outcome.providerCondition === "unknown"
          || value.outcome.providerCondition === "malformed_response");
      if (!unavailableResolveTarget && !preEffectBackgroundUnavailable && !preEffectTokenRefusal && !preEffectCancelled && !preEffectCancelledUnavailable && !preEffectPreflightFailure
        && !resolveCandidateUnavailableOrClaimStale && !resolveHumanStateUnknown && !crossedUnknownNullProviderFailure && !crossedUnknownStageAmbiguous
        && !crossedUnknownSyntheticFallback && !crossedUnknownAccessibilityFailure
        && !screenPreEffectFailure && !screenUnknownSynthetic && !screenUnknownProviderFailure && !undispatchedElement) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "scroll requires one closed receipt family with an explicit provider action or null" });
      }
    }
    if (value.action === "type_text") {
      const delivery = value.textDelivery;
      if (delivery === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "type_text receipts require content-free delivery accounting" });
      } else if (delivery.deliveredCharacters !== null) {
        if (delivery.deliveredCharacters > delivery.requestedCharacters) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "delivered text cannot exceed requested text" });
        }
        if (value.completionCertainty === "completed" && delivery.deliveredCharacters !== delivery.requestedCharacters) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "completed type_text must account for every requested character" });
        }
        if (
          value.completionCertainty === "partially_completed"
          && value.unexecutedRemainder.count !== delivery.requestedCharacters - delivery.deliveredCharacters
        ) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "partial type_text remainder must equal undelivered characters" });
        }
        if (
          value.completionCertainty === "not_completed"
          && (delivery.deliveredCharacters !== 0
            || value.unexecutedRemainder.count !== delivery.requestedCharacters)
        ) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "known non-completion must account for the entire undelivered text" });
        }
      } else if (value.completionCertainty !== "unknown_completion") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "unknown delivered text count requires unknown completion" });
      } else if (value.unexecutedRemainder.count !== delivery.requestedCharacters
        || value.unexecutedRemainder.reason !== "unknown_completion") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "unknown type_text completion must fence the entire unresolved request" });
      }
      if (delivery !== undefined && delivery.maxChunkCharacters !== undefined) {
        if (value.provider !== "cua"
          || delivery.deliveredCharacters !== 0
          || delivery.maxChunkCharacters >= delivery.requestedCharacters
          || value.completionCertainty !== "not_completed"
          || value.deliveryMode !== "not_delivered"
          || value.verification !== "unavailable"
          || value.unexecutedRemainder.count !== delivery.requestedCharacters
          || value.unexecutedRemainder.reason !== "failed"
          || value.providerAction !== null
          || value.outcome.phase !== "pre_effect_dispatch"
          || value.outcome.retrySafety !== "never"
          || value.outcome.stateChangeCertainty !== "not_changed"
          || value.outcome.providerCondition !== "ready"
          || value.outcome.targetCondition !== "current"
          || value.outcome.recovery.length !== 0) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Cua synthesis refusal must expose only its dynamic chunk constraint and never authorize replay of the full text",
          });
        }
      }
    } else if (value.textDelivery !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "only type_text may carry text delivery accounting" });
    }
    if (value.action === "click") {
      const isScreen = computerScreenSnapshotReferenceSchema.safeParse(value.target).success
        && value.resolvedTarget.kind === "screen";
      const parsedClickElement = computerClickElementEvidenceSchema.safeParse(value.resolvedTarget);
      const isClickElement = computerElementTargetReferenceSchema.safeParse(value.target).success
        && parsedClickElement.success;
      const isUnavailableClickElement = computerElementTargetReferenceSchema.safeParse(value.target).success
        && unavailableElementEvidence;
      if (!isScreen && !isClickElement && !isUnavailableClickElement && !undispatchedElement) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "click requires an opaque screen snapshot or one role-selected click control" });
      }
      if (value.provider !== "cua") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "click requires the admitted Cua provider" });
      }
      if ((isClickElement || isUnavailableClickElement) && value.textDelivery !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "element click receipts never carry content accounting" });
      }
      if (isClickElement && providerAction !== undefined && providerAction !== null) {
        const semanticAction = parsedClickElement.success ? parsedClickElement.data.action : null;
        const exactConfirmed = semanticAction === "click" && providerAction.effect === "confirmed"
          && (providerAction.route === "accessibility" || providerAction.route === "synthetic_events" || providerAction.route === "global_input")
          && (providerAction.delivery?.mode === "background" || providerAction.delivery?.mode === "foreground")
          && (providerAction.route !== "global_input" || providerAction.delivery?.mode === "foreground")
          && providerAction.delivery.deliveredCount === undefined
          && providerAction.evidenceKinds.length === 1
          && providerAction.evidenceKinds[0] === "value_readback"
          && providerAction.escalation === null;
        const exactUnverifiable = semanticAction === "click" && providerAction.effect === "unverifiable"
          && (providerAction.route === "accessibility" || providerAction.route === "synthetic_events" || providerAction.route === "global_input")
          && (providerAction.delivery?.mode === "background" || providerAction.delivery?.mode === "foreground")
          && (providerAction.route !== "global_input" || providerAction.delivery?.mode === "foreground")
          && providerAction.delivery.deliveredCount === undefined
          && providerAction.evidenceKinds.length === 0
          && providerAction.escalation === null;
        const exactSuspectedNoop = semanticAction === "click" && providerAction.effect === "suspected_noop"
          && providerAction.route === "accessibility"
          && (providerAction.delivery?.mode === "background" || providerAction.delivery?.mode === "foreground")
          && providerAction.delivery.deliveredCount === undefined
          && providerAction.evidenceKinds.length === 0
          && providerAction.escalation?.target === "pixel"
          && providerAction.escalation.reason === "suspected_noop";
        const exactRightClickUnverifiable = semanticAction === "right_click"
          && providerAction.effect === "unverifiable"
          && ((providerAction.route === "synthetic_events" && providerAction.delivery?.mode === "unknown")
            || (providerAction.route === "global_input" && providerAction.delivery?.mode === "foreground"))
          && providerAction.delivery?.deliveredCount === undefined
          && providerAction.evidenceKinds.length === 0
          && providerAction.escalation === null;
        const exactDoubleClickUnverifiable = semanticAction === "double_click"
          && providerAction.effect === "unverifiable"
          && ((providerAction.route === "synthetic_events" && providerAction.delivery?.mode === "unknown")
            || (providerAction.route === "global_input" && providerAction.delivery?.mode === "foreground"))
          && providerAction.delivery?.deliveredCount === undefined
          && providerAction.evidenceKinds.length === 0
          && providerAction.escalation === null;
        const independentlyVerifiedCheckbox = semanticAction === "click"
          && parsedClickElement.data.role === "checkbox"
          && exactUnverifiable
          && value.completionCertainty === "completed"
          && value.verification === "verified"
          && value.outcome.stateChangeCertainty === "changed"
          && value.outcome.retrySafety === "never"
          && value.outcome.recovery.length === 0
          && value.unexecutedRemainder.count === 0
          && value.unexecutedRemainder.reason === "none";
        if (!exactConfirmed && !exactUnverifiable && !exactSuspectedNoop && !exactRightClickUnverifiable && !exactDoubleClickUnverifiable) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "element click requires one exact pinned Cua 0.23.2 action result" });
        }
        if ((exactUnverifiable || exactSuspectedNoop || exactRightClickUnverifiable || exactDoubleClickUnverifiable)
          && !independentlyVerifiedCheckbox
          && (value.completionCertainty !== "unknown_completion"
            || value.verification !== "not_verified"
            || value.outcome.stateChangeCertainty !== "unknown"
            || !value.outcome.recovery.includes("do_not_replay")
            || value.unexecutedRemainder.reason !== "unknown_completion")) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "indeterminate element click requires unknown-completion fencing and no replay" });
        }
      }
    }
    if (value.action === "create_window") {
      if (!computerAppTargetReferenceSchema.safeParse(value.target).success || value.resolvedTarget.kind !== "app") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "create_window requires exact application evidence" });
      }
      if (value.provider !== "cua") context.addIssue({ code: z.ZodIssueCode.custom, message: "create_window requires Cua" });
      const preBoundary = value.completionCertainty === "not_completed";
      if (preBoundary) {
        if (value.postObservation !== undefined
          || value.deliveryMode !== "not_delivered"
          || value.verification !== "unavailable"
          || value.unexecutedRemainder.count !== 1
          || value.unexecutedRemainder.reason !== "failed"
          || (value.outcome.phase !== "resolve_target" && value.outcome.phase !== "pre_effect_dispatch")
          || value.outcome.stateChangeCertainty !== "not_changed"
          || (value.providerAction !== undefined && value.providerAction !== null)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "pre-boundary create_window failure must publish no handoff and prove no effect" });
        }
        const recovery = value.outcome.recovery;
        const canonicalRecovery = (
          value.outcome.retrySafety === "safe"
          && value.outcome.providerCondition === "cancelled"
          && value.outcome.targetCondition === "current"
          && recovery.length === 1
          && recovery[0] === "retry_same_request"
        ) || (
          value.outcome.retrySafety === "observe_before_retry"
          && (value.outcome.targetCondition === "stale"
            || value.outcome.targetCondition === "unavailable"
            || value.outcome.targetCondition === "unknown")
          && recovery.length === 1
          && recovery[0] === "observe_again"
        ) || (
          value.outcome.retrySafety === "never"
          && value.outcome.providerCondition === "ready"
          && value.outcome.targetCondition === "current"
          && recovery.length === 0
        );
        if (!canonicalRecovery) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "pre-boundary create_window recovery must be cancelled, freshly observed, or a final local refusal" });
        }
        return;
      }
      const crossedAppEvidence = computerTargetEvidenceSchema.safeParse(value.resolvedTarget);
      if (!crossedAppEvidence.success || crossedAppEvidence.data.appLabel === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "crossed create_window requires resolved application identity" });
      }
      if (value.postObservation === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "crossed create_window requires an appeared-window handoff result" });
        return;
      }
      if (value.postObservation?.window !== undefined && value.postObservation.window.target.context === value.target.context) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "created window must mint a fresh context, never reuse the pre-effect app target" });
      }
      if (value.postObservation?.app !== undefined && value.postObservation.app.target.context === value.target.context) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "refreshed application authority must mint a new context" });
      }
      const menuProviderAction = value.providerAction;
      const isObservedMenuAction = menuProviderAction !== undefined
        && menuProviderAction !== null
        && menuProviderAction.effect === "unverifiable"
        && menuProviderAction.route === "accessibility"
        && menuProviderAction.delivery?.mode === "foreground"
        && menuProviderAction.evidenceKinds.length === 0
        && menuProviderAction.escalation === null;
      if (menuProviderAction !== undefined && menuProviderAction !== null && !isObservedMenuAction) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "create_window may retain only Cua's exact sanitized menu action result" });
      }
      if (value.outcome.providerCondition === "ready" && !isObservedMenuAction) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "a crossed ready create_window receipt must retain Cua's exact menu action result" });
      }
      if (value.outcome.providerCondition !== "ready" && menuProviderAction !== undefined && menuProviderAction !== null) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "a non-ready create_window receipt cannot claim a menu action result" });
      }
      const unique = value.postObservation?.disposition === "unique";
      if (unique && (value.completionCertainty !== "completed"
        || value.deliveryMode !== "foreground"
        || value.verification !== "verified"
        || value.unexecutedRemainder.count !== 0
        || value.unexecutedRemainder.reason !== "none"
        || value.outcome.phase !== "post_effect_verification"
        || value.outcome.retrySafety !== "never"
        || value.outcome.stateChangeCertainty !== "changed"
        || value.outcome.providerCondition !== "ready"
        || value.outcome.targetCondition !== "current"
        || value.outcome.recovery.length !== 1
        || value.outcome.recovery[0] !== "do_not_replay")) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "a unique created-window handoff is the only verified create-window completion" });
      }
      if (!unique && (value.completionCertainty !== "unknown_completion"
        || (value.outcome.providerCondition === "ready" ? value.deliveryMode !== "foreground" : value.deliveryMode !== "unknown")
        || value.verification !== "not_verified"
        || value.unexecutedRemainder.count !== 1
        || value.unexecutedRemainder.reason !== "unknown_completion"
        || value.outcome.phase !== "post_effect_verification"
        || value.outcome.retrySafety !== "observe_before_retry"
        || value.outcome.stateChangeCertainty !== "unknown"
        || value.outcome.recovery.length !== 2
        || value.outcome.recovery[0] !== "observe_again"
        || value.outcome.recovery[1] !== "do_not_replay"
        || (value.outcome.providerCondition !== "ready" && menuProviderAction !== undefined && menuProviderAction !== null))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "an incomplete create-window handoff requires fresh observation and prohibits replay" });
      }
    } else if (value.postObservation !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "only create_window may carry appeared-window handoff state" });
    }
  });

const computerLaunchProgressSchema = z
  .object({
    requested: z.boolean(),
    processRunning: z.boolean(),
    windowReady: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.requested && (value.processRunning || value.windowReady)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "unrequested launch cannot report a running process or ready window" });
    }
    if (!value.processRunning && value.windowReady) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "a ready window requires a running process" });
    }
  });

/**
 * Separate from the generic mutation receipt: app launch begins with a
 * semantic name and can mint targets, rather than acting on a pre-existing
 * opaque target. It is deliberately provider-free and content-safe.
 */
export const computerLaunchReceiptSchema = z
  .object({
    version: z.literal(1),
    timing: z.literal("immediate"),
    action: z.literal("launch_app"),
    app: z.object({
      name: computerSemanticAppNameSchema,
      target: computerAppTargetReferenceSchema.nullable(),
    }).strict(),
    window: computerWindowTargetReferenceSchema.nullable(),
    launchProgress: computerLaunchProgressSchema.nullable(),
    windowSelection: z.enum(["none", "unique", "ambiguous", "unknown"]),
    completionCertainty: z.enum(["completed", "not_completed", "unknown_completion"]),
    verification: z.enum(["required", "not_applicable"]),
    outcome: computerOperationOutcomeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const progress = value.launchProgress;
    if (progress === null) {
      if (value.app.target !== null || value.window !== null || value.windowSelection !== "unknown") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "unknown launch progress cannot claim minted targets or window selection" });
      }
      if (value.completionCertainty !== "unknown_completion" || value.outcome.stateChangeCertainty !== "unknown" || !value.outcome.recovery.includes("do_not_replay")) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "unknown launch completion must prohibit replay" });
      }
      if (value.verification !== "not_applicable") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "unknown launch completion has no target-specific verification route" });
      }
      return;
    }
    if (value.completionCertainty === "unknown_completion") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "known launch progress cannot claim unknown completion" });
    }
    if (progress.processRunning && value.app.target === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "a known running app must carry its minted opaque app target" });
    }
    if (!progress.processRunning && value.app.target !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "a non-running app cannot carry a minted app target" });
    }
    if (progress.processRunning !== (value.completionCertainty === "completed")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "known launch completion must match the process-running fact" });
    }
    if (!progress.windowReady && (value.window !== null || value.windowSelection !== "none")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "a not-ready launch cannot claim a window target or selection" });
    }
    if (progress.windowReady && !(
      (value.windowSelection === "unique" && value.window !== null)
      || (value.windowSelection === "ambiguous" && value.window === null)
    )) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "a ready launch must select one unique window or honestly report ambiguity" });
    }
    if ((value.windowSelection === "none" || value.windowSelection === "ambiguous") && value.window !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "only a unique window selection may carry a window target" });
    }
    if (value.windowSelection === "unknown") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "known launch progress cannot claim unknown window selection" });
    }
    if (value.verification !== (progress.windowReady ? "required" : "not_applicable")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "launch verification is required exactly when a window is ready" });
    }
    if (value.app.target !== null && value.window !== null && value.app.target.context !== value.window.context) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "minted app and unique window targets must share one context" });
    }
  });

const computerVerificationBoundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite(),
    tolerancePx: z.number().finite().min(0).optional(),
  })
  .strict();

const computerNonblankVerificationStringSchema = z.string().regex(/\S/u, "verification text cannot be blank");
const computerVerificationElementSelectorSchema = z.union([
  z.object({
    role: computerNonblankVerificationStringSchema,
    labelContains: computerNonblankVerificationStringSchema.optional(),
  }).strict(),
  z.object({
    role: computerNonblankVerificationStringSchema.optional(),
    labelContains: computerNonblankVerificationStringSchema,
  }).strict(),
]);

/** Exact provider-neutral projection of Cua `StatePredicate`, without raw IDs. */
const computerVerificationWindowSchema = z.union([
  z.object({ exists: z.boolean(), bounds: computerVerificationBoundsSchema.optional() }).strict(),
  z.object({ exists: z.boolean().optional(), bounds: computerVerificationBoundsSchema }).strict(),
]);
const computerVerificationElementSchema = z.object({
  selector: computerVerificationElementSelectorSchema,
  exists: z.literal(true).optional(),
  valueEquals: z.string().optional(),
  enabled: z.boolean().optional(),
  selected: z.boolean().optional(),
}).strict();
const computerVerificationPredicateSchema = z.union([
  z.object({ window: computerVerificationWindowSchema }).strict(),
  z.object({ element: computerVerificationElementSchema }).strict(),
]);

/**
 * Read-only semantic Cua verification. The public surface deliberately fixes
 * sampling and screenshot policy in the adapter; it does not create a second
 * model-controlled polling or content-exfiltration channel.
 */
export const computerVerifyInputSchema = z
  .object({
    target: computerWindowTargetReferenceSchema,
    expect: z.array(computerVerificationPredicateSchema).min(1),
  })
  .strict();

/** Content-safe projection of Cua `VerifyStateOutput`; observed_json is excluded. */
export const computerVerificationReceiptSchema = z
  .object({
    version: z.literal(1),
    target: computerWindowTargetReferenceSchema,
    provider: z.literal("cua"),
    status: z.enum(["satisfied", "unsatisfied", "unknown"]),
    stable: z.boolean(),
    elapsedMs: z.number().int().nonnegative(),
    samples: z.number().int().min(1),
    predicates: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        status: z.enum(["satisfied", "unsatisfied", "unknown"]),
        unknownReason: z.enum([
          "invalid_predicate",
          "unsupported_predicate",
          "untrusted_source",
          "multi_match",
          "target_missing",
          "observation_unavailable",
          "stability_unproven",
        ]).nullable(),
      }).strict(),
    ).min(1),
    outcome: computerOperationOutcomeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.predicates.every((predicate, index) => predicate.index === index)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "verification predicate indices must be contiguous from zero",
      });
    }
    for (const predicate of value.predicates) {
      if ((predicate.status === "unknown") !== (predicate.unknownReason !== null)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "unknown verification predicates must carry an unknown reason and known predicates must not",
        });
      }
    }
    if (value.status === "satisfied" && (!value.stable || value.predicates.some((predicate) => predicate.status !== "satisfied"))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "satisfied verification requires stable, satisfied predicate results",
      });
    }
    if (value.status !== "satisfied" && value.stable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "only satisfied verification results may be stable",
      });
    }
    if (value.status === "unsatisfied" && value.predicates.every((predicate) => predicate.status !== "unsatisfied")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unsatisfied verification requires an unsatisfied predicate result",
      });
    }
    if (value.status === "unknown" && value.predicates.every((predicate) => predicate.status !== "unknown")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unknown verification requires an unknown predicate result",
      });
    }
    const hasUnsatisfied = value.predicates.some((predicate) => predicate.status === "unsatisfied");
    const hasUnknown = value.predicates.some((predicate) => predicate.status === "unknown");
    const aggregateStatus = hasUnsatisfied ? "unsatisfied" : hasUnknown ? "unknown" : "satisfied";
    if (value.status !== aggregateStatus) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "verification status must aggregate unsatisfied before unknown, and unknown before satisfied",
      });
    }
  });

/**
 * A recoverable native read failure is still a public contract result. Keep it
 * compact and provider-neutral, but bind it to the attempted semantic
 * operation so the model can follow the normalized recovery without guessing.
 */
const computerObserveFailureResultSchema = z
  .object({
    version: z.literal(1),
    operation: z.enum(["desktop_state", "window_state", "application_windows", "window_region"]),
    outcome: computerOperationOutcomeSchema,
  })
  .strict();

const computerVerifyFailureResultSchema = z
  .object({
    version: z.literal(1),
    operation: z.literal("verify"),
    outcome: computerOperationOutcomeSchema,
  })
  .strict();

const computerObservationResultVariants = [
  desktopStateObservationSchema,
  windowStateObservationSchema,
  applicationWindowsObservationSchema,
  windowRegionObservationSchema,
] as const;

/** Successful observations only; Host attachment handling relies on this narrower type. */
export const computerObservationResultSchema = z.union(computerObservationResultVariants);

/** Public native Cua schemas. Provider JSON, native identifiers, and image bytes never enter them. */
export const NATIVE_CONTRACT_SCHEMAS = {
  observe: {
    input: computerObserveInputSchema,
    result: z.union([
      ...computerObservationResultVariants,
      computerObserveFailureResultSchema,
    ]),
  },
  do: {
    input: computerDoInputSchema,
    result: z.union([computerMutationReceiptSchema, computerLaunchReceiptSchema]),
  },
  verify: {
    input: computerVerifyInputSchema,
    result: z.union([computerVerificationReceiptSchema, computerVerifyFailureResultSchema]),
  },
} as const;

function schemaDigest(schemas: Readonly<{ input: z.ZodType; result: z.ZodType }>): `sha256:${string}` {
  return computeComputerUseSchemaDigest(schemas.input, schemas.result);
}

/** Immutable native descriptors shared by the signed catalogue and Host build. */
export const COMPUTER_USE_NATIVE_CONTRACTS = {
  observe: {
    contractNamespace: "nautilo.computer_use",
    contractId: "native.observe",
    contractVersion: 11,
    schemaDigest: schemaDigest(NATIVE_CONTRACT_SCHEMAS.observe),
    effectClass: "read",
    replayClass: "safe",
    authorityClass: "standing_computer_use",
    attachmentClass: "png",
    disclosureClass: "semantic_and_visual",
  },
  do: {
    contractNamespace: "nautilo.computer_use",
    contractId: "native.do",
    // v13 accepts action-neutral controls from native.observe v11 while
    // preserving operation-bound legacy selections and one-shot dispatch.
    contractVersion: 13,
    schemaDigest: schemaDigest(NATIVE_CONTRACT_SCHEMAS.do),
    effectClass: "mutate",
    replayClass: "at_most_once",
    authorityClass: "standing_computer_use",
    attachmentClass: "none",
    disclosureClass: "semantic",
  },
  verify: {
    contractNamespace: "nautilo.computer_use",
    contractId: "native.verify",
    contractVersion: 3,
    schemaDigest: schemaDigest(NATIVE_CONTRACT_SCHEMAS.verify),
    effectClass: "read",
    replayClass: "safe",
    authorityClass: "standing_computer_use",
    attachmentClass: "none",
    disclosureClass: "semantic",
  },
} as const;
