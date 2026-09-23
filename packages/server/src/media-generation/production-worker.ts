/** D525 production binding for restart-safe Venice media reconciliation. */
import { createHash, randomUUID } from "node:crypto";
import { emitWorkspaceArtifactCreatedFact } from "@nautilo/agent";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";
import {
  LOCKED_VENICE_MEDIA_MODEL_FACTS,
  MediaArtifactIndexCommitError,
  MediaGenerationReconciler,
  VENICE_MEDIA_MODELS,
  VeniceMediaLifecycleAdapter,
  resolveProviderKey,
  type CommittedMediaArtifactIdentity,
  type MediaArtifactIndexCommit,
  type MediaGenerationArtifactCustody,
  type MediaGenerationReconcilerRepository,
  type VeniceMediaFetch,
  type VeniceMediaModel,
} from "@nautilo/agent";
import { getArtifactsRoot } from "@nautilo/config";
import {
  attachArtifactToNamespace,
  claimDueMediaGenerations,
  claimDueMediaGenerationCompletionWakes,
  completeClaimedMediaGenerationCleanup,
  completeMediaGenerationCompletionWake,
  findArtifactByInternalIdForNamespaces,
  getArtifactNamespaces,
  insertArtifact,
  readClaimedMediaGeneration,
  renewMediaGenerationClaim,
  releaseMediaGenerationCompletionWake,
  rescheduleClaimedMediaGeneration,
  rescheduleClaimedMediaGenerationCleanup,
  transitionClaimedMediaGeneration,
  type Artifact,
  type ClaimedMediaGeneration,
  type DirectDatabase,
  videoGenerationLinks, and, eq,
  actors,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import {
  createMaintenanceAcceptanceAuthority,
  eventBus,
  jobManager,
} from "@nautilo/runtime";
import {
  createAcceptedInvocationAuthority,
  assertCanInvokeAgent,
  assertCanUseServerProviderCredentials,
  AgentInvocationDeniedError,
  ServerProviderCredentialsDeniedError,
  type AgentInvocationAdmissionInput,
  getPolicyResolver,
} from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH = 4;

type MediaCompletionWakeJobManager = Pick<typeof jobManager, "createSystemForegroundJob">;

/**
 * Deliver ready-receipt wakes through the ordinary serialized foreground path.
 * The hidden input is deliberately tiny: no creative prompt, provider identity,
 * media bytes, storage path, URL, or queue coordinate enters Genie context.
 */
export async function deliverProductionMediaGenerationCompletionWakes(input: {
  readonly db: DirectDatabase;
  readonly now?: () => Date;
  readonly batch?: number;
  readonly jobs?: MediaCompletionWakeJobManager;
  readonly resolveEnvelope?: (claim: import("@nautilo/db").ClaimedMediaGenerationCompletionWake) => Promise<unknown>;
  readonly assertInvocation?: (input: AgentInvocationAdmissionInput) => Promise<void>;
  readonly assertServerFunding?: (humanUserId: string, origin?: string) => Promise<void>;
  readonly operations?: Readonly<{
    claim: typeof claimDueMediaGenerationCompletionWakes;
    complete: typeof completeMediaGenerationCompletionWake;
    release: typeof releaseMediaGenerationCompletionWake;
  }>;
}): Promise<{ readonly claimed: number; readonly delivered: number }> {
  const now = input.now ?? (() => new Date());
  const operations = input.operations ?? {
    claim: claimDueMediaGenerationCompletionWakes,
    complete: completeMediaGenerationCompletionWake,
    release: releaseMediaGenerationCompletionWake,
  };
  const claims = await operations.claim(input.db, {
    now: now(),
    batch: input.batch ?? DEFAULT_BATCH,
  });
  let delivered = 0;
  for (const claim of claims) {
    try {
      await (input.assertInvocation ?? assertCanInvokeAgent)({
        humanUserId: claim.ownerId,
        origin: "foreground_resume",
        roomId: claim.roomId,
        agentId: claim.initiatingAgentId,
      });
      await (input.assertServerFunding ?? assertCanUseServerProviderCredentials)(
        claim.ownerId,
        "media_completion_wake",
      );
      const laneKey = `room:${claim.roomId}`;
      const envelope = input.resolveEnvelope
        ? await input.resolveEnvelope(claim)
        : await (async () => {
            const resolver = getPolicyResolver();
            if (!resolver) throw new Error("policy resolver unavailable");
            const humanActors = await input.db.select({ id: actors.id }).from(actors).where(and(
              eq(actors.ownerId, claim.ownerId),
              eq(actors.kind, "user"),
            )).limit(2);
            if (humanActors.length !== 1) throw new Error("media generation owner actor unavailable");
            return resolver.buildEnvelope(humanActors[0]!.id, laneKey, claim.initiatingAgentId, claim.roomId);
          })();
      const note = `[MEDIA GENERATION READY] A ${claim.kind === "music" ? "music" : "video"} generation initiated in this Room is now durably saved to Workspace. The existing generation card has the playable artifact. You may briefly tell the user it is ready; do not claim anything beyond completion.`;
      await (input.jobs ?? jobManager).createSystemForegroundJob(
        claim.ownerId,
        claim.ownerId,
        laneKey,
        {
          message: note,
          ownerId: claim.ownerId,
          requestorId: claim.ownerId,
          agentId: claim.initiatingAgentId,
          roomId: claim.roomId,
          roomRoster: [],
          graphThreadId: claim.initiatingThreadId,
          threadId: claim.initiatingThreadId,
          voiceMode: false,
          memoryAccessEnvelope: envelope,
          actorRole: "owner",
          turnId: deterministicUuid(claim.receiptId, "wake"),
          currentFolder: "",
          workspacePath: "",
          metadata: { originatedBy: "media_generation", receiptId: claim.receiptId },
        },
        undefined,
        createMaintenanceAcceptanceAuthority(),
        undefined,
        createAcceptedInvocationAuthority(claim.ownerId),
      );
      if (await operations.complete(input.db, { ...claim, now: now() })) {
        delivered += 1;
      }
    } catch (error) {
      if (error instanceof AgentInvocationDeniedError
        || error instanceof ServerProviderCredentialsDeniedError) {
        await operations.complete(input.db, { ...claim, now: now() });
        continue;
      }
      await operations.release(input.db, { ...claim, now: now() }).catch(() => false);
      warn("[media-generation] completion wake failed; the durable notification will be retried");
    }
  }
  return { claimed: claims.length, delivered };
}

/** Explicit per-model persistence ceilings; these are storage safety policy, not upload-picker limits. */
export const MEDIA_GENERATION_MAX_BYTES: Readonly<Record<VeniceMediaModel, number>> = Object.freeze({
  [VENICE_MEDIA_MODELS.seedance]: 512 * 1024 * 1024,
  [VENICE_MEDIA_MODELS.seedanceReference]: 512 * 1024 * 1024,
  [VENICE_MEDIA_MODELS.minimaxH3]: 512 * 1024 * 1024,
  [VENICE_MEDIA_MODELS.sonilo]: 128 * 1024 * 1024,
  [VENICE_MEDIA_MODELS.minimaxMusic]: 128 * 1024 * 1024,
});

export function createProductionMediaGenerationWorkerRepository(
  db: DirectDatabase,
): MediaGenerationReconcilerRepository {
  return {
    claimDue: (input) => claimDueMediaGenerations(db, input),
    readClaimed: (input) => readClaimedMediaGeneration(db, input),
    renew: (input) => renewMediaGenerationClaim(db, input),
    transition: (input) => transitionClaimedMediaGeneration(db, input),
    reschedule: (input) => rescheduleClaimedMediaGeneration(db, input),
    rescheduleCleanup: (input) => rescheduleClaimedMediaGenerationCleanup(db, input),
    async completeCleanup(input) {
      return (await completeClaimedMediaGenerationCleanup(db, input)) !== null;
    },
  };
}

function deterministicUuid(receiptId: string, purpose: "row" | "external" | "wake"): string {
  const bytes = createHash("sha256").update(`nautilo:media-generation:${purpose}:${receiptId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function extensionForMime(mimeType: string): "mp4" | "m4a" | "mp3" {
  if (mimeType === "video/mp4") return "mp4";
  if (mimeType === "audio/mp4") return "m4a";
  if (mimeType === "audio/mpeg") return "mp3";
  throw new Error("unsupported generated media MIME type");
}

function expectedMime(claim: ClaimedMediaGeneration): string | null {
  const facts = LOCKED_VENICE_MEDIA_MODEL_FACTS[claim.providerModel as VeniceMediaModel];
  return facts?.kind === claim.kind ? facts.outputMime : null;
}

function expectedArtifact(claim: ClaimedMediaGeneration, mimeType: string) {
  return {
    internalId: deterministicUuid(claim.receiptId, "row"),
    artifactId: deterministicUuid(claim.receiptId, "external"),
    logicalPath: `generated-media/${claim.receiptId}.${extensionForMime(mimeType)}`,
  };
}

async function validatedFinalPath(root: string, finalPath: string): Promise<string> {
  const [canonicalRoot, canonicalFinal] = await Promise.all([fsp.realpath(root), fsp.realpath(finalPath)]);
  const relative = path.relative(canonicalRoot, canonicalFinal);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("generated media final path escaped the artifact root");
  }
  const info = await fsp.stat(canonicalFinal);
  if (!info.isFile()) throw new Error("generated media final path is not a file");
  return canonicalFinal;
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    if (!(chunk instanceof Uint8Array)) throw new Error("artifact hash stream returned non-bytes");
    digest.update(chunk);
  }
  return digest.digest("hex");
}

async function validateExistingArtifact(input: {
  claim: ClaimedMediaGeneration;
  row: Artifact;
  root: string;
  expectedMime: string;
  expectedSize?: number;
  expectedSha256?: string;
  db: DirectDatabase;
  namespaces?: (artifactInternalId: string, connection: unknown) => Promise<readonly string[]>;
}): Promise<CommittedMediaArtifactIdentity | null> {
  const expected = expectedArtifact(input.claim, input.expectedMime);
  if (input.row.id !== expected.internalId || input.row.artifactId !== expected.artifactId ||
      input.row.path !== expected.logicalPath || input.row.mimeType !== input.expectedMime || input.row.deletedAt !== null ||
      (input.expectedSize !== undefined && input.row.size !== input.expectedSize)) return null;
  const namespaces = await (input.namespaces ?? ((artifactInternalId, connection) =>
    getArtifactNamespaces(artifactInternalId, connection as never)))(input.row.id, input.db);
  if (namespaces.length !== 1 || namespaces[0] !== input.claim.namespaceId) return null;
  if (!input.row.storageUri.startsWith("file://")) return null;
  let storedPath: string;
  try {
    storedPath = fileURLToPath(input.row.storageUri);
  } catch {
    return null;
  }
  try {
    const canonical = await validatedFinalPath(input.root, storedPath);
    const stat = await fsp.stat(canonical);
    if (stat.size !== input.row.size) return null;
    if (input.expectedSha256 !== undefined && await sha256File(canonical) !== input.expectedSha256) return null;
  } catch {
    return null;
  }
  return { artifactId: input.row.artifactId, artifactInternalId: input.row.id, artifactRevision: input.row.revision };
}

export interface ProductionMediaArtifactCustodyOptions {
  readonly db: DirectDatabase;
  readonly artifactRoot: string;
  /** Existing durable Video-origin binding; null never means the owner authored it. */
  readonly resolveHumanCreator?: (claim: ClaimedMediaGeneration) => Promise<string | null>;
  readonly emitArtifactChanged?: (event: Readonly<{ id: string; artifactId: string; path: string }>) => void;
  /** Narrow canonical-index seams for focused transaction/idempotency tests. */
  readonly artifactOperations?: Readonly<{
    find(internalId: string, namespaceId: string, connection: unknown): Promise<Artifact | null>;
    namespaces(artifactInternalId: string, connection: unknown): Promise<readonly string[]>;
    transaction<T>(run: (connection: unknown) => Promise<T>): Promise<T>;
    insert(input: Readonly<{
      internalId: string; artifactId: string; path: string; storageUri: string; mimeType: string; size: number;
    }>, connection: unknown): Promise<Artifact>;
    attach(artifactInternalId: string, namespaceId: string, connection: unknown): Promise<void>;
  }>;
}

/** Canonical Workspace index custody: one artifact row plus exactly one claimed Namespace edge. */
export function createProductionMediaArtifactCustody(
  options: ProductionMediaArtifactCustodyOptions,
): MediaGenerationArtifactCustody {
  const operations = options.artifactOperations ?? {
    find: (internalId: string, namespaceId: string, connection: unknown) =>
      findArtifactByInternalIdForNamespaces({ internalId, readableNamespaceIds: [namespaceId] }, connection as never),
    namespaces: (artifactInternalId: string, connection: unknown) =>
      getArtifactNamespaces(artifactInternalId, connection as never),
    transaction: <T>(run: (connection: unknown) => Promise<T>) => options.db.transaction((tx) => run(tx)),
    insert: (input: Readonly<{
      internalId: string; artifactId: string; path: string; storageUri: string; mimeType: string; size: number;
    }>, connection: unknown) => insertArtifact(input, connection as never),
    attach: (artifactInternalId: string, namespaceId: string, connection: unknown) =>
      attachArtifactToNamespace({ artifactId: artifactInternalId, namespaceId }, connection as never),
  };
  const find = async (claim: ClaimedMediaGeneration, db: DirectDatabase = options.db) => {
    const mimeType = expectedMime(claim);
    if (mimeType === null) return null;
    const expected = expectedArtifact(claim, mimeType);
    const row = await operations.find(expected.internalId, claim.namespaceId, db);
    if (!row) return null;
    return validateExistingArtifact({ claim, row, root: options.artifactRoot, expectedMime: mimeType, db, namespaces: operations.namespaces });
  };

  return {
    findCommitted: find,
    committerFor(claim) {
      return {
        async commit(input: MediaArtifactIndexCommit) {
          const expected = expectedArtifact(claim, input.mimeType);
          let canonicalFinal: string;
          try {
            canonicalFinal = await validatedFinalPath(options.artifactRoot, input.finalPath);
          } catch {
            throw new MediaArtifactIndexCommitError("not_committed");
          }
          if (await sha256File(canonicalFinal) !== input.sha256) {
            throw new MediaArtifactIndexCommitError("not_committed");
          }
          const storageUri = pathToFileURL(canonicalFinal).href;
          const commitInTransaction = () => operations.transaction(async (tx) => {
            const existing = await operations.find(expected.internalId, claim.namespaceId, tx);
            if (existing) return { row: existing, created: false as const };
            const created = await operations.insert({
              internalId: expected.internalId,
              artifactId: expected.artifactId,
              path: expected.logicalPath,
              storageUri,
              mimeType: input.mimeType,
              size: input.size,
            }, tx);
            await operations.attach(created.id, claim.namespaceId, tx);
            return { row: created, created: true as const };
          });

          let row: Artifact;
          let freshlyCreated = false;
          try {
            const committed = await commitInTransaction();
            row = committed.row;
            freshlyCreated = committed.created;
          } catch {
            const replay = await operations.find(expected.internalId, claim.namespaceId, options.db).catch(() => null);
            const proof = replay && await validateExistingArtifact({
              claim, row: replay, root: options.artifactRoot, expectedMime: input.mimeType,
              expectedSize: input.size, expectedSha256: input.sha256, db: options.db, namespaces: operations.namespaces,
            });
            if (!proof) throw new MediaArtifactIndexCommitError("unknown");
            if (fileURLToPath(replay.storageUri) !== canonicalFinal) await fsp.rm(canonicalFinal, { force: true });
            (options.emitArtifactChanged ?? ((event) => eventBus.emit({ type: "workspace.artifact.changed", ...event })))(
              { id: replay.id, artifactId: replay.artifactId, path: replay.path },
            );
            return proof;
          }

          const proof = await validateExistingArtifact({
            claim, row, root: options.artifactRoot, expectedMime: input.mimeType,
            expectedSize: input.size, expectedSha256: input.sha256, db: options.db, namespaces: operations.namespaces,
          });
          if (!proof) throw new MediaArtifactIndexCommitError("unknown");
          if (freshlyCreated) {
            try {
              const humanCreator = claim.initiatingAgentId ? null
                : await (options.resolveHumanCreator ?? (async (current) => {
                  const [origin] = await options.db.select({ userId: videoGenerationLinks.actorUserId })
                    .from(videoGenerationLinks).where(and(
                      eq(videoGenerationLinks.receiptId, current.receiptId),
                      eq(videoGenerationLinks.ownerId, current.ownerId),
                      eq(videoGenerationLinks.roomId, current.roomId),
                      eq(videoGenerationLinks.namespaceId, current.namespaceId),
                    ));
                  return origin?.userId ?? null;
                }))(claim);
              const actor = claim.initiatingAgentId
                ? { kind: "agent" as const, agentId: claim.initiatingAgentId }
                : humanCreator ? { kind: "human" as const, userId: humanCreator } : null;
              if (actor) await emitWorkspaceArtifactCreatedFact({
                artifactInternalId: row.id, namespaceId: claim.namespaceId, actor,
                occurrenceKey: `media:${claim.receiptId}`,
              });
            } catch {
              try { warn("[media-generation] creation feed origin unavailable"); } catch { /* best effort */ }
            }
          }
          if (fileURLToPath(row.storageUri) !== canonicalFinal) await fsp.rm(canonicalFinal, { force: true });
          (options.emitArtifactChanged ?? ((event) => eventBus.emit({ type: "workspace.artifact.changed", ...event })))(
            { id: row.id, artifactId: row.artifactId, path: row.path },
          );
          return proof;
        },
      };
    },
  };
}

export interface MediaGenerationWorkerScheduler {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export function createMediaGenerationWorkerScheduler(input: {
  readonly runOnce: () => Promise<unknown>;
  readonly intervalMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly onError?: () => void;
}): MediaGenerationWorkerScheduler {
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250) throw new Error("media worker interval must be at least 250ms");
  const setTimer = input.setTimer ?? setTimeout;
  const clearTimer = input.clearTimer ?? clearTimeout;
  let active = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delayMs: number) => {
    if (!active) return;
    timer = setTimer(() => { void tick(); }, delayMs);
    timer.unref?.();
  };
  const tick = async () => {
    timer = null;
    if (!active || inFlight) return;
    inFlight = true;
    try {
      await input.runOnce();
    } catch {
      input.onError?.();
    } finally {
      inFlight = false;
      schedule(intervalMs);
    }
  };
  return {
    start() {
      if (active) return;
      active = true;
      schedule(0);
    },
    stop() {
      active = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    get running() { return active; },
  };
}

let installedWorker: MediaGenerationWorkerScheduler | null = null;

export interface InstallProductionMediaGenerationWorkerOptions {
  readonly resolveKey?: () => string | null;
  readonly db?: DirectDatabase;
  readonly artifactRoot?: string;
  readonly fetchImpl?: VeniceMediaFetch;
  readonly intervalMs?: number;
  readonly workerId?: string;
  readonly schedulerFactory?: typeof createMediaGenerationWorkerScheduler;
}

export function installProductionMediaGenerationWorker(
  options: InstallProductionMediaGenerationWorkerOptions = {},
): boolean {
  stopProductionMediaGenerationWorker();
  const apiKey = (options.resolveKey ?? (() => resolveProviderKey("venice")))()?.trim();
  if (!apiKey) return false;
  const db = options.db ?? getServerDirectDb();
  const artifactRoot = options.artifactRoot ?? getArtifactsRoot();
  const lifecycle = new VeniceMediaLifecycleAdapter({
    apiKey,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    signedDeliveryAllowedHosts: [],
  });
  const reconciler = new MediaGenerationReconciler({
    repository: createProductionMediaGenerationWorkerRepository(db),
    lifecycle,
    artifacts: createProductionMediaArtifactCustody({ db, artifactRoot }),
    serverArtifactRoot: artifactRoot,
    maxBytesFor(claim) {
      return MEDIA_GENERATION_MAX_BYTES[claim.providerModel as VeniceMediaModel] ?? 1;
    },
  });
  const workerId = options.workerId ?? `media-${randomUUID()}`;
  installedWorker = (options.schedulerFactory ?? createMediaGenerationWorkerScheduler)({
    runOnce: async () => {
      await reconciler.runOnce({ workerId, batch: DEFAULT_BATCH });
      await deliverProductionMediaGenerationCompletionWakes({ db });
    },
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    onError: () => warn("[media-generation] reconciliation pass failed; the durable receipt will be retried"),
  });
  installedWorker.start();
  return true;
}

export function stopProductionMediaGenerationWorker(): void {
  installedWorker?.stop();
  installedWorker = null;
}
