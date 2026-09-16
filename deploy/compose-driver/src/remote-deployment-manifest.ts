import { z } from "zod";
import { appliedAuthContractSchema } from "../../contracts/applied-auth-contract.ts";

const INSTANCE_ID_RE = /^[a-z0-9-]{0,16}$/;
const COMPOSE_PROJECT_NAME_RE = /^[a-z0-9_-]+$/;

function isValidIsoDateString(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/** Absolute normalized POSIX path: starts with `/`, no empty, `.`, or `..` segments. */
export function isAbsoluteNormalizedPosixPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path === "/") return true;
  if (path.endsWith("/")) return false;
  const segments = path.split("/");
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

const isoDateString = z.string().refine(isValidIsoDateString, {
  message: "must be a valid ISO-parseable date string",
});

const remoteDeploymentManifestFields = {
  instanceId: z
    .string()
    .regex(INSTANCE_ID_RE, "instanceId must match /^[a-z0-9-]{0,16}$/"),
  composeProjectName: z
    .string()
    .min(1, "composeProjectName must be nonempty")
    .regex(
      COMPOSE_PROJECT_NAME_RE,
      "composeProjectName must contain only [a-z0-9_-]",
    ),
  lifecycle: z.literal("compose"),
  remoteRoot: z.string().refine(isAbsoluteNormalizedPosixPath, {
    message:
      "remoteRoot must be an absolute normalized POSIX path (starts with /; no empty segments, . or ..)",
  }),
  https: z.enum(["off", "letsencrypt"]),
  createdAt: isoDateString,
  updatedAt: isoDateString,
};

const remoteDeploymentManifestV1Schema = z
  .object({
    version: z.literal(1),
    ...remoteDeploymentManifestFields,
    image: z
      .object({
        mode: z.literal("registry"),
        reference: z.string().min(1, "image.reference must be nonempty"),
      })
      .strict(),
  })
  .strict();

export const remoteDeploymentManifestV2Schema = z
  .object({
    version: z.literal(2),
    ...remoteDeploymentManifestFields,
    image: z
      .discriminatedUnion("mode", [
        z
          .object({
            mode: z.literal("registry"),
            reference: z.string().min(1, "image.reference must be nonempty"),
          })
          .strict(),
        z
          .object({
            mode: z.literal("source"),
            reference: z.string().min(1, "image.reference must be nonempty"),
          })
          .strict(),
      ]),
    contracts: z
      .object({
        authApplied: appliedAuthContractSchema.optional(),
        // Only `nautilo adopt --confirm` records this provenance marker.
        // It is deliberately narrower than a missing auth stamp: explicit
        // reconciliation may bootstrap and stamp this inspected legacy state.
        legacyAdopted: z.literal(true).optional(),
        // D427 Wave 1 (tasks 1.2.1 / 1.2.2) — verified recovery-bundle
        // provenance + durable adoption phase. Presence of `adoption`
        // distinguishes a confirmed adoption (manifest written under
        // `adopt --confirm --bundle <verified path>`) from a pre-confirmation
        // state (no manifest, or dry-run inspection only). The bundle
        // identity (manifestSha256) and the original running image reference
        // are recorded so a resumed bootstrap never loses the original image
        // identity; `phase` is the versioned marker Wave 2 extends.
        adoption: z
          .object({
            phase: z.literal("confirmed"),
            confirmedAt: isoDateString,
            bundle: z
              .object({
                manifestSha256: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/, "must be a SHA-256 hex digest"),
                createdAt: isoDateString,
                verifiedAt: isoDateString,
                imageMode: z.enum(["registry", "source"]),
                imageReference: z.string().min(1),
              })
              .strict(),
            runningImageReference: z.string().min(1),
          })
          .strict()
          .optional(),
        // D427 Wave 2 — durable cursor for the one explicit legacy
        // conversion transaction.  It is deliberately separate from the
        // adoption proof above: adoption remains immutable provenance, while
        // this cursor advances only after each idempotent bootstrap phase.
        legacyBootstrap: z
          .object({
            phase: z.enum([
              "adopted",
              "materialized",
              "deployed",
              "auth-planned",
              "accepted",
            ]),
            // The requested immutable registry artifact is part of the
            // conversion contract, not a profile/tag default. A retry must
            // use exactly this value.
            imageReference: z.string().min(1),
            updatedAt: isoDateString,
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

/** Accepts existing v1 manifests while deployments migrate them to v2 on write. */
export const remoteDeploymentManifestSchema = z.union([
  remoteDeploymentManifestV1Schema,
  remoteDeploymentManifestV2Schema,
]);

export type RemoteDeploymentManifest = z.infer<typeof remoteDeploymentManifestSchema>;
export type RemoteDeploymentManifestV2 = z.infer<
  typeof remoteDeploymentManifestV2Schema
>;

export function migrateRemoteDeploymentManifest(
  manifest: RemoteDeploymentManifest,
): RemoteDeploymentManifestV2 {
  if (manifest.version === 2) return manifest;
  return {
    ...manifest,
    version: 2,
    contracts: {},
  };
}

export interface RemoteDeploymentManifestIdentity {
  instanceId: string;
  composeProjectName: string;
  remoteRoot: string;
}

/**
 * Ensures a validated manifest's identity fields match the caller's expected
 * profile-derived values before mutating remote state. Never logs manifest
 * content.
 */
export function assertRemoteDeploymentManifestIdentity(
  manifest: RemoteDeploymentManifest,
  expected: RemoteDeploymentManifestIdentity,
): void {
  const mismatches: string[] = [];

  if (manifest.instanceId !== expected.instanceId) {
    mismatches.push(
      `instanceId: expected '${expected.instanceId}', got '${manifest.instanceId}'`,
    );
  }
  if (manifest.composeProjectName !== expected.composeProjectName) {
    mismatches.push(
      `composeProjectName: expected '${expected.composeProjectName}', got '${manifest.composeProjectName}'`,
    );
  }
  if (manifest.remoteRoot !== expected.remoteRoot) {
    mismatches.push(
      `remoteRoot: expected '${expected.remoteRoot}', got '${manifest.remoteRoot}'`,
    );
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Remote deployment manifest identity mismatch (${mismatches.join("; ")}). ` +
        "Verify the profile instance_id, remote_path, and SSH target match the remote host.",
    );
  }
}
