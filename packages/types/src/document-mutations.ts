import { z } from "zod";
import { anchoredTextPatchSchema } from "./document-patches";

/**
 * D448 Phase 7.1 — trusted, browser-safe document mutation contracts.
 *
 * These schemas validate authority-derived coordinator data. They are not
 * model-facing tool input and must never be populated from a model-authored
 * target selector.
 */

const nonEmptyIdSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "identifier must not be empty",
});
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: "SHA-256 must be 64 lowercase hexadecimal characters",
});
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();

function isSafeLogicalPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isCanonicalAbsolutePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0")) return false;

  if (value.startsWith("/")) {
    if (value === "/" || value.endsWith("/") || value.includes("\\")) return false;
    return value.slice(1).split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
  }

  if (!/^[A-Za-z]:[\\/]/.test(value)) return false;
  const separator = value[2]!;
  if (value.length === 3 || value.endsWith(separator)) return false;
  const otherSeparator = separator === "/" ? "\\" : "/";
  if (value.includes(otherSeparator)) return false;
  return value.slice(3).split(separator).every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * A client-supplied local-file candidate is deliberately less constrained
 * than a canonical path. The transport uses it only to ask the trusted relay
 * to resolve a target; it is never an authority-bearing identity.
 */
function isAbsoluteCandidatePath(value: string): boolean {
  if (value.trim().length === 0 || value.includes("\0")) return false;
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export const logicalDocumentPathSchema = z.string().refine(isSafeLogicalPath, {
  message: "logical path must be a normalized relative POSIX path",
});

export const canonicalDocumentPathSchema = z.string().refine(isCanonicalAbsolutePath, {
  message: "canonical path must be a normalized non-root absolute path",
});

const localCandidatePathSchema = z.string().refine(isAbsoluteCandidatePath, {
  message: "candidate path must be a nonempty absolute path",
});

/**
 * Untrusted browser transport selector for a human-edit lease. This is a
 * candidate only: the server or relay must authorize and resolve it to a
 * canonical DocumentIdentity and DocumentVersion before touching the lease
 * registry or mutation coordinator.
 */
export const humanEditLeaseCandidateTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("workspace_artifact"),
      artifactInternalId: z.string().uuid(),
      logicalPath: logicalDocumentPathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("local_file"),
      relayId: nonEmptyIdSchema,
      candidatePath: localCandidatePathSchema,
    })
    .strict(),
]);
export type HumanEditLeaseCandidateTarget = z.infer<
  typeof humanEditLeaseCandidateTargetSchema
>;

export const workspaceDocumentIdentitySchema = z
  .object({
    kind: z.literal("workspace_artifact"),
    /** Internal artifacts.id UUID, never the external agent-facing artifact id. */
    artifactId: z.string().uuid(),
    logicalPath: logicalDocumentPathSchema,
  })
  .strict();
export type WorkspaceDocumentIdentity = z.infer<typeof workspaceDocumentIdentitySchema>;

export const localDocumentIdentitySchema = z
  .object({
    kind: z.literal("local_file"),
    relayId: nonEmptyIdSchema,
    canonicalPath: canonicalDocumentPathSchema,
  })
  .strict();
export type LocalDocumentIdentity = z.infer<typeof localDocumentIdentitySchema>;

export const documentIdentitySchema = z.discriminatedUnion("kind", [
  workspaceDocumentIdentitySchema,
  localDocumentIdentitySchema,
]);
export type DocumentIdentity = z.infer<typeof documentIdentitySchema>;

function documentIdentityEquals(a: DocumentIdentity, b: DocumentIdentity): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "workspace_artifact") {
    return (
      b.kind === "workspace_artifact" &&
      a.artifactId === b.artifactId &&
      a.logicalPath === b.logicalPath
    );
  }
  return b.kind === "local_file" && a.relayId === b.relayId && a.canonicalPath === b.canonicalPath;
}

function isSameBackendOwner(a: DocumentIdentity, b: DocumentIdentity): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "workspace_artifact"
    ? b.kind === "workspace_artifact" && a.artifactId === b.artifactId
    : b.kind === "local_file" && a.relayId === b.relayId;
}

function isValidOverwriteDestination(
  source: DocumentIdentity,
  destination: DocumentIdentity,
  after: DocumentIdentity,
): boolean {
  if (
    source.kind === "workspace_artifact" &&
    destination.kind === "workspace_artifact" &&
    after.kind === "workspace_artifact"
  ) {
    return (
      destination.logicalPath === after.logicalPath &&
      destination.artifactId !== source.artifactId
    );
  }
  if (
    source.kind === "local_file" &&
    destination.kind === "local_file" &&
    after.kind === "local_file"
  ) {
    return (
      destination.relayId === after.relayId &&
      destination.canonicalPath === after.canonicalPath
    );
  }
  return false;
}

export const workspaceDocumentVersionSchema = z
  .object({
    identity: workspaceDocumentIdentitySchema,
    backendVersion: z
      .object({
        kind: z.literal("artifact_revision"),
        revision: nonNegativeSafeIntegerSchema,
      })
      .strict(),
    sha256: sha256Schema,
  })
  .strict();
export type WorkspaceDocumentVersion = z.infer<typeof workspaceDocumentVersionSchema>;

export const localDocumentVersionSchema = z
  .object({
    identity: localDocumentIdentitySchema,
    backendVersion: z
      .object({
        kind: z.literal("local_sha"),
        sha256: sha256Schema,
      })
      .strict(),
    sha256: sha256Schema,
  })
  .strict()
  .superRefine((version, ctx) => {
    if (version.backendVersion.sha256 !== version.sha256) {
      ctx.addIssue({
        code: "custom",
        path: ["backendVersion", "sha256"],
        message: "local backend version SHA must equal the exact document SHA",
      });
    }
  });
export type LocalDocumentVersion = z.infer<typeof localDocumentVersionSchema>;

/** Distinct from the narrower M216 LiveDocumentVersion wire contract. */
export const documentVersionSchema = z.union([
  workspaceDocumentVersionSchema,
  localDocumentVersionSchema,
]);
export type DocumentVersion = z.infer<typeof documentVersionSchema>;

export const documentMutationActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), humanId: nonEmptyIdSchema }).strict(),
  z.object({ kind: z.literal("agent"), agentId: nonEmptyIdSchema }).strict(),
]);
export type DocumentMutationActor = z.infer<typeof documentMutationActorSchema>;

/**
 * Trusted correlation and compatibility intent for the Workbench editor-save
 * lane. This is deliberately closed: it carries no target, Namespace, relay,
 * root, grant, or other authority-bearing field.
 */
export const editorSaveMutationIntentSchema = z
  .object({
    kind: z.literal("editor_save"),
    checkpoint: z.boolean(),
    /** Exact version originally loaded by the editor before any server rebase. */
    baseVersion: documentVersionSchema,
    requestId: nonEmptyIdSchema.optional(),
    clientMutationId: nonEmptyIdSchema.optional(),
    anchoredPatch: anchoredTextPatchSchema.optional(),
  })
  .strict();
export type EditorSaveMutationIntent = z.infer<
  typeof editorSaveMutationIntentSchema
>;

export const documentExpectedSnapshotSchema = z
  .object({
    identity: documentIdentitySchema,
    expectedVersion: documentVersionSchema,
    bytes: z.instanceof(Uint8Array),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (!documentIdentityEquals(snapshot.identity, snapshot.expectedVersion.identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedVersion", "identity"],
        message: "snapshot identity must equal expected-version identity",
      });
    }
  });
export type DocumentExpectedSnapshot = z.infer<typeof documentExpectedSnapshotSchema>;

export const documentPostImageSchema = z
  .object({
    identity: documentIdentitySchema,
    sha256: sha256Schema,
    bytes: z.instanceof(Uint8Array),
  })
  .strict();
export type DocumentPostImage = z.infer<typeof documentPostImageSchema>;

const createCommitPlanEntrySchema = z
  .object({
    kind: z.literal("create"),
    after: documentPostImageSchema,
  })
  .strict();

const updateCommitPlanEntrySchema = z
  .object({
    kind: z.literal("update"),
    before: documentExpectedSnapshotSchema,
    after: documentPostImageSchema,
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (!documentIdentityEquals(entry.before.identity, entry.after.identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["after", "identity"],
        message: "update before and after identities must match",
      });
    }
  });

const moveCommitPlanEntrySchema = z
  .object({
    kind: z.literal("move"),
    source: documentExpectedSnapshotSchema,
    destinationBefore: documentExpectedSnapshotSchema.optional(),
    after: documentPostImageSchema,
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (!isSameBackendOwner(entry.source.identity, entry.after.identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["after", "identity"],
        message: "move must remain within the same artifact or relay",
      });
    } else if (documentIdentityEquals(entry.source.identity, entry.after.identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["after", "identity"],
        message: "move source and destination paths must differ",
      });
    }

    if (
      entry.destinationBefore !== undefined &&
      !isValidOverwriteDestination(
        entry.source.identity,
        entry.destinationBefore.identity,
        entry.after.identity,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["destinationBefore", "identity"],
        message: "overwrite destination must identify the replaced destination path",
      });
    }
  });

const deleteCommitPlanEntrySchema = z
  .object({
    kind: z.literal("delete"),
    before: documentExpectedSnapshotSchema,
  })
  .strict();

export const documentCommitPlanEntrySchema = z.union([
  createCommitPlanEntrySchema,
  updateCommitPlanEntrySchema,
  moveCommitPlanEntrySchema,
  deleteCommitPlanEntrySchema,
]);
export type DocumentCommitPlanEntry = z.infer<typeof documentCommitPlanEntrySchema>;

function claimedIdentitiesForEntry(
  entry: DocumentCommitPlanEntry,
): readonly DocumentIdentity[] {
  switch (entry.kind) {
    case "create":
      return [entry.after.identity];
    case "update":
      return [entry.before.identity];
    case "move":
      return [
        entry.source.identity,
        entry.after.identity,
        ...(entry.destinationBefore === undefined
          ? []
          : [entry.destinationBefore.identity]),
      ];
    case "delete":
      return [entry.before.identity];
  }
}

function documentIdentityKey(identity: DocumentIdentity): string {
  return identity.kind === "workspace_artifact"
    ? `workspace:${identity.artifactId}:${identity.logicalPath}`
    : `local:${identity.relayId}:${identity.canonicalPath}`;
}

function documentPathKey(identity: DocumentIdentity): string {
  return identity.kind === "workspace_artifact"
    ? `workspace:${identity.logicalPath}`
    : `local:${identity.relayId}:${identity.canonicalPath}`;
}

export const documentCommitPlanSchema = z
  .object({
    operationId: nonEmptyIdSchema,
    actor: documentMutationActorSchema,
    turnId: nonEmptyIdSchema.optional(),
    editorSave: editorSaveMutationIntentSchema.optional(),
    /**
     * Exact read-only compare-and-swap requirements. Preconditions are
     * deliberately not mutation entries: they acquire the same locks and are
     * checked at prepare/final commit, but never produce a revision or event.
     */
    preconditions: z.array(documentExpectedSnapshotSchema).readonly().optional(),
    /** Array order is the required mutation and committed-event order. */
    entries: z.array(documentCommitPlanEntrySchema).min(1).readonly(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.editorSave !== undefined) {
      if (plan.actor.kind !== "human") {
        ctx.addIssue({
          code: "custom",
          path: ["editorSave"],
          message: "editor-save intent requires a human mutation actor",
        });
      }
      if (plan.entries.length !== 1 || plan.entries[0]?.kind !== "update") {
        ctx.addIssue({
          code: "custom",
          path: ["editorSave"],
          message: "editor-save intent requires exactly one update entry",
        });
      } else if (
        !documentIdentityEquals(
          plan.editorSave.baseVersion.identity,
          plan.entries[0].before.identity,
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["editorSave", "baseVersion", "identity"],
          message: "editor-save base version must identify the update target",
        });
      }
    }
    const claimedIdentityIndexes = new Map<string, number>();
    const claimedPathIndexes = new Map<string, number>();
    const workspaceArtifactClaims = new Map<
      string,
      { entryIndex: number; logicalPaths: ReadonlySet<string> }
    >();
    let backend: DocumentIdentity["kind"] | undefined;
    let localRelayId: string | undefined;

    plan.entries.forEach((entry, entryIndex) => {
      const entryIdentityKeys = new Set<string>();
      const entryPathKeys = new Set<string>();
      const entryWorkspaceArtifactPaths = new Map<string, Set<string>>();
      const identities = claimedIdentitiesForEntry(entry);
      for (const identity of identities) {
        if (backend === undefined) {
          backend = identity.kind;
        } else if (identity.kind !== backend) {
          ctx.addIssue({
            code: "custom",
            path: ["entries", entryIndex],
            message: "one commit plan cannot mix Workspace and local identities",
          });
        }
        if (identity.kind === "local_file") {
          if (localRelayId === undefined) {
            localRelayId = identity.relayId;
          } else if (identity.relayId !== localRelayId) {
            ctx.addIssue({
              code: "custom",
              path: ["entries", entryIndex],
              message: "one local commit plan cannot mix relay identities",
            });
          }
        } else {
          const paths =
            entryWorkspaceArtifactPaths.get(identity.artifactId) ?? new Set<string>();
          paths.add(identity.logicalPath);
          entryWorkspaceArtifactPaths.set(identity.artifactId, paths);
        }
        entryIdentityKeys.add(documentIdentityKey(identity));
        entryPathKeys.add(documentPathKey(identity));
      }

      for (const [artifactId, logicalPaths] of entryWorkspaceArtifactPaths) {
        const prior = workspaceArtifactClaims.get(artifactId);
        if (prior !== undefined) {
          const claimsDifferentPath =
            logicalPaths.size !== prior.logicalPaths.size ||
            [...logicalPaths].some((logicalPath) => !prior.logicalPaths.has(logicalPath));
          if (claimsDifferentPath) {
            ctx.addIssue({
              code: "custom",
              path: ["entries", entryIndex],
              message: `Workspace artifact is already claimed at another path by entry ${prior.entryIndex}`,
            });
          }
        } else {
          workspaceArtifactClaims.set(artifactId, { entryIndex, logicalPaths });
        }
      }

      for (const key of entryIdentityKeys) {
        const priorIndex = claimedIdentityIndexes.get(key);
        if (priorIndex !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["entries", entryIndex],
            message: `document identity is already claimed by entry ${priorIndex}`,
          });
        } else {
          claimedIdentityIndexes.set(key, entryIndex);
        }
      }
      for (const key of entryPathKeys) {
        const priorIndex = claimedPathIndexes.get(key);
        if (priorIndex !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["entries", entryIndex],
            message: `document path is already claimed by entry ${priorIndex}`,
          });
        } else {
          claimedPathIndexes.set(key, entryIndex);
        }
      }
    });

    const preconditionIdentityIndexes = new Map<string, number>();
    const preconditionPathIndexes = new Map<string, number>();
    plan.preconditions?.forEach((precondition, preconditionIndex) => {
      const identity = precondition.identity;
      if (backend !== undefined && identity.kind !== backend) {
        ctx.addIssue({
          code: "custom",
          path: ["preconditions", preconditionIndex],
          message: "one commit plan cannot mix Workspace and local identities",
        });
      }
      if (
        identity.kind === "local_file" &&
        localRelayId !== undefined &&
        identity.relayId !== localRelayId
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["preconditions", preconditionIndex],
          message: "one local commit plan cannot mix relay identities",
        });
      }

      const identityKey = documentIdentityKey(identity);
      const pathKey = documentPathKey(identity);
      const priorPrecondition = preconditionIdentityIndexes.get(identityKey);
      if (priorPrecondition !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["preconditions", preconditionIndex],
          message: `precondition identity is already claimed by precondition ${priorPrecondition}`,
        });
      } else {
        preconditionIdentityIndexes.set(identityKey, preconditionIndex);
      }
      const priorPreconditionPath = preconditionPathIndexes.get(pathKey);
      if (priorPreconditionPath !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["preconditions", preconditionIndex],
          message: `precondition path is already claimed by precondition ${priorPreconditionPath}`,
        });
      } else {
        preconditionPathIndexes.set(pathKey, preconditionIndex);
      }

      const claimedIdentity = claimedIdentityIndexes.get(identityKey);
      const claimedPath = claimedPathIndexes.get(pathKey);
      if (claimedIdentity !== undefined || claimedPath !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["preconditions", preconditionIndex],
          message: claimedIdentity !== undefined
            ? `precondition identity is already mutated by entry ${claimedIdentity}`
            : `precondition path is already mutated by entry ${claimedPath}`,
        });
      }
    });
  });
export type DocumentCommitPlan = z.infer<typeof documentCommitPlanSchema>;

export const humanEditLeaseStateSchema = z.enum([
  "clean",
  "dirty",
  "saving",
  "conflict",
]);
export type HumanEditLeaseState = z.infer<typeof humanEditLeaseStateSchema>;

const humanEditLeaseStateAndDraftFields = {
  state: humanEditLeaseStateSchema,
  draftPatch: anchoredTextPatchSchema.optional(),
};

function validateLeaseDraftState(
  value: { readonly state: HumanEditLeaseState; readonly draftPatch?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (value.state === "clean" && value.draftPatch !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["draftPatch"],
      message: "a clean lease cannot carry a draft patch",
    });
  }
}

export const humanEditLeaseSchema = z
  .object({
    leaseId: nonEmptyIdSchema,
    sessionId: nonEmptyIdSchema,
    humanId: nonEmptyIdSchema,
    identity: documentIdentitySchema,
    baseVersion: documentVersionSchema,
    generation: nonNegativeSafeIntegerSchema,
    ...humanEditLeaseStateAndDraftFields,
  })
  .strict()
  .superRefine((lease, ctx) => {
    if (!documentIdentityEquals(lease.identity, lease.baseVersion.identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["baseVersion", "identity"],
        message: "lease identity must equal base-version identity",
      });
    }
    validateLeaseDraftState(lease, ctx);
  });
export type HumanEditLease = z.infer<typeof humanEditLeaseSchema>;

/**
 * Browser-to-transport lease requests intentionally carry no authority. The
 * authenticated server/relay derives the human, canonical identity, exact
 * base version, and lease id before calling the registry.
 */
export const registerHumanEditLeaseRequestSchema = z
  .object({
    sessionId: nonEmptyIdSchema,
    target: humanEditLeaseCandidateTargetSchema,
    ...humanEditLeaseStateAndDraftFields,
  })
  .strict()
  .superRefine(validateLeaseDraftState);
export type RegisterHumanEditLeaseRequest = z.infer<
  typeof registerHumanEditLeaseRequestSchema
>;

export const updateHumanEditLeaseRequestSchema = z
  .object({
    sessionId: nonEmptyIdSchema,
    target: humanEditLeaseCandidateTargetSchema,
    expectedGeneration: nonNegativeSafeIntegerSchema,
    ...humanEditLeaseStateAndDraftFields,
  })
  .strict()
  .superRefine(validateLeaseDraftState);
export type UpdateHumanEditLeaseRequest = z.infer<
  typeof updateHumanEditLeaseRequestSchema
>;

export const renewHumanEditLeaseRequestSchema = z
  .object({
    sessionId: nonEmptyIdSchema,
    target: humanEditLeaseCandidateTargetSchema,
    expectedGeneration: nonNegativeSafeIntegerSchema,
  })
  .strict();
export type RenewHumanEditLeaseRequest = z.infer<
  typeof renewHumanEditLeaseRequestSchema
>;

export const releaseHumanEditLeaseRequestSchema = z
  .object({
    sessionId: nonEmptyIdSchema,
    expectedGeneration: nonNegativeSafeIntegerSchema,
  })
  .strict();
export type ReleaseHumanEditLeaseRequest = z.infer<
  typeof releaseHumanEditLeaseRequestSchema
>;

export const humanEditLeaseRecordSchema = z
  .object({
    lease: humanEditLeaseSchema,
    /** Ephemeral registry deadline expressed as Unix epoch milliseconds. */
    expiresAtMs: nonNegativeSafeIntegerSchema,
  })
  .strict();
export type HumanEditLeaseRecord = z.infer<typeof humanEditLeaseRecordSchema>;

export const humanEditLeaseStoreResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      record: humanEditLeaseRecordSchema,
    })
    .strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z
    .object({
      status: z.literal("stale_generation"),
      record: humanEditLeaseRecordSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("invalid"),
      reason: z.string().refine((value) => value.trim().length > 0, {
        message: "reason must not be empty",
      }),
    })
    .strict(),
]);
export type HumanEditLeaseStoreResult = z.infer<
  typeof humanEditLeaseStoreResultSchema
>;

const createMutationPathSchema = z
  .object({ kind: z.literal("create"), after: documentIdentitySchema })
  .strict();
const updateMutationPathSchema = z
  .object({
    kind: z.literal("update"),
    before: documentIdentitySchema,
    after: documentIdentitySchema,
  })
  .strict()
  .superRefine((path, ctx) => {
    if (!documentIdentityEquals(path.before, path.after)) {
      ctx.addIssue({
        code: "custom",
        path: ["after"],
        message: "update path identities must match",
      });
    }
  });
const nonOverwriteMoveMutationPathSchema = z
  .object({
    kind: z.literal("move"),
    overwrite: z.literal(false),
    before: documentIdentitySchema,
    after: documentIdentitySchema,
  })
  .strict()
  .superRefine((path, ctx) => {
    if (!isSameBackendOwner(path.before, path.after)) {
      ctx.addIssue({
        code: "custom",
        path: ["after"],
        message: "move path must remain within the same artifact or relay",
      });
    } else if (documentIdentityEquals(path.before, path.after)) {
      ctx.addIssue({
        code: "custom",
        path: ["after"],
        message: "move paths must differ",
      });
    }
  });
const overwriteMoveMutationPathSchema = z
  .object({
    kind: z.literal("move"),
    overwrite: z.literal(true),
    before: documentIdentitySchema,
    destinationBefore: documentIdentitySchema,
    after: documentIdentitySchema,
  })
  .strict()
  .superRefine((path, ctx) => {
    if (!isSameBackendOwner(path.before, path.after)) {
      ctx.addIssue({
        code: "custom",
        path: ["after"],
        message: "move path must remain within the same artifact or relay",
      });
    } else if (documentIdentityEquals(path.before, path.after)) {
      ctx.addIssue({
        code: "custom",
        path: ["after"],
        message: "move paths must differ",
      });
    }
    if (!isValidOverwriteDestination(path.before, path.destinationBefore, path.after)) {
      ctx.addIssue({
        code: "custom",
        path: ["destinationBefore"],
        message: "overwrite path must identify the displaced destination",
      });
    }
  });
const deleteMutationPathSchema = z
  .object({ kind: z.literal("delete"), before: documentIdentitySchema })
  .strict();

export const documentMutationPathSchema = z.union([
  createMutationPathSchema,
  updateMutationPathSchema,
  nonOverwriteMoveMutationPathSchema,
  overwriteMoveMutationPathSchema,
  deleteMutationPathSchema,
]);
export type DocumentMutationPath = z.infer<typeof documentMutationPathSchema>;

export const documentMutationConflictCodeSchema = z.enum([
  "human_edit_conflict",
  "stale_version",
  "reapply_required",
]);
export type DocumentMutationConflictCode = z.infer<typeof documentMutationConflictCodeSchema>;

export const documentMutationFailedCodeSchema = z.enum([
  "invalid_plan",
  "backend_unavailable",
  "backend_failure",
  "inconsistent_outcome",
]);
export type DocumentMutationFailedCode = z.infer<typeof documentMutationFailedCodeSchema>;

export const documentMutationConflictEvidenceSchema = z
  .object({
    path: documentMutationPathSchema,
    currentVersion: documentVersionSchema,
  })
  .strict()
  .superRefine((evidence, ctx) => {
    const identities: readonly DocumentIdentity[] =
      evidence.path.kind === "create"
        ? [evidence.path.after]
        : evidence.path.kind === "update"
          ? [evidence.path.before, evidence.path.after]
          : evidence.path.kind === "move"
            ? evidence.path.overwrite
              ? [
                  evidence.path.before,
                  evidence.path.destinationBefore,
                  evidence.path.after,
                ]
              : [evidence.path.before, evidence.path.after]
            : [evidence.path.before];
    if (
      !identities.some((identity) =>
        documentIdentityEquals(identity, evidence.currentVersion.identity),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["currentVersion", "identity"],
        message: "current version must identify its correlated conflict path",
      });
    }
  });
export type DocumentMutationConflictEvidence = z.infer<
  typeof documentMutationConflictEvidenceSchema
>;

const successfulMutationResultBase = {
  operationId: nonEmptyIdSchema,
  revisionGroupId: nonEmptyIdSchema,
  paths: z.array(documentMutationPathSchema).min(1).readonly(),
};
export const documentMutationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("applied"), ...successfulMutationResultBase }).strict(),
  z.object({ kind: z.literal("rebased"), ...successfulMutationResultBase }).strict(),
  z
    .object({
      kind: z.literal("conflict"),
      operationId: nonEmptyIdSchema,
      code: documentMutationConflictCodeSchema,
      evidence: z
        .array(documentMutationConflictEvidenceSchema)
        .min(1)
        .readonly(),
    })
    .strict()
    .superRefine((result, ctx) => {
      const seen = new Set<string>();
      result.evidence.forEach(({ currentVersion: version }, index) => {
        const key =
          version.identity.kind === "workspace_artifact"
            ? `workspace:${version.identity.artifactId}:${version.identity.logicalPath}`
            : `local:${version.identity.relayId}:${version.identity.canonicalPath}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["evidence", index],
            message: "current-version evidence must not duplicate an identity",
          });
        }
        seen.add(key);
      });
    }),
  z
    .object({
      kind: z.literal("failed"),
      operationId: nonEmptyIdSchema,
      code: documentMutationFailedCodeSchema,
    })
    .strict(),
]);
export type DocumentMutationResult = z.infer<typeof documentMutationResultSchema>;

const committedEventBase = {
  type: z.literal("document.mutation.committed"),
  operationId: nonEmptyIdSchema,
  revisionGroupId: nonEmptyIdSchema,
  sequence: nonNegativeSafeIntegerSchema,
  outcome: z.enum(["applied", "rebased"]),
  actor: documentMutationActorSchema,
};

/**
 * Non-authoritative editor correlation carried by a durable update event.
 * It deliberately excludes the plan-only `kind` and `baseVersion` fields:
 * consumers receive only save correlation and a delta already proven against
 * the committed event's actual before/after versions.
 */
export const editorSaveCommittedEventSchema = z
  .object({
    checkpoint: z.boolean(),
    requestId: nonEmptyIdSchema.optional(),
    clientMutationId: nonEmptyIdSchema.optional(),
    anchoredPatch: anchoredTextPatchSchema.optional(),
  })
  .strict();
export type EditorSaveCommittedEvent = z.infer<typeof editorSaveCommittedEventSchema>;

/**
 * Backend-proven Workspace artifact metadata transition. This is deliberately
 * separate from editor correlation: MIME is authoritative row state and must
 * survive receipt replay and future undo/history reconstruction.
 */
export const workspaceArtifactMetadataTransitionSchema = z
  .object({
    beforeMimeType: z.string().trim().min(1),
    afterMimeType: z.string().trim().min(1),
  })
  .strict();
export type WorkspaceArtifactMetadataTransition = z.infer<
  typeof workspaceArtifactMetadataTransitionSchema
>;

const createCommittedEventSchema = z
  .object({
    ...committedEventBase,
    mutation: z.literal("create"),
    path: createMutationPathSchema,
    after: documentVersionSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    if (!documentIdentityEquals(event.path.after, event.after.identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["after", "identity"],
        message: "create event path must equal committed version identity",
      });
    }
  });

const updateCommittedEventSchema = z
  .object({
    ...committedEventBase,
    mutation: z.literal("update"),
    path: updateMutationPathSchema,
    before: documentVersionSchema,
    after: documentVersionSchema,
    editorSave: editorSaveCommittedEventSchema.optional(),
    workspaceArtifactMetadata: workspaceArtifactMetadataTransitionSchema.optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (!documentIdentityEquals(event.path.before, event.before.identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["before", "identity"],
        message: "update event before path and version must match",
      });
    }
    if (!documentIdentityEquals(event.path.after, event.after.identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["after", "identity"],
        message: "update event after path and version must match",
      });
    }
    if (event.editorSave !== undefined && event.actor.kind !== "human") {
      ctx.addIssue({
        code: "custom",
        path: ["editorSave"],
        message: "editor-save event metadata requires a human mutation actor",
      });
    }
    if (
      event.workspaceArtifactMetadata !== undefined &&
      (event.before.identity.kind !== "workspace_artifact" ||
        event.after.identity.kind !== "workspace_artifact")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["workspaceArtifactMetadata"],
        message: "Workspace artifact metadata requires a Workspace artifact update",
      });
    }
  });

const moveCommittedEventSchema = z
  .object({
    ...committedEventBase,
    mutation: z.literal("move"),
    overwrite: z.literal(false),
    path: nonOverwriteMoveMutationPathSchema,
    before: documentVersionSchema,
    after: documentVersionSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    if (!documentIdentityEquals(event.path.before, event.before.identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["before", "identity"],
        message: "move event source path and version must match",
      });
    }
    if (!documentIdentityEquals(event.path.after, event.after.identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["after", "identity"],
        message: "move event destination path and version must match",
      });
    }
  });

const overwriteMoveCommittedEventSchema = z
  .object({
    ...committedEventBase,
    mutation: z.literal("move"),
    overwrite: z.literal(true),
    path: overwriteMoveMutationPathSchema,
    before: documentVersionSchema,
    destinationBefore: documentVersionSchema,
    after: documentVersionSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    if (!documentIdentityEquals(event.path.before, event.before.identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["before", "identity"],
        message: "overwrite move source path and version must match",
      });
    }
    if (
      !documentIdentityEquals(
        event.path.destinationBefore,
        event.destinationBefore.identity,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["destinationBefore", "identity"],
        message: "displaced destination path and version must match",
      });
    }
    if (!documentIdentityEquals(event.path.after, event.after.identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["after", "identity"],
        message: "overwrite move destination path and version must match",
      });
    }
  });

const deleteCommittedEventSchema = z
  .object({
    ...committedEventBase,
    mutation: z.literal("delete"),
    path: deleteMutationPathSchema,
    before: documentVersionSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    if (!documentIdentityEquals(event.path.before, event.before.identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["before", "identity"],
        message: "delete event path must equal committed before-version identity",
      });
    }
  });

/**
 * Defined here but intentionally absent from ServerEvent until a coordinator
 * producer exists.
 */
export const documentMutationCommittedEventSchema = z.union([
  createCommittedEventSchema,
  updateCommittedEventSchema,
  moveCommittedEventSchema,
  overwriteMoveCommittedEventSchema,
  deleteCommittedEventSchema,
]);
export type DocumentMutationCommittedEvent = z.infer<
  typeof documentMutationCommittedEventSchema
>;

export function parseDocumentIdentity(value: unknown): DocumentIdentity {
  return documentIdentitySchema.parse(value);
}

export function parseDocumentVersion(value: unknown): DocumentVersion {
  return documentVersionSchema.parse(value);
}

export function parseDocumentCommitPlan(value: unknown): DocumentCommitPlan {
  return documentCommitPlanSchema.parse(value);
}

export function parseHumanEditLease(value: unknown): HumanEditLease {
  return humanEditLeaseSchema.parse(value);
}

export function parseDocumentMutationResult(value: unknown): DocumentMutationResult {
  return documentMutationResultSchema.parse(value);
}

export function parseDocumentMutationCommittedEvent(
  value: unknown,
): DocumentMutationCommittedEvent {
  return documentMutationCommittedEventSchema.parse(value);
}
