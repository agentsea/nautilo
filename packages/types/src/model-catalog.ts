/**
 * safe, signed model-catalog contract.
 *
 * Mirrors the canonical JSON Schema in `nautilo-catalogs/schemas/model-catalog.schema.json`
 * and the signed release-pointer contract in
 * `nautilo-catalogs/scripts/publish-model-catalog.mjs`. The manifest carries only
 * model membership and descriptive capabilities (identity, routing class,
 * modalities, features, privacy/intelligence/cost, static token limits). It MUST
 * NOT contain credentials, provider URLs, account fingerprints, deployment-local
 * availability/health/cooldown, operator reasoning settings, China-routing
 * consent, or any future field until its security semantics have been
 * explicitly reviewed. All objects are strict: unknown properties are rejected.
 *
 * The release pointer is the minimal signed document CI republishes on each
 * release: exactly `{ catalogVersion, artifactSha256, signature, signingKeyId }`.
 * The immutable manifest URL is always derived from the pointer URL's own
 * `models/` directory plus the validated `catalogVersion` — never read from the
 * pointer body. The canonical signing payload is exactly:
 *
 * nautilo-model-catalog-v1\ncatalogVersion=<v>\nartifactSha256=<hex>\n
 *
 * Verification order (enforced by the remote loader): strict pointer shape →
 * trusted signingKeyId → Ed25519 signature over the canonical payload → exact
 * immutable artifact SHA-256 → strict manifest schema → atomic snapshot replace.
 * Unknown key / signature / hash / schema / transport failures retain the
 * last-known-good or checked-in bootstrap; the loader never accepts unsigned or
 * unknown-key content.
 */
import { z } from "zod";

/**
 * The original strict, model-only manifest version. Keep this exported name
 * stable because callers use it when constructing bootstrap fixtures.
 */
export const MODEL_CATALOG_VERSION = 1;
/**
 * Reader-first extension for the optional Reasoning and Serving controls. A
 * v1 manifest remains model-only and rejects `controls`; a v2 manifest is the
 * only manifest that may carry those reviewed fields.
 */
export const MODEL_CATALOG_CONTROLS_VERSION = 2;
/**
 * Reader-first extension for non-chat generation rows. A v3 manifest can
 * describe bounded media output and reference capability facts without
 * pretending those rows are chat-completions candidates.
 */
export const MODEL_CATALOG_MEDIA_VERSION = 3;
/** Reader-first support for typed decisions, distinct from chat generation. */
export const MODEL_CATALOG_DECISION_VERSION = 4;
export const MODEL_CATALOG_SPEECH_VERSION = 5;
export const MODEL_CATALOG_TYPED_DECISION_VERSION = 6;
export const MODEL_CATALOG_SUPPORTED_VERSIONS = [
  MODEL_CATALOG_VERSION,
  MODEL_CATALOG_CONTROLS_VERSION,
  MODEL_CATALOG_MEDIA_VERSION,
  MODEL_CATALOG_DECISION_VERSION,
  MODEL_CATALOG_SPEECH_VERSION,
  MODEL_CATALOG_TYPED_DECISION_VERSION,
] as const;
export const MODEL_CATALOG_MAX_ENTRIES = 500;

const catalogReleaseVersion = z
  .string()
  .regex(/^\d{4}\.\d{2}\.\d{2}\.[1-9]\d*$/, "must use YYYY.MM.DD.N format with a positive revision")
  .refine((value) => {
    const [yearText, monthText, dayText] = value.split(".");
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, "must contain a valid calendar date");
const catalogPublishedAt = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "must be a UTC timestamp");
const providerSlug = z.string().regex(/^[a-z][a-z0-9-]*$/, "must be a lowercase provider slug");
const modelId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9/._-]*$/, "must be a provider:rest stable id");
const displayName = z.string().trim().min(1).max(160);
const priority = z.number().int().min(1).max(999);
const costCoefficient = z.number().gt(0).max(1000);
const privacyGrade = z.number().int().min(1).max(10);

const routingClassSchema = z.enum([
  "first-party",
  "openrouter",
  "fireworks",
  "together",
  "gateway",
  "venice-hosted",
  "western-anonymized",
  "china-anonymized",
]);
const routingByProvider: Readonly<Record<string, readonly z.infer<typeof routingClassSchema>[]>> = {
  typesafe: ["first-party"],
  elevenlabs: ["first-party"],
  anthropic: ["first-party"],
  openai: ["first-party"],
  google: ["first-party"],
  xai: ["first-party"],
  fireworks: ["fireworks"],
  together: ["together"],
  openrouter: ["openrouter"],
  gateway: ["gateway"],
  venice: ["venice-hosted", "western-anonymized", "china-anonymized"],
};
const intelligenceTierSchema = z.enum(["frontier", "strong", "mid", "small"]);
const taskPreferenceSchema = z.enum(["security_research"]);
const inputModalitySchema = z.enum(["text", "image", "file"]);
/** v1/v2 never accepted media output; preserve that strict legacy boundary. */
const legacyOutputModalitySchema = z.enum(["text", "image", "embedding"]);
/** Audio/video output is admitted only by the v3 workload-isolated schema. */
const mediaOutputModalitySchema = z.enum(["text", "image", "audio", "video", "embedding"]);
const capabilityProvenanceSchema = z.enum(["override", "openrouter", "smoke", "default"]);

function createModalitiesSchema<Output extends z.ZodTypeAny>(outputSchema: Output) {
  return z
    .object({
      input: z.array(inputModalitySchema).min(1).max(3),
      output: z.array(outputSchema).min(1).max(2),
    })
    .strict()
    .superRefine((modalities, ctx) => {
      for (const field of ["input", "output"] as const) {
        const values = modalities[field] as readonly unknown[];
        if (new Set(values).size !== values.length) {
          ctx.addIssue({
            code: "custom",
            message: `${field} modalities must be unique`,
            path: [field],
          });
        }
      }
    });
}

const modalitiesSchema = createModalitiesSchema(legacyOutputModalitySchema);
const mediaModalitiesSchema = createModalitiesSchema(mediaOutputModalitySchema);

const featuresSchema = z
  .object({
    tools: z.boolean().nullable(),
    structuredOutputs: z.boolean().nullable(),
    reasoning: z.boolean().nullable(),
    /** Screenshot-to-target coordinate grounding support; absence is unknown. */
    visualGrounding: z.boolean().nullable().optional(),
  })
  .strict();

const limitsSchema = z
  .object({
    contextTokens: z.number().int().min(1).max(100_000_000),
    outputTokens: z.number().int().min(1).max(100_000_000),
  })
  .strict()
  .refine((value) => value.outputTokens <= value.contextTokens, "outputTokens must be <= contextTokens");

const costSchema = z.object({ coefficient: costCoefficient }).strict();
/** v1/v2 privacy shape remains exactly `{ grade }`. */
const privacySchema = z.object({ grade: privacyGrade }).strict();
/** v3 optionally adds an explicit provider/catalog handling label. */
const mediaPrivacySchema = z
  .object({
    grade: privacyGrade,
    /** Human-visible handling label where the provider has made one explicit. */
    label: z.enum(["standard", "anonymized", "e2ee"]).optional(),
  })
  .strict();
const intelligenceSchema = z.object({ tier: intelligenceTierSchema }).strict();

const modelWorkloadSchema = z.enum(["chat", "generation"]);
const speechWorkloadSchema = z.enum(["chat", "generation", "decision", "speech"]);
const speechSchema = z.object({
  transport: z.enum(["elevenlabs-tts-http", "elevenlabs-dialogue-http"]),
  outputFormats: z.array(z.enum(["pcm_24000", "mp3_44100_128"])).nonempty(),
  maxInputCharacters: z.number().int().positive(),
  usdPerThousandCharacters: z.string().regex(/^\d+(?:\.\d{1,8})?$/),
}).strict();
const decisionWorkloadSchema = z.enum(["chat", "generation", "decision"]);
const decisionSchema = z.object({
  operations: z.tuple([z.literal("choice")]),
  /** Provider bound for shared state plus one question, not chat output. */
  inputTokens: z.number().positive().refine(Number.isInteger),
  /** Provider-advertised maximum; consumers must not silently truncate. */
  maxChoices: z.number().positive().refine(Number.isInteger),
}).strict();
export const DECISION_OPERATIONS = ["choice", "noul", "score"] as const;
export const DecisionOperationSchema = z.enum(DECISION_OPERATIONS);
const generationFamilySchema = z.enum(["image", "video", "music"]);
/**
 * Transport-level reference kinds, deliberately not creative labels. Creative
 * labels belong to a later Generation Brief; this catalog only says what a
 * provider model is currently known to accept.
 */
const generationReferenceRoleSchema = z.enum(["image", "video", "audio"]);
const generationReferenceConstraintsSchema = z
  .object({
    maxCount: z.number().int().min(1).max(100).optional(),
    maxBytes: z.number().int().min(1).max(10_000_000_000).optional(),
    maxDurationSeconds: z.number().int().min(1).max(86_400).optional(),
    allowedMimeTypes: z.array(z.string().trim().min(1).max(120)).min(1).max(32).optional(),
  })
  .strict();
const generationReferencesSchema = z
  .object({
    roles: z.array(generationReferenceRoleSchema).min(1).max(3),
    constraints: generationReferenceConstraintsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.roles).size !== value.roles.length) {
      ctx.addIssue({ code: "custom", message: "reference roles must be unique", path: ["roles"] });
    }
  });
const generationConstraintsSchema = z
  .object({
    promptCharacters: z.object({ min: z.number().int().min(0), max: z.number().int().min(1) }).strict().optional(),
    durationSeconds: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).strict().optional(),
    resolutions: z.array(z.string().trim().min(1).max(32)).min(1).max(16).optional(),
    aspectRatios: z.array(z.string().trim().min(1).max(16)).min(1).max(16).optional(),
    audio: z.enum(["configurable", "provider-managed", "instrumental", "lyrics-or-instrumental"]).optional(),
    lyricsCharacters: z.object({ min: z.number().int().min(0), max: z.number().int().min(1) }).strict().optional(),
    outputMimeTypes: z.array(z.string().trim().min(1).max(120)).min(1).max(8).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const field of ["promptCharacters", "durationSeconds", "lyricsCharacters"] as const) {
      const range = value[field];
      if (range && range.max < range.min) {
        ctx.addIssue({ code: "custom", message: `${field}.max must be >= min`, path: [field, "max"] });
      }
    }
  });
const generationSchema = z
  .object({
    family: generationFamilySchema,
    /** Omitted means unknown, never "no references". */
    references: generationReferencesSchema.optional(),
    /** Bounded dated fallback facts; a live cache may only refine compatible facts. */
    constraints: generationConstraintsSchema.optional(),
  })
  .strict();

/** Provider-neutral selectable reasoning depths. `off` is represented by
 * `canDisable`, never as a provider effort level. */
export const REASONING_LEVEL_VALUES = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const reasoningLevelSchema = z.enum(REASONING_LEVEL_VALUES);

const controlProvenanceSchema = z
  .object({
    kind: z.enum([
      "provider-catalog",
      "provider-documentation",
      "reviewed-override",
      "live-compatibility",
    ]),
    provider: providerSlug,
    verifiedAt: catalogPublishedAt,
  })
  .strict();

const reasoningControlSchema = z
  .object({
    levels: z.array(reasoningLevelSchema).min(1).max(REASONING_LEVEL_VALUES.length),
    defaultLevel: z.union([reasoningLevelSchema, z.literal("off")]),
    canDisable: z.boolean(),
    mandatory: z.boolean(),
    provenance: controlProvenanceSchema,
  })
  .strict()
  .superRefine((control, ctx) => {
    if (new Set(control.levels).size !== control.levels.length) {
      ctx.addIssue({ code: "custom", message: "reasoning levels must be unique", path: ["levels"] });
    }
    if (control.defaultLevel === "off") {
      if (!control.canDisable) {
        ctx.addIssue({
          code: "custom",
          message: 'reasoning defaultLevel "off" requires canDisable=true',
          path: ["defaultLevel"],
        });
      }
    } else if (!control.levels.includes(control.defaultLevel)) {
      ctx.addIssue({
        code: "custom",
        message: "reasoning defaultLevel must be one of levels",
        path: ["defaultLevel"],
      });
    }
    if (control.mandatory && control.canDisable) {
      ctx.addIssue({
        code: "custom",
        message: "mandatory reasoning cannot be disabled",
        path: ["canDisable"],
      });
    }
  });

const servingProfileIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, "must be a safe lowercase serving profile id");
const servingIntentSchema = z.enum(["balanced", "reliability", "throughput"]);
const rateCardSchema = z
  .object({
    inputPerMtok: z.number().finite().nonnegative(),
    cachedInputPerMtok: z.number().finite().nonnegative(),
    outputPerMtok: z.number().finite().nonnegative(),
    provenance: controlProvenanceSchema,
  })
  .strict();

/**
 * This deliberately closed selector union is resolved only on the server.
 * Adding a new request parameter or selector shape is a reviewed contract
 * change, not catalog data supplied by a browser or provider feed.
 */
const servingSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z
    .object({
      kind: z.literal("request-parameter"),
      parameter: z.literal("service_tier"),
      value: z.literal("priority"),
    })
    .strict(),
  z.object({ kind: z.literal("model-override"), modelId }).strict(),
]);

const servingProfileSchema = z
  .object({
    id: servingProfileIdSchema,
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(280).optional(),
    intent: servingIntentSchema,
    selector: servingSelectorSchema,
    /** Omitted only where the provider has not published a rate card. */
    pricing: rateCardSchema.optional(),
  })
  .strict();

const servingControlSchema = z
  .object({
    defaultProfile: servingProfileIdSchema,
    profiles: z.array(servingProfileSchema).min(1).max(16),
    provenance: controlProvenanceSchema,
  })
  .strict()
  .superRefine((control, ctx) => {
    const ids = new Set<string>();
    for (const [index, profile] of control.profiles.entries()) {
      if (ids.has(profile.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate serving profile id "${profile.id}"`,
          path: ["profiles", index, "id"],
        });
      }
      ids.add(profile.id);
    }
    if (!ids.has(control.defaultProfile)) {
      ctx.addIssue({
        code: "custom",
        message: "serving defaultProfile must reference a declared profile",
        path: ["defaultProfile"],
      });
    }
  });

const modelControlsSchema = z
  .object({
    reasoning: reasoningControlSchema.optional(),
    serving: servingControlSchema.optional(),
  })
  .strict()
  .refine((controls) => controls.reasoning !== undefined || controls.serving !== undefined, {
    message: "controls must declare reasoning or serving",
  });

const modelCatalogEntryBaseSchema = z
  .object({
    id: modelId,
    displayName,
    provider: providerSlug,
    routing: routingClassSchema,
    priority,
    defaultEnabled: z.boolean(),
    modalities: modalitiesSchema.optional(),
    features: featuresSchema.optional(),
    capabilityProvenance: capabilityProvenanceSchema.optional(),
    limits: limitsSchema,
    cost: costSchema,
    privacy: privacySchema,
    intelligence: intelligenceSchema,
  })
  .strict();

function addModelCatalogEntrySemantics<Schema extends z.ZodTypeAny>(schema: Schema): Schema {
  return schema.superRefine((value, ctx) => {
    const entry = value as {
      id: string;
      provider: string;
      routing: z.infer<typeof routingClassSchema>;
      features?: z.infer<typeof featuresSchema>;
      controls?: z.infer<typeof modelControlsSchema>;
    };
    if (entry.id.split(":")[0] !== entry.provider) {
      ctx.addIssue({
        code: "custom",
        message: "model id provider prefix must match the entry provider",
        path: ["id"],
      });
    }
    const allowed = routingByProvider[entry.provider];
    if (!allowed) {
      ctx.addIssue({
        code: "custom",
        message: `provider "${entry.provider}" is not recognized`,
        path: ["provider"],
      });
    } else if (!allowed.includes(entry.routing)) {
      ctx.addIssue({
        code: "custom",
        message: `routing "${entry.routing}" is not valid for provider "${entry.provider}"`,
        path: ["routing"],
      });
    }
    if (entry.controls?.reasoning) {
      if (entry.features?.reasoning !== true) {
        ctx.addIssue({
          code: "custom",
          message: "reasoning controls require features.reasoning=true",
          path: ["controls", "reasoning"],
        });
      }
      if (entry.controls.reasoning.provenance.provider !== entry.provider) {
        ctx.addIssue({
          code: "custom",
          message: "reasoning provenance provider must match the entry provider",
          path: ["controls", "reasoning", "provenance", "provider"],
        });
      }
    }
    if (entry.controls?.serving) {
      if (entry.controls.serving.provenance.provider !== entry.provider) {
        ctx.addIssue({
          code: "custom",
          message: "serving provenance provider must match the entry provider",
          path: ["controls", "serving", "provenance", "provider"],
        });
      }
      for (const [index, profile] of entry.controls.serving.profiles.entries()) {
        if (
          profile.selector.kind === "model-override" &&
          profile.selector.modelId.split(":")[0] !== entry.provider
        ) {
          ctx.addIssue({
            code: "custom",
            message: "serving model override must remain within the entry provider",
            path: ["controls", "serving", "profiles", index, "selector", "modelId"],
          });
        }
        if (profile.pricing && profile.pricing.provenance.provider !== entry.provider) {
          ctx.addIssue({
            code: "custom",
            message: "serving pricing provenance provider must match the entry provider",
            path: ["controls", "serving", "profiles", index, "pricing", "provenance", "provider"],
          });
        }
      }
    }
  });
}

/** Strict legacy entry: controls are intentionally unknown in v1. */
const ModelCatalogV1EntrySchema = addModelCatalogEntrySemantics(modelCatalogEntryBaseSchema);

/** Strict v2 entry with the two reviewed, provider-neutral control axes. */
export const ModelCatalogEntrySchema = addModelCatalogEntrySemantics(
  modelCatalogEntryBaseSchema.extend({ controls: modelControlsSchema.optional() }).strict(),
);

/**
 * Strict v3 entry. Chat workloads require exact per-model token limits.
 * Generation workloads omit them because media output is not a chat
 * completion and the catalog must not manufacture token semantics for it.
 */
const ModelCatalogV3EntrySchema = addModelCatalogEntrySemantics(
  modelCatalogEntryBaseSchema
    .partial({ intelligence: true, limits: true })
    .extend({
      modalities: mediaModalitiesSchema.optional(),
      privacy: mediaPrivacySchema,
      controls: modelControlsSchema.optional(),
      /** Reviewed, provider-neutral Task workloads for which this exact row is preferred. */
      taskPreferences: z.tuple([taskPreferenceSchema]).optional(),
      /** Omitted only for compatibility; resolvers treat it as `chat`. */
      workload: modelWorkloadSchema.optional(),
      generation: generationSchema.optional(),
    })
    .strict(),
).superRefine((entry, ctx) => {
  const workload = entry.workload ?? "chat";
  if (workload === "generation") {
    if (!entry.generation) {
      ctx.addIssue({
        code: "custom",
        message: "generation workload requires generation metadata",
        path: ["generation"],
      });
    }
    if (entry.limits !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "generation workload must not declare chat token limits",
        path: ["limits"],
      });
    }
    if (!entry.modalities || entry.modalities.output.includes("text")) {
      ctx.addIssue({
        code: "custom",
        message: "generation workload must declare non-text output modalities",
        path: ["modalities", "output"],
      });
    }
  } else {
    if (entry.limits === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "chat workload requires model-specific token limits",
        path: ["limits"],
      });
    }
    if (entry.generation !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "chat workload cannot declare generation metadata",
        path: ["generation"],
      });
    }
    if (entry.modalities && !entry.modalities.output.includes("text")) {
      ctx.addIssue({
        code: "custom",
        message: "chat workload must declare text output",
        path: ["modalities", "output"],
      });
    }
  }
});

/** Keep the legacy validator intact; v4 adds only the closed decision branch. */
const ModelCatalogV4EntrySchema = addModelCatalogEntrySemantics(
  modelCatalogEntryBaseSchema
    .partial({ intelligence: true, limits: true })
    .extend({
      modalities: mediaModalitiesSchema.optional(),
      privacy: mediaPrivacySchema,
      controls: modelControlsSchema.optional(),
      taskPreferences: z.tuple([taskPreferenceSchema]).optional(),
      workload: decisionWorkloadSchema.optional(),
      generation: generationSchema.optional(),
      decision: decisionSchema.optional(),
    })
    .strict(),
).superRefine((entry, ctx) => {
  if (entry.workload !== "decision") {
    const { decision, ...legacy } = entry;
    if (decision !== undefined) {
      ctx.addIssue({ code: "custom", message: "only decision workloads may declare decision metadata", path: ["decision"] });
    }
    const parsed = ModelCatalogV3EntrySchema.safeParse(legacy);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
      }
    }
    return;
  }
  if (!entry.decision) {
    ctx.addIssue({ code: "custom", message: "decision workload requires decision metadata", path: ["decision"] });
  }
  if (entry.capabilityProvenance === undefined) {
    ctx.addIssue({ code: "custom", message: "decision workload requires capability provenance", path: ["capabilityProvenance"] });
  }
  if (entry.modalities?.input.length !== 1 || entry.modalities.input[0] !== "text"
    || entry.modalities.output.length !== 1 || entry.modalities.output[0] !== "text") {
    ctx.addIssue({ code: "custom", message: "decision workload requires exact text input and text output", path: ["modalities"] });
  }
  for (const field of ["features", "limits", "intelligence", "controls", "generation", "taskPreferences"] as const) {
    if (entry[field] !== undefined) {
      ctx.addIssue({ code: "custom", message: `decision workload must not declare ${field}`, path: [field] });
    }
  }
});

/** Speech is isolated from chat, generation and decision routing. */
const ModelCatalogV5EntrySchema = addModelCatalogEntrySemantics(
  modelCatalogEntryBaseSchema.partial({ intelligence: true, limits: true }).extend({
    modalities: mediaModalitiesSchema.optional(), privacy: mediaPrivacySchema,
    controls: modelControlsSchema.optional(), taskPreferences: z.tuple([taskPreferenceSchema]).optional(),
    workload: speechWorkloadSchema.optional(), generation: generationSchema.optional(),
    decision: decisionSchema.optional(), speech: speechSchema.optional(),
  }).strict(),
).superRefine((entry, ctx) => {
  if (entry.workload !== "speech") {
    const { speech, ...legacy } = entry;
    if (speech !== undefined) ctx.addIssue({ code: "custom", message: "only speech workloads may declare speech metadata", path: ["speech"] });
    const parsed = ModelCatalogV4EntrySchema.safeParse(legacy);
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    return;
  }
  if (!entry.speech) ctx.addIssue({ code: "custom", message: "speech metadata is required", path: ["speech"] });
  if (entry.provider !== "elevenlabs") ctx.addIssue({ code: "custom", message: "speech transport requires ElevenLabs", path: ["provider"] });
  if (!entry.capabilityProvenance) ctx.addIssue({ code: "custom", message: "speech provenance is required", path: ["capabilityProvenance"] });
  if (entry.modalities?.input.length !== 1 || entry.modalities.input[0] !== "text" || entry.modalities.output.length !== 1 || entry.modalities.output[0] !== "audio")
    ctx.addIssue({ code: "custom", message: "speech requires text input and audio output", path: ["modalities"] });
  for (const field of ["features", "limits", "intelligence", "controls", "generation", "decision", "taskPreferences"] as const)
    if (entry[field] !== undefined) ctx.addIssue({ code: "custom", message: `speech must not declare ${field}`, path: [field] });
});

const typedDecisionSchema = decisionSchema.extend({
  pricing: rateCardSchema.optional(),
  operations: z.array(DecisionOperationSchema).nonempty().refine((ops) => new Set(ops).size === ops.length, "operations must be unique"),
  /** Aggregate state plus all questions; distinct from the longest-question bound. */
  totalInputTokens: z.number().int().positive().optional(),
  supportsMultipleQuestions: z.boolean().optional(),
  maxScoreLevels: z.number().int().min(2).optional(),
}).superRefine((decision, ctx) => {
  if (decision.operations.includes("score") && decision.maxScoreLevels === undefined)
    ctx.addIssue({ code: "custom", path: ["maxScoreLevels"], message: "score requires a reviewed level bound" });
  if (decision.supportsMultipleQuestions && decision.totalInputTokens === undefined)
    ctx.addIssue({ code: "custom", path: ["totalInputTokens"], message: "multiple questions require an aggregate token bound" });
  if (decision.totalInputTokens !== undefined && decision.totalInputTokens < decision.inputTokens)
    ctx.addIssue({ code: "custom", path: ["totalInputTokens"], message: "aggregate budget must cover the longest-question budget" });
});

/** Typed operations evolve independently of modalities; adapters gate executable inputs. */
const ModelCatalogV6EntrySchema = addModelCatalogEntrySemantics(
  modelCatalogEntryBaseSchema.partial({ intelligence: true, limits: true }).extend({
    modalities: mediaModalitiesSchema.optional(), privacy: mediaPrivacySchema,
    controls: modelControlsSchema.optional(), taskPreferences: z.tuple([taskPreferenceSchema]).optional(),
    workload: speechWorkloadSchema.optional(), generation: generationSchema.optional(),
    decision: typedDecisionSchema.optional(), speech: speechSchema.optional(),
  }).strict(),
).superRefine((entry, ctx) => {
  // Validate all inherited workload rules with their original closed contracts.
  // For decisions only, project the new operations/modalities onto the old shape.
  const legacy = entry.workload === "decision" && entry.decision
    ? { ...entry, modalities: { input: ["text"], output: entry.modalities?.output ?? [] },
        decision: { operations: ["choice"], inputTokens: entry.decision.inputTokens, maxChoices: entry.decision.maxChoices } }
    : entry;
  const parsed = ModelCatalogV5EntrySchema.safeParse(legacy);
  if (!parsed.success) for (const issue of parsed.error.issues)
    ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  if (entry.workload === "decision" && !entry.modalities)
    ctx.addIssue({ code: "custom", message: "decision input modalities are required", path: ["modalities"] });
  if (entry.provider === "typesafe" && entry.workload !== "decision")
    ctx.addIssue({ code: "custom", message: "TypeSafe supports decision workloads only", path: ["workload"] });
});

function addCatalogEntryUniqueness<Schema extends z.ZodTypeAny>(schema: Schema): Schema {
  return schema.superRefine((value, ctx) => {
    const catalog = value as { entries: { id: string }[] };
    const ids = new Set<string>();
    for (const [index, entry] of catalog.entries.entries()) {
      if (ids.has(entry.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate model id "${entry.id}"`,
          path: ["entries", index, "id"],
        });
      }
      ids.add(entry.id);
    }
  });
}

/** Model-only release contract retained as a strict last-known-good reader. */
export const ModelCatalogV1Schema = addCatalogEntryUniqueness(z
  .object({
    version: z.literal(MODEL_CATALOG_VERSION),
    catalogVersion: catalogReleaseVersion,
    publishedAt: catalogPublishedAt,
    entries: z.array(ModelCatalogV1EntrySchema).max(MODEL_CATALOG_MAX_ENTRIES),
  })
  .strict());

/** Reader-first v2 contract. Controls remain optional for model-only rows. */
export const ModelCatalogV2Schema = addCatalogEntryUniqueness(z
  .object({
    version: z.literal(MODEL_CATALOG_CONTROLS_VERSION),
    catalogVersion: catalogReleaseVersion,
    publishedAt: catalogPublishedAt,
    entries: z.array(ModelCatalogEntrySchema).max(MODEL_CATALOG_MAX_ENTRIES),
  })
  .strict());

/** Reader-first v3 contract for workload-isolated media generation rows. */
export const ModelCatalogV3Schema = addCatalogEntryUniqueness(z
  .object({
    version: z.literal(MODEL_CATALOG_MEDIA_VERSION),
    catalogVersion: catalogReleaseVersion,
    publishedAt: catalogPublishedAt,
    entries: z.array(ModelCatalogV3EntrySchema).max(MODEL_CATALOG_MAX_ENTRIES),
  })
  .strict());

/** Reader-first v4 contract for workload-isolated typed decisions. */
export const ModelCatalogV4Schema = addCatalogEntryUniqueness(z
  .object({
    version: z.literal(MODEL_CATALOG_DECISION_VERSION),
    catalogVersion: catalogReleaseVersion,
    publishedAt: catalogPublishedAt,
    // Preserve complete validated v4 catalogues. Legacy readers retain their
    // historical count ceiling; v4 does not inherit that ungrounded boundary.
    entries: z.array(ModelCatalogV4EntrySchema),
  })
  .strict());

export const ModelCatalogV5Schema = addCatalogEntryUniqueness(z.object({
  version: z.literal(MODEL_CATALOG_SPEECH_VERSION), catalogVersion: catalogReleaseVersion,
  publishedAt: catalogPublishedAt, entries: z.array(ModelCatalogV5EntrySchema),
}).strict());

export const ModelCatalogV6Schema = addCatalogEntryUniqueness(z.object({
  version: z.literal(MODEL_CATALOG_TYPED_DECISION_VERSION), catalogVersion: catalogReleaseVersion,
  publishedAt: catalogPublishedAt, entries: z.array(ModelCatalogV6EntrySchema),
}).strict());

/** Strictly accepts every reviewed manifest version without widening legacy readers. */
export const ModelCatalogSchema = z.discriminatedUnion("version", [
  ModelCatalogV1Schema,
  ModelCatalogV2Schema,
  ModelCatalogV3Schema,
  ModelCatalogV4Schema,
  ModelCatalogV5Schema,
  ModelCatalogV6Schema,
]);

/** 64 lowercase hex characters. */
export const ARTIFACT_SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** 1-64 safe lowercase characters (mirrors publish-model-catalog.mjs KEY_ID). */
export const SIGNING_KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Strict signed release-pointer schema. Exactly the four fields CI publishes:
 * `catalogVersion`, `artifactSha256` (lowercase hex), `signature` (base64, 64
 * bytes once decoded), `signingKeyId`. No path, URL, headers, token, or manifest
 * reference is ever read from the pointer body — the immutable manifest URL is
 * always derived from the pointer URL's own directory plus the validated
 * `catalogVersion`.
 */
export const ModelCatalogReleasePointerSchema = z
  .object({
    catalogVersion: catalogReleaseVersion,
    artifactSha256: z.string().regex(ARTIFACT_SHA256_PATTERN, "must be lowercase SHA-256 hex"),
    signature: z.string().base64(),
    signingKeyId: z.string().regex(SIGNING_KEY_ID_PATTERN, "must be 1-64 safe lowercase characters"),
  })
  .strict()
  // 64 bytes encode as exactly 86 base64 data characters plus `==`.
  // Keep this package browser-safe: do not depend on Node's Buffer merely to
  // check decoded length.
  .refine(
    (pointer) => /^[A-Za-z0-9+/]{86}==$/.test(pointer.signature),
    "signature must decode to 64 bytes",
  );

/**
 * Build the exact canonical signing payload the loader verifies. This MUST stay
 * byte-identical to `canonicalSigningPayload` in
 * `nautilo-catalogs/scripts/publish-model-catalog.mjs`:
 *
 * nautilo-model-catalog-v1\ncatalogVersion=<v>\nartifactSha256=<hex>\n
 */
export function canonicalModelCatalogSigningPayload(
  catalogVersion: string,
  artifactSha256: string,
): string {
  return (
    "nautilo-model-catalog-v1\n" +
    `catalogVersion=${catalogVersion}\n` +
    `artifactSha256=${artifactSha256}\n`
  );
}

/**
 * Filename pattern for the derived immutable manifest inside the pointer's own
 * `models/` directory. The version is regex-bound to `YYYY.MM.DD.N` so it can
 * carry no path, traversal, query, or fragment.
 */
export function immutableModelCatalogFilename(catalogVersion: string): string {
  return `catalog-${catalogVersion}.json`;
}

export type ModelCatalogRoutingClass = z.infer<typeof routingClassSchema>;
export type ModelCatalogIntelligenceTier = z.infer<typeof intelligenceTierSchema>;
export type ModelCatalogTaskPreference = z.infer<typeof taskPreferenceSchema>;
export type ModelCatalogInputModality = z.infer<typeof inputModalitySchema>;
export type ModelCatalogOutputModality = z.infer<typeof mediaOutputModalitySchema>;
export type ModelCatalogWorkload = z.infer<typeof speechWorkloadSchema>;
export type ModelCatalogSpeech = z.infer<typeof speechSchema>;
export type ModelCatalogDecision = z.infer<typeof typedDecisionSchema>;
export type DecisionOperation = z.infer<typeof DecisionOperationSchema>;
export type ModelCatalogGenerationFamily = z.infer<typeof generationFamilySchema>;
export type ModelCatalogGenerationReferenceRole = z.infer<typeof generationReferenceRoleSchema>;
export type ModelCatalogGenerationReferenceConstraints = z.infer<typeof generationReferenceConstraintsSchema>;
export type ModelCatalogGenerationReferences = z.infer<typeof generationReferencesSchema>;
export type ModelCatalogGenerationConstraints = z.infer<typeof generationConstraintsSchema>;
export type ModelCatalogGeneration = z.infer<typeof generationSchema>;
export type ModelCatalogCapabilityProvenance = z.infer<typeof capabilityProvenanceSchema>;
/** A catalog-advertised provider-neutral reasoning depth; `off` is separate. */
export type ModelCatalogReasoningLevel = z.infer<typeof reasoningLevelSchema>;
/** A persisted/requested reasoning choice, including explicit disablement. */
export type ModelCatalogReasoningEffort = ModelCatalogReasoningLevel | "off";
export type ModelCatalogControlProvenance = z.infer<typeof controlProvenanceSchema>;
export type ModelCatalogReasoningControl = z.infer<typeof reasoningControlSchema>;
export type ModelCatalogServingProfileId = z.infer<typeof servingProfileIdSchema>;
export type ModelCatalogServingIntent = z.infer<typeof servingIntentSchema>;
export type ModelCatalogServingSelector = z.infer<typeof servingSelectorSchema>;
export type ModelCatalogServingRateCard = z.infer<typeof rateCardSchema>;
export type ModelCatalogServingProfile = z.infer<typeof servingProfileSchema>;
export type ModelCatalogServingControl = z.infer<typeof servingControlSchema>;
export type ModelCatalogControls = z.infer<typeof modelControlsSchema>;
/**
 * Provider-neutral selection bundle. Provider selectors never cross this
 * boundary; callers submit only signed catalog choice identifiers.
 */
export interface ModelControlSelection {
  readonly modelId: string;
  readonly reasoningEffort?: ModelCatalogReasoningEffort;
  readonly servingProfileId?: ModelCatalogServingProfileId;
}
/**
 * The latest entry shape deliberately remains structurally compatible with
 * legacy entries: workload-specific fields are optional and legacy rows are chat rows.
 */
export type ModelCatalogEntry = z.infer<typeof ModelCatalogV6EntrySchema>;
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;
export type ModelCatalogReleasePointer = z.infer<typeof ModelCatalogReleasePointerSchema>;

/**
 * Safe, narrowly typed provenance exposed to discovery callers. This is the
 * only catalog-origin information ever surfaced: the raw pointer/manifest URL,
 * host, headers, signing keys, and provider credentials are never represented
 * here. `catalogVersion` and `source`/`stale` give operators a non-secret
 * diagnostic without leaking delivery internals.
 */
export const MODEL_CATALOG_RESULT_SOURCE_VALUES = [
  "remote-fresh",
  "remote-stale",
  "checked-in-fallback",
] as const;
export type ModelCatalogResultSource = (typeof MODEL_CATALOG_RESULT_SOURCE_VALUES)[number];
