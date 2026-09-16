import {
  documentCommitPlanSchema,
  type DocumentCommitPlan,
  type DocumentIdentity,
} from "@nautilo/types";
import type { DocumentMutationBackendKind } from "./backend";

export type HashBytes = (bytes: Uint8Array) => string | Promise<string>;

export interface PlanValidationDiagnostic {
  readonly code:
    | "schema_invalid"
    | "backend_mismatch"
    | "hash_mismatch"
    | "hash_invalid"
    | "hash_failure";
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly expected?: string;
  readonly actual?: string;
}

export type DocumentCommitPlanValidationOutcome =
  | {
      readonly kind: "valid";
      readonly backend: DocumentMutationBackendKind;
      readonly plan: DocumentCommitPlan;
    }
  | {
      readonly kind: "invalid";
      readonly code:
        | "invalid_plan"
        | "backend_mismatch"
        | "hash_mismatch"
        | "hash_failure";
      readonly diagnostics: readonly PlanValidationDiagnostic[];
    };

function backendForIdentity(identity: DocumentIdentity): DocumentMutationBackendKind {
  return identity.kind === "workspace_artifact" ? "workspace" : "desktop";
}

function firstIdentity(plan: DocumentCommitPlan): DocumentIdentity {
  const first = plan.entries[0]!;
  switch (first.kind) {
    case "create":
      return first.after.identity;
    case "update":
      return first.before.identity;
    case "move":
      return first.source.identity;
    case "delete":
      return first.before.identity;
  }
}

interface HashClaim {
  readonly bytes: Uint8Array;
  readonly expected: string;
  readonly path: readonly (string | number)[];
}

function hashClaims(plan: DocumentCommitPlan): readonly HashClaim[] {
  const claims: HashClaim[] = [];
  plan.preconditions?.forEach((precondition, preconditionIndex) => {
    claims.push({
      bytes: precondition.bytes,
      expected: precondition.expectedVersion.sha256,
      path: ["preconditions", preconditionIndex, "expectedVersion", "sha256"],
    });
  });
  plan.entries.forEach((entry, entryIndex) => {
    const addSnapshot = (
      snapshot: { bytes: Uint8Array; expectedVersion: { sha256: string } },
      field: string,
    ) => {
      claims.push({
        bytes: snapshot.bytes,
        expected: snapshot.expectedVersion.sha256,
        path: ["entries", entryIndex, field, "expectedVersion", "sha256"],
      });
    };
    const addPostImage = (
      postImage: { bytes: Uint8Array; sha256: string },
      field: string,
    ) => {
      claims.push({
        bytes: postImage.bytes,
        expected: postImage.sha256,
        path: ["entries", entryIndex, field, "sha256"],
      });
    };

    switch (entry.kind) {
      case "create":
        addPostImage(entry.after, "after");
        break;
      case "update":
        addSnapshot(entry.before, "before");
        addPostImage(entry.after, "after");
        break;
      case "move":
        addSnapshot(entry.source, "source");
        if (entry.destinationBefore !== undefined) {
          addSnapshot(entry.destinationBefore, "destinationBefore");
        }
        addPostImage(entry.after, "after");
        break;
      case "delete":
        addSnapshot(entry.before, "before");
        break;
    }
  });
  return claims;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export async function validateDocumentCommitPlan(
  value: unknown,
  expectedBackend: DocumentMutationBackendKind,
  hashBytes: HashBytes,
): Promise<DocumentCommitPlanValidationOutcome> {
  const parsed = documentCommitPlanSchema.safeParse(value);
  if (!parsed.success) {
    return {
      kind: "invalid",
      code: "invalid_plan",
      diagnostics: parsed.error.issues.map((issue) => ({
        code: "schema_invalid",
        message: issue.message,
        path: issue.path.map((segment) =>
          typeof segment === "symbol" ? String(segment) : segment,
        ),
      })),
    };
  }

  const plan = parsed.data;
  const actualBackend = backendForIdentity(firstIdentity(plan));
  if (actualBackend !== expectedBackend) {
    return {
      kind: "invalid",
      code: "backend_mismatch",
      diagnostics: [
        {
          code: "backend_mismatch",
          message: `plan targets ${actualBackend}, not ${expectedBackend}`,
          path: ["entries", 0],
        },
      ],
    };
  }

  const diagnostics: PlanValidationDiagnostic[] = [];
  for (const claim of hashClaims(plan)) {
    let actual: string;
    try {
      actual = await hashBytes(claim.bytes);
    } catch (error) {
      diagnostics.push({
        code: "hash_failure",
        message: error instanceof Error ? error.message : "hash function failed",
        path: claim.path,
      });
      continue;
    }

    if (!SHA256_PATTERN.test(actual)) {
      diagnostics.push({
        code: "hash_invalid",
        message: "hash function returned a non-canonical SHA-256",
        path: claim.path,
        actual,
      });
    } else if (actual !== claim.expected) {
      diagnostics.push({
        code: "hash_mismatch",
        message: "declared SHA-256 does not match exact bytes",
        path: claim.path,
        expected: claim.expected,
        actual,
      });
    }
  }

  if (diagnostics.length > 0) {
    const code = diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "hash_failure" || diagnostic.code === "hash_invalid",
    )
      ? "hash_failure"
      : "hash_mismatch";
    return { kind: "invalid", code, diagnostics };
  }

  return { kind: "valid", backend: actualBackend, plan };
}
