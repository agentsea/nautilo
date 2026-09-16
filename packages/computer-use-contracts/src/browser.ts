import { z } from "zod";

import { computerWindowTargetReferenceSchema } from "./references.js";

const browserContextReferenceSchema = z.string().regex(/^dbctx_[A-Za-z0-9_-]{43}$/);
const browserReferenceBase = z.object({
  version: z.literal(1),
  context: browserContextReferenceSchema,
}).strict();

export const computerBrowserTargetReferenceSchema = browserReferenceBase.extend({
  reference: z.string().regex(/^dbtgt_[A-Za-z0-9_-]{43}$/),
}).strict();
export const computerBrowserTabReferenceSchema = browserReferenceBase.extend({
  reference: z.string().regex(/^dbtab_[A-Za-z0-9_-]{43}$/),
}).strict();
export const computerBrowserElementReferenceSchema = browserReferenceBase.extend({
  reference: z.string().regex(/^dbref_[A-Za-z0-9_-]{43}$/),
}).strict();
export const computerBrowserContentReferenceSchema = browserReferenceBase.extend({
  reference: z.string().regex(/^dbcontent_[A-Za-z0-9_-]{43}$/),
}).strict();
export const computerBrowserContinuationReferenceSchema = browserReferenceBase.extend({
  reference: z.string().regex(/^dbcont_[A-Za-z0-9_-]{43}$/),
}).strict();
export const computerBrowserDialogReferenceSchema = browserReferenceBase.extend({
  reference: z.string().regex(/^dbdlg_[A-Za-z0-9_-]{43}$/),
}).strict();

export const COMPUTER_BROWSER_RECOVERY_ACTIONS = [
  "prepare_browser",
  "request_access",
  "use_native_window",
  "observe_again",
] as const;
export const computerBrowserRecoveryActionSchema = z.enum(COMPUTER_BROWSER_RECOVERY_ACTIONS);

/** Closed, content-free explanation; provider messages and native identities stay local. */
export const computerBrowserFailureSchema = z.object({
  reason: z.enum([
    "setup_control_ambiguous", "setup_required", "route_unavailable", "target_ambiguous",
    "target_stale", "wrong_target", "tab_required", "tab_unavailable", "input_trust_unavailable",
    "endpoint_identity_mismatch", "access_required", "access_revoked", "connection_lost",
    "input_incomplete", "action_unavailable", "outside_scope", "invalid_provider_response",
    "transport_unavailable", "authority_revoked", "cancelled", "page_unavailable",
  ]),
  stage: z.enum(["bind", "prepare", "read", "action"]),
  stateChangeCertainty: z.enum(["not_changed", "changed", "unknown"]),
  retryCondition: z.enum([
    "fresh_target", "preparation_required", "access_required", "route_or_provider_change",
    "inspect_effects_before_continuing",
  ]),
  inputRoute: z.enum(["trusted", "dom_event"]).optional(),
  escalation: z.object({
    target: z.enum(["pixel", "foreground", "page", "session"]),
    reason: z.enum(["route_unavailable", "delivery_failed", "effect_unconfirmed", "suspected_noop", "permission_required"]),
  }).strict().optional(),
}).strict();
export type ComputerBrowserFailure = z.infer<typeof computerBrowserFailureSchema>;

export const browserBindWindowInputSchema = z.object({
  window: computerWindowTargetReferenceSchema,
}).strict();

export const browserPrepareInputSchema = z.object({
  window: computerWindowTargetReferenceSchema,
}).strict();

const browserBoundTabSchema = z.object({
  target: computerBrowserTabReferenceSchema,
  title: z.string(),
  url: z.string(),
  active: z.boolean().nullable(),
}).strict();

const browserBoundProjectionSchema = z.object({
  target: computerBrowserTargetReferenceSchema,
  bindingQuality: z.literal("exact"),
  mutationAllowed: z.literal(true),
  tabs: z.array(browserBoundTabSchema),
}).strict();

const browserPrepareSideEffectsSchema = z.object({
  launchedBrowser: z.boolean(),
  restartedBrowser: z.boolean(),
  createdProfile: z.boolean(),
  reusedDriverProfile: z.boolean(),
  copiedProfileData: z.boolean(),
  changedPreferences: z.boolean(),
  displayedConsentPrompt: z.boolean(),
  openedSetupPage: z.boolean(),
  closedSetupPage: z.boolean(),
  enabledRemoteDebugging: z.boolean(),
  usedBoundedPixelFallback: z.boolean(),
  focusedSetupAddressField: z.boolean(),
  foregroundedWindow: z.boolean(),
  injectedGlobalInput: z.boolean(),
}).strict();

export const browserPrepareResultSchema = z.discriminatedUnion("status", [
  browserBoundProjectionSchema.extend({
    status: z.literal("prepared"),
    action: z.enum(["already_prepared", "attached_existing_profile"]),
    sideEffects: browserPrepareSideEffectsSchema,
    doNotReplay: z.literal(true),
  }).strict(),
  z.object({
    status: z.literal("recovery_required"),
    recovery: computerBrowserRecoveryActionSchema,
    observeAgain: z.literal(true),
    doNotReplay: z.literal(true),
    failure: computerBrowserFailureSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal("unknown_completion"),
    observeAgain: z.literal(true),
    doNotReplay: z.literal(true),
    failure: computerBrowserFailureSchema.optional(),
  }).strict(),
]);

export const browserBindWindowResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("bound"),
    target: computerBrowserTargetReferenceSchema,
    bindingQuality: z.literal("exact"),
    mutationAllowed: z.literal(true),
    tabs: z.array(browserBoundTabSchema),
  }).strict(),
  z.object({
    status: z.literal("recovery_required"),
    recovery: computerBrowserRecoveryActionSchema,
    failure: computerBrowserFailureSchema.optional(),
  }).strict(),
]);

const browserReadPageBaseShape = {
  target: computerBrowserTargetReferenceSchema,
  tab: computerBrowserTabReferenceSchema,
} as const;
export const browserReadPageInputSchema = z.union([
  z.object({
    ...browserReadPageBaseShape,
    query: z.string().optional(),
    scope: computerBrowserContentReferenceSchema.optional(),
  }).strict(),
  z.object({
    ...browserReadPageBaseShape,
    continuation: computerBrowserContinuationReferenceSchema,
  }).strict(),
]);

const browserOmissionSchema = z.object({
  cssHidden: z.number().int().nonnegative(),
  offscreen: z.number().int().nonnegative(),
  pageOccluded: z.number().int().nonnegative(),
  noLayout: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  budget: z.number().int().nonnegative(),
  unprovableFrame: z.number().int().nonnegative(),
}).strict();

const browserListedReferenceSchema = z.object({
  target: z.union([computerBrowserElementReferenceSchema, computerBrowserContentReferenceSchema]),
  role: z.string(),
  name: z.string().nullable(),
  value: z.string().nullable(),
  visibility: z.enum([
    "in_viewport",
    "near_viewport",
    "offscreen",
    "css_hidden",
    "no_layout",
    "page_occluded",
    "unknown",
  ]),
  actions: z.array(z.enum(["click", "type", "pointer", "scroll"])),
}).strict();

export const browserReadPageResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("observed"),
    target: computerBrowserTargetReferenceSchema,
    tab: computerBrowserTabReferenceSchema,
    page: z.object({ title: z.string(), url: z.string() }).strict(),
    outline: z.string(),
    refs: z.array(browserListedReferenceSchema),
    snapshot: z.object({
      complete: z.boolean(),
      omitted: browserOmissionSchema,
      continuation: computerBrowserContinuationReferenceSchema.nullable(),
    }).strict(),
  }).strict(),
  z.object({
    status: z.literal("recovery_required"),
    recovery: computerBrowserRecoveryActionSchema,
    failure: computerBrowserFailureSchema.optional(),
  }).strict(),
]);

const browserHttpUrlSchema = z.intersection(
  z.url(),
  // The pattern independently rejects malformed/dangerous schemes even in a
  // JSON-Schema validator that does not implement the optional `uri` format.
  z.string().regex(/^(?:https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?|about:[A-Za-z0-9._~-]+(?:[?#][^\s]*)?)$/u, "browser URL must use http, https, or about"),
);

const browserMutationTargetSchema = z.object({
  target: computerBrowserTargetReferenceSchema,
  tab: computerBrowserTabReferenceSchema,
}).strict();

export const browserNavigateInputSchema = browserMutationTargetSchema.extend({
  url: browserHttpUrlSchema,
}).strict();

export const browserOpenUrlInputSchema = z.object({
  target: computerBrowserTargetReferenceSchema,
  url: browserHttpUrlSchema,
}).strict();

export const browserOpenUrlResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("opened"),
    target: computerBrowserTargetReferenceSchema,
    tab: computerBrowserTabReferenceSchema,
    page: z.object({ title: z.string(), url: z.string() }).strict(),
    outline: z.string(),
    doNotReplay: z.literal(true),
  }).strict(),
  z.object({
    status: z.literal("delivered"),
    target: computerBrowserTargetReferenceSchema,
    tab: computerBrowserTabReferenceSchema,
    observeAgain: z.literal(true),
    doNotReplay: z.literal(true),
  }).strict(),
  z.object({
    status: z.literal("not_delivered"),
    observeAgain: z.literal(true),
    doNotReplay: z.literal(true),
    recovery: computerBrowserRecoveryActionSchema,
    failure: computerBrowserFailureSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal("unknown_completion"),
    target: computerBrowserTargetReferenceSchema.optional(),
    tab: computerBrowserTabReferenceSchema.optional(),
    observeAgain: z.literal(true),
    doNotReplay: z.literal(true),
    failure: computerBrowserFailureSchema.optional(),
  }).strict(),
]);

export const browserClickInputSchema = browserMutationTargetSchema.extend({
  element: computerBrowserElementReferenceSchema,
  inputRoute: z.enum(["trusted", "dom_event"]).default("trusted"),
}).strict();

export const browserTypeInputSchema = browserMutationTargetSchema.extend({
  element: computerBrowserElementReferenceSchema,
  text: z.string(),
  mode: z.enum(["insert_text", "keystrokes"]).default("insert_text"),
  replace: z.boolean().default(false),
}).strict();

const browserPointerBaseSchema = browserMutationTargetSchema.extend({
  element: computerBrowserElementReferenceSchema,
  inputRoute: z.enum(["trusted", "dom_event"]).default("trusted"),
}).strict();

const browserNonzeroDeltaSchema = z.union([
  z.number().finite().negative(),
  z.number().finite().positive(),
]);

export const browserPointerInputSchema = z.union([
  browserPointerBaseSchema.extend({
    action: z.enum(["hover", "right_click", "double_click"]),
  }).strict(),
  browserPointerBaseSchema.extend({
    action: z.literal("scroll"),
    deltaX: browserNonzeroDeltaSchema,
    deltaY: z.number().finite().default(0),
  }).strict(),
  browserPointerBaseSchema.extend({
    action: z.literal("scroll"),
    deltaX: z.literal(0).default(0),
    deltaY: browserNonzeroDeltaSchema,
  }).strict(),
  browserPointerBaseSchema.extend({
    action: z.literal("drag"),
    destination: computerBrowserElementReferenceSchema,
  }).strict(),
]);

export const browserDialogInputSchema = z.discriminatedUnion("action", [
  browserMutationTargetSchema.extend({ action: z.literal("inspect") }).strict(),
  browserMutationTargetSchema.extend({
    action: z.literal("accept"),
    dialog: computerBrowserDialogReferenceSchema,
    promptText: z.string().optional(),
    deliveryMode: z.enum(["background", "foreground"]).default("background"),
  }).strict(),
  browserMutationTargetSchema.extend({
    action: z.literal("dismiss"),
    dialog: computerBrowserDialogReferenceSchema,
    deliveryMode: z.enum(["background", "foreground"]).default("background"),
  }).strict(),
]);

export const browserMutationResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("delivered"),
    observeAgain: z.literal(true),
    doNotReplay: z.literal(true),
  }).strict(),
  z.object({
    status: z.literal("not_delivered"),
    observeAgain: z.literal(true),
    doNotReplay: z.literal(true),
    recovery: computerBrowserRecoveryActionSchema,
    failure: computerBrowserFailureSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal("unknown_completion"),
    observeAgain: z.literal(true),
    doNotReplay: z.literal(true),
    failure: computerBrowserFailureSchema.optional(),
  }).strict(),
]);

export const browserDialogResultSchema = z.union([
  z.object({
    status: z.literal("observed"),
    present: z.literal(false),
  }).strict(),
  z.object({
    status: z.literal("observed"),
    present: z.literal(true),
    dialog: computerBrowserDialogReferenceSchema,
    kind: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
  }).strict(),
  z.object({
    status: z.literal("recovery_required"),
    recovery: computerBrowserRecoveryActionSchema,
    failure: computerBrowserFailureSchema.optional(),
  }).strict(),
  browserMutationResultSchema,
]);

export const BROWSER_CONTRACT_SCHEMAS = {
  bindWindow: { input: browserBindWindowInputSchema, result: browserBindWindowResultSchema },
  prepare: { input: browserPrepareInputSchema, result: browserPrepareResultSchema },
  readPage: { input: browserReadPageInputSchema, result: browserReadPageResultSchema },
  openUrl: { input: browserOpenUrlInputSchema, result: browserOpenUrlResultSchema },
  navigate: { input: browserNavigateInputSchema, result: browserMutationResultSchema },
  click: { input: browserClickInputSchema, result: browserMutationResultSchema },
  type: { input: browserTypeInputSchema, result: browserMutationResultSchema },
  pointer: { input: browserPointerInputSchema, result: browserMutationResultSchema },
  dialog: { input: browserDialogInputSchema, result: browserDialogResultSchema },
} as const;

/** Immutable descriptors shared by the signed catalogue and Host build. */
export const COMPUTER_USE_BROWSER_CONTRACTS = {
  bindWindow: {
    contractNamespace: "nautilo.computer_use",
    contractId: "browser.bind_window",
    contractVersion: 3,
    schemaDigest: "sha256:a8a326b6948dd07592913a70178a5714834b7aeee33fda6a4a4557ef183ce313",
    effectClass: "read",
    replayClass: "safe",
    authorityClass: "standing_computer_use",
    attachmentClass: "none",
    disclosureClass: "semantic",
  },
  prepare: {
    contractNamespace: "nautilo.computer_use",
    contractId: "browser.prepare",
    contractVersion: 4,
    schemaDigest: "sha256:b34870ddef0c336f4d8577407a8bfc95e45d229e12ca5c06c50baf4de24037a1",
    effectClass: "sensitive",
    replayClass: "at_most_once",
    authorityClass: "standing_computer_use",
    attachmentClass: "none",
    disclosureClass: "semantic",
  },
  readPage: {
    contractNamespace: "nautilo.computer_use",
    contractId: "browser.read_page",
    contractVersion: 5,
    schemaDigest: "sha256:5aefb67e6419e7f7ba3e2c317d0e42e69196b159f0f3fa82ecf23b31cc9e63c2",
    effectClass: "read",
    replayClass: "safe",
    authorityClass: "standing_computer_use",
    attachmentClass: "none",
    disclosureClass: "semantic",
  },
  openUrl: {
    contractNamespace: "nautilo.computer_use",
    contractId: "browser.open_url",
    contractVersion: 4,
    schemaDigest: "sha256:600144e2bf1fd96dd1c4126687d9cf778061651c1174144217eac81fd6215aad",
    effectClass: "mutate",
    replayClass: "at_most_once",
    authorityClass: "standing_computer_use",
    attachmentClass: "none",
    disclosureClass: "semantic",
  },
  navigate: {
    contractNamespace: "nautilo.computer_use",
    contractId: "browser.navigate",
    contractVersion: 4,
    schemaDigest: "sha256:559d33c3335e249868dbce7db5bb37a8756dff76363dc44f3b699d7e2e7ae567",
    effectClass: "mutate",
    replayClass: "at_most_once",
    authorityClass: "standing_computer_use",
    attachmentClass: "none",
    disclosureClass: "semantic",
  },
  click: {
    contractNamespace: "nautilo.computer_use",
    contractId: "browser.click",
    contractVersion: 3,
    schemaDigest: "sha256:4bae30cb3d410984df8dbba05d4411400362046dd1c3dc69a7f00b35c2bf1447",
    effectClass: "mutate",
    replayClass: "at_most_once",
    authorityClass: "standing_computer_use",
    attachmentClass: "none",
    disclosureClass: "semantic",
  },
  type: {
    contractNamespace: "nautilo.computer_use",
    contractId: "browser.type",
    contractVersion: 3,
    schemaDigest: "sha256:04cefd3ff87c0cc7964fab35235a32be52884aa34530c719e113d597e6c6f4bb",
    effectClass: "mutate",
    replayClass: "at_most_once",
    authorityClass: "standing_computer_use",
    attachmentClass: "none",
    disclosureClass: "semantic",
  },
  pointer: {
    contractNamespace: "nautilo.computer_use",
    contractId: "browser.pointer",
    contractVersion: 4,
    schemaDigest: "sha256:78fa161dd99e901d2d1a312a0f15c35a4783c4061bf0b1b65001054b9aa683f9",
    effectClass: "mutate",
    replayClass: "at_most_once",
    authorityClass: "standing_computer_use",
    attachmentClass: "none",
    disclosureClass: "semantic",
  },
  dialog: {
    contractNamespace: "nautilo.computer_use",
    contractId: "browser.dialog",
    contractVersion: 3,
    schemaDigest: "sha256:bbce237701bf74575887b6cf43f4db83c46302d9fcd38152e3a53390a5da9b3e",
    effectClass: "mutate",
    replayClass: "at_most_once",
    authorityClass: "standing_computer_use",
    attachmentClass: "none",
    disclosureClass: "semantic",
  },
} as const;

export type ComputerBrowserTargetReference = z.infer<typeof computerBrowserTargetReferenceSchema>;
export type ComputerBrowserTabReference = z.infer<typeof computerBrowserTabReferenceSchema>;
export type ComputerBrowserElementReference = z.infer<typeof computerBrowserElementReferenceSchema>;
export type ComputerBrowserContentReference = z.infer<typeof computerBrowserContentReferenceSchema>;
export type ComputerBrowserContinuationReference = z.infer<typeof computerBrowserContinuationReferenceSchema>;
export type ComputerBrowserDialogReference = z.infer<typeof computerBrowserDialogReferenceSchema>;
export type ComputerBrowserRecoveryAction = z.infer<typeof computerBrowserRecoveryActionSchema>;
