import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { getArtifactsRoot } from "@nautilo/config";
import { warn } from "@nautilo/logger";
import { writeAtomic } from "../file/atomic-write";
import {
  applyWorkspaceArtifactRowChange,
  resolveWorkspaceArtifact,
  type ArtifactResolution,
  type EnvelopeFacts,
  type WorkspaceArtifactPatchMeta,
} from "../file/artifact-store";

export interface GeneratedImagePublicationTarget {
  readonly logicalPath: string;
  readonly resolution: Extract<ArtifactResolution, { ok: true }>;
}

export interface GeneratedImagePublicationPlan {
  readonly baseStem: string;
  readonly subdirRel: string;
  readonly requestedCount: number;
  readonly requestedMime: string;
  readonly requestedExtension: string;
  readonly targets: readonly GeneratedImagePublicationTarget[];
}

export interface PublishedGeneratedImage {
  readonly artifactId: string;
  readonly path: string;
  readonly zone: "workspace";
  readonly mime: string;
  readonly bytes: number;
}

export interface PendingGeneratedImagePublication {
  readonly path: string;
  readonly mime: string;
  readonly bytes: number;
  readonly retained: boolean;
  /** Opaque operator correlation only; this is not a registered Artifact id. */
  readonly recoveryRef?: string;
}

export interface GeneratedImagePublicationResult {
  readonly images: readonly PublishedGeneratedImage[];
  readonly pendingPublications: readonly PendingGeneratedImagePublication[];
  readonly publication: {
    readonly status: "complete" | "partial" | "pending";
    readonly publishedCount: number;
    readonly pendingCount: number;
    readonly recovery?: string;
  };
}

export interface GeneratedImagePublicationDeps {
  readonly resolveWorkspaceArtifact?: typeof resolveWorkspaceArtifact;
  readonly applyWorkspaceArtifactRowChange?: typeof applyWorkspaceArtifactRowChange;
  readonly writeBytes?: (physicalPath: string, bytes: Buffer) => Promise<void>;
  readonly prepareStorage?: (physicalPath: string) => Promise<void>;
}

function logicalPaths(input: {
  baseStem: string;
  subdirRel: string;
  count: number;
  extension: string;
}): string[] {
  return Array.from({ length: input.count }, (_, index) => {
    const suffix = input.count === 1
      ? ""
      : `-${String(index + 1).padStart(2, "0")}`;
    return posix.join(
      input.subdirRel,
      `${input.baseStem}${suffix}.${input.extension}`,
    );
  });
}

async function resolveCreationTargets(input: {
  logicalPaths: readonly string[];
  facts: EnvelopeFacts;
  resolve: typeof resolveWorkspaceArtifact;
}): Promise<GeneratedImagePublicationTarget[]> {
  const targets: GeneratedImagePublicationTarget[] = [];
  for (const logicalPath of input.logicalPaths) {
    const resolution = await input.resolve({
      logicalPath,
      facts: input.facts,
      intent: "create",
    });
    if (!resolution.ok) throw new Error(resolution.reason);
    targets.push({ logicalPath, resolution });
  }
  return targets;
}

/**
 * Resolve every predictable output before provider dispatch. Provider output
 * count or MIME can still differ; that case is resolved after generation and
 * receives the paid-result recovery behavior below.
 */
export async function preflightGeneratedImagePublication(input: {
  baseStem: string;
  subdirRel: string;
  requestedCount: number;
  requestedMime: string;
  requestedExtension: string;
  facts: EnvelopeFacts;
  deps?: GeneratedImagePublicationDeps;
}): Promise<GeneratedImagePublicationPlan> {
  const resolve = input.deps?.resolveWorkspaceArtifact
    ?? resolveWorkspaceArtifact;
  const targets = await resolveCreationTargets({
    logicalPaths: logicalPaths({
      baseStem: input.baseStem,
      subdirRel: input.subdirRel,
      count: input.requestedCount,
      extension: input.requestedExtension,
    }),
    facts: input.facts,
    resolve,
  });
  return {
    baseStem: input.baseStem,
    subdirRel: input.subdirRel,
    requestedCount: input.requestedCount,
    requestedMime: input.requestedMime,
    requestedExtension: input.requestedExtension,
    targets,
  };
}

type RegistrationState = "exact" | "absent" | "unknown";

async function inspectRegistration(input: {
  target: GeneratedImagePublicationTarget;
  meta: WorkspaceArtifactPatchMeta;
  size: number;
  facts: EnvelopeFacts;
  resolve: typeof resolveWorkspaceArtifact;
}): Promise<RegistrationState> {
  try {
    const visible = await input.resolve({
      logicalPath: input.target.logicalPath,
      facts: input.facts,
      intent: "read",
    });
    if (visible.ok && visible.artifact) {
      const artifact = visible.artifact;
      return artifact.artifactId === input.meta.artifactId
        && artifact.path === input.meta.logicalPath
        && artifact.storageUri === input.meta.storageUri
        && artifact.size === input.size
        && artifact.mimeType === input.meta.mimeType
        ? "exact"
        : "unknown";
    }

    const absentCheck = await input.resolve({
      logicalPath: input.target.logicalPath,
      facts: input.facts,
      intent: "create",
    });
    return absentCheck.ok && absentCheck.artifact === null
      ? "absent"
      : "unknown";
  } catch {
    return "unknown";
  }
}

async function registerWithOneAbsentRetry(input: {
  target: GeneratedImagePublicationTarget;
  meta: WorkspaceArtifactPatchMeta;
  size: number;
  facts: EnvelopeFacts;
  actor: { kind: "agent"; agentId: string };
  apply: typeof applyWorkspaceArtifactRowChange;
  resolve: typeof resolveWorkspaceArtifact;
}): Promise<boolean> {
  try {
    const applied = await input.apply(
      input.meta,
      input.size,
      input.facts.userId,
      input.facts.agentId,
      input.actor,
    );
    if (applied) return true;
  } catch {
    // The transaction may have committed before its acknowledgement failed.
  }

  const firstInspection = await inspectRegistration(input);
  if (firstInspection === "exact") return true;
  if (firstInspection !== "absent") return false;

  try {
    const retried = await input.apply(
      input.meta,
      input.size,
      input.facts.userId,
      input.facts.agentId,
      input.actor,
    );
    if (retried) return true;
  } catch {
    // Inspect once more: the single retry can also lose its acknowledgement.
  }
  return await inspectRegistration(input) === "exact";
}

async function retainBytes(input: {
  preferredPath?: string;
  bytes: Buffer;
  writeBytes: (physicalPath: string, bytes: Buffer) => Promise<void>;
  prepareStorage: (physicalPath: string) => Promise<void>;
}): Promise<
  | { retained: true; recoveryRef: string }
  | { retained: false }
> {
  try {
    const artifactsRoot = getArtifactsRoot();
    await mkdir(artifactsRoot, { recursive: true });
    const physicalPath = input.preferredPath
      ?? join(artifactsRoot, randomUUID());
    await input.prepareStorage(physicalPath);
    await input.writeBytes(physicalPath, input.bytes);
    return { retained: true, recoveryRef: basename(physicalPath) };
  } catch {
    try {
      warn("[generate_image] retaining generated bytes failed code=IMAGE_RETENTION_FAILED");
    } catch {
      // Diagnostics must not replace the paid provider result.
    }
    return { retained: false };
  }
}

function recoveryMessage(allRetained: boolean): string {
  const retained = allRetained
    ? "The generated bytes were retained with opaque recovery references for operator diagnosis."
    : "Some generated bytes could not be retained; preserve this result for diagnosis.";
  return `Generation completed, but one or more outputs were not added to Workspace. ${retained} Do not regenerate or retry the paid request; doing so can bill the user again.`;
}

/** Publish a completed provider result without converting publication failure
 * into a generation failure. Only exact, Namespace-visible rows are returned
 * as accessible images; unresolved byte blobs remain private recovery data. */
export async function publishGeneratedImages(input: {
  plan: GeneratedImagePublicationPlan;
  bytes: readonly Buffer[];
  mime: string;
  extension: string;
  facts: EnvelopeFacts;
  targetNamespaceId: string;
  deps?: GeneratedImagePublicationDeps;
}): Promise<GeneratedImagePublicationResult> {
  const resolve = input.deps?.resolveWorkspaceArtifact
    ?? resolveWorkspaceArtifact;
  const apply = input.deps?.applyWorkspaceArtifactRowChange
    ?? applyWorkspaceArtifactRowChange;
  const writeBytes = input.deps?.writeBytes ?? writeAtomic;
  const prepareStorage = input.deps?.prepareStorage
    ?? (async (physicalPath: string) => {
      await mkdir(dirname(physicalPath), { recursive: true });
    });
  const actualPaths = logicalPaths({
    baseStem: input.plan.baseStem,
    subdirRel: input.plan.subdirRel,
    count: input.bytes.length,
    extension: input.extension,
  });

  let targets: Array<GeneratedImagePublicationTarget | null>;
  if (
    input.bytes.length === input.plan.requestedCount
    && input.mime === input.plan.requestedMime
    && input.extension === input.plan.requestedExtension
  ) {
    targets = [...input.plan.targets];
  } else {
    targets = [];
    for (const logicalPath of actualPaths) {
      try {
        const [target] = await resolveCreationTargets({
          logicalPaths: [logicalPath],
          facts: input.facts,
          resolve,
        });
        targets.push(target ?? null);
      } catch {
        targets.push(null);
      }
    }
  }

  const images: PublishedGeneratedImage[] = [];
  const pendingPublications: PendingGeneratedImagePublication[] = [];
  for (let index = 0; index < input.bytes.length; index += 1) {
    const bytes = input.bytes[index]!;
    const target = targets[index] ?? null;
    const logicalPath = actualPaths[index]!;
    if (!target) {
      const retained = await retainBytes({
        ...(input.plan.targets[index]?.resolution.physicalPath === undefined
          ? {}
          : {
              preferredPath:
                input.plan.targets[index]!.resolution.physicalPath,
            }),
        bytes,
        writeBytes,
        prepareStorage,
      });
      pendingPublications.push({
        path: logicalPath,
        mime: input.mime,
        bytes: bytes.byteLength,
        retained: retained.retained,
        ...(retained.retained
          ? { recoveryRef: retained.recoveryRef }
          : {}),
      });
      continue;
    }

    const retained = await retainBytes({
      preferredPath: target.resolution.physicalPath,
      bytes,
      writeBytes,
      prepareStorage,
    });
    if (!retained.retained) {
      pendingPublications.push({
        path: logicalPath,
        mime: input.mime,
        bytes: bytes.byteLength,
        retained: false,
      });
      continue;
    }

    const meta: WorkspaceArtifactPatchMeta = {
      mode: "create",
      artifactId: target.resolution.artifactId,
      logicalPath: target.resolution.logicalPath,
      namespaceId: input.targetNamespaceId,
      storageUri: target.resolution.storageUri,
      mimeType: input.mime,
    };
    const registered = await registerWithOneAbsentRetry({
      target,
      meta,
      size: bytes.byteLength,
      facts: input.facts,
      actor: { kind: "agent", agentId: input.facts.agentId },
      apply,
      resolve,
    });
    if (registered) {
      images.push({
        artifactId: target.resolution.artifactId,
        path: target.logicalPath,
        zone: "workspace",
        mime: input.mime,
        bytes: bytes.byteLength,
      });
    } else {
      pendingPublications.push({
        path: logicalPath,
        mime: input.mime,
        bytes: bytes.byteLength,
        retained: true,
        recoveryRef: retained.recoveryRef,
      });
    }
  }

  const status = pendingPublications.length === 0
    ? "complete"
    : images.length === 0 ? "pending" : "partial";
  return {
    images,
    pendingPublications,
    publication: {
      status,
      publishedCount: images.length,
      pendingCount: pendingPublications.length,
      ...(pendingPublications.length === 0
        ? {}
        : {
            recovery: recoveryMessage(
              pendingPublications.every((item) => item.retained),
            ),
          }),
    },
  };
}
