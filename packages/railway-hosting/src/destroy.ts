import {
  parseLaunchReceipt,
  validateLaunchReceiptTransition,
  type HostingNotice,
  type HostingResourceReference,
  type LaunchReceipt,
} from "@nautilo/hosting";

import type { RailwayProject } from "./operations";

const PROJECT_KIND = "railway.project";
const SERVICE_KIND = "railway.service";
const VOLUME_KIND = "railway.volume";
const DOMAIN_KIND = "railway.domain";

export const RAILWAY_DESTROY_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export type RailwayDestroyStage =
  | "validate"
  | "confirm"
  | "checkpoint"
  | "domain"
  | "volume"
  | "service"
  | "project"
  | "verify-project-absent"
  | "verify-resources-absent";

export type RailwayDestroyAction = "domain-delete" | "volume-delete" | "service-delete" | "project-delete";

/** Non-secret durable before-effect state for a delete issued by exact ID. */
export interface RailwayDestroyCheckpoint {
  readonly schemaVersion: typeof RAILWAY_DESTROY_CHECKPOINT_SCHEMA_VERSION;
  readonly receipt: LaunchReceipt;
  readonly stage: RailwayDestroyStage;
  readonly pending?: {
    readonly action: RailwayDestroyAction;
    readonly resource: HostingResourceReference;
  } | undefined;
}

/**
 * Inventory is ID-only. Names are intentionally absent so neither cleanup nor
 * recovery can adopt another project resource by a coincidental logical name.
 */
export interface RailwayDestroyInventoryEntry {
  readonly kind: string;
  readonly id: string;
}

export interface RailwayDestroyExecutor {
  readonly deleteDomain: (input: { readonly domainId: string }) => Promise<void>;
  readonly deleteVolume: (input: { readonly volumeId: string }) => Promise<void>;
  readonly deleteService: (input: { readonly serviceId: string; readonly environmentId?: string | undefined }) => Promise<void>;
  readonly deleteProject: (input: { readonly projectId: string }) => Promise<void>;
  /** Exact-ID observation used for asynchronous Railway project deletion. */
  readonly getProject: (input: { readonly projectId: string }) => Promise<RailwayProject | null>;
  /**
   * Complete billable child inventory immediately before project delete. The
   * implementation must not hide unknown project children: they stop cleanup.
   */
  readonly inventoryProjectResources: (input: { readonly projectId: string }) => Promise<readonly RailwayDestroyInventoryEntry[]>;
  /** Exact receipt IDs only; its absence result drives final verification. */
  readonly inventoryReceiptResources: (input: {
    readonly projectId: string;
    readonly resources: readonly HostingResourceReference[];
  }) => Promise<readonly RailwayDestroyInventoryEntry[]>;
}

/** Bounded by the caller; this module deliberately supplies neither sleep nor retry timing. */
export interface RailwayDestroyPollPolicy {
  readonly maxAttempts: number;
  readonly beforeAttempt?: (input: { readonly attempt: number }) => Promise<void>;
}

export interface RailwayDestroyRequest {
  readonly checkpoint: RailwayDestroyCheckpoint;
  /** Explicit confirmation must match the receipt's project ID byte-for-byte. */
  readonly confirmProjectId: string;
  readonly executor: RailwayDestroyExecutor;
  readonly poll: RailwayDestroyPollPolicy;
  readonly now: () => string;
  readonly persistCheckpoint: (checkpoint: RailwayDestroyCheckpoint) => Promise<void>;
}

export type RailwayDestroyFailureCode =
  | "invalid-checkpoint"
  | "confirmation-required"
  | "persistence-failure"
  | "executor-failure"
  | "unknown-project-resource"
  | "identity-mismatch"
  | "receipt-resource-survives";

export type RailwayDestroyResult =
  | { readonly outcome: "complete"; readonly checkpoint: RailwayDestroyCheckpoint }
  | { readonly outcome: "pending"; readonly stage: "verify-project-absent"; readonly checkpoint: RailwayDestroyCheckpoint; readonly notices: readonly HostingNotice[] }
  | { readonly outcome: "failure"; readonly stage: RailwayDestroyStage; readonly code: RailwayDestroyFailureCode; readonly checkpoint: RailwayDestroyCheckpoint; readonly remainingResources: readonly HostingResourceReference[]; readonly notices: readonly HostingNotice[] };

function project(receipt: LaunchReceipt): HostingResourceReference | undefined {
  const projects = receipt.resources.filter((resource) => resource.kind === PROJECT_KIND);
  return projects.length === 1 ? projects[0] : undefined;
}

function environmentId(receipt: LaunchReceipt): string | undefined {
  const environments = receipt.resources.filter((resource) => resource.kind === "railway.environment");
  return environments.length === 1 ? environments[0]!.id : undefined;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
export function isRailwayDestroyCheckpoint(
  value: unknown,
  expectedReceipt?: LaunchReceipt,
): value is RailwayDestroyCheckpoint {
  if (!isPlain(value) || !exactKeys(value, ["schemaVersion", "receipt", "stage", ...(value["pending"] === undefined ? [] : ["pending"])])) return false;
  if (value["schemaVersion"] !== RAILWAY_DESTROY_CHECKPOINT_SCHEMA_VERSION
    || !(["validate", "confirm", "checkpoint", "domain", "volume", "service", "project", "verify-project-absent", "verify-resources-absent"] as const).includes(value["stage"] as RailwayDestroyStage)) return false;
  const parsed = parseLaunchReceipt(value["receipt"]);
  if (!parsed.ok || parsed.receipt.backend !== "railway") return false;
  if (project(parsed.receipt) === undefined
    && !(parsed.receipt.cleanup.state === "verified" && parsed.receipt.resources.length === 0)) return false;
  if (expectedReceipt !== undefined) {
    const expected = parseLaunchReceipt(expectedReceipt);
    if (!expected.ok || expected.receipt.backend !== "railway"
      || parsed.receipt.launchId !== expected.receipt.launchId
      || parsed.receipt.createdAt !== expected.receipt.createdAt
      || parsed.receipt.resources.some((resource) => !expected.receipt.resources.some((candidate) =>
        candidate.kind === resource.kind && candidate.id === resource.id && candidate.name === resource.name))) return false;
  }
  if (!Number.isSafeInteger(parsed.receipt.revision)) return false;
  if (value["pending"] === undefined) return true;
  if (!isPlain(value["pending"]) || !exactKeys(value["pending"], ["action", "resource"]) || !isPlain(value["pending"]["resource"])
    || !exactKeys(value["pending"]["resource"], ["kind", "id", "name"])) return false;
  const pending = value["pending"] as unknown as RailwayDestroyCheckpoint["pending"];
  if (pending === undefined || actionFor(pending.resource) !== pending.action || stageFor(pending.action) !== value["stage"]) return false;
  return parsed.receipt.resources.some((resource) => resource.kind === pending.resource.kind && resource.id === pending.resource.id);
}
export function isRailwayDestroyCheckpointTransition(
  before: RailwayDestroyCheckpoint,
  after: RailwayDestroyCheckpoint,
): boolean {
  if (!isRailwayDestroyCheckpoint(before) || !isRailwayDestroyCheckpoint(after)) return false;
  if (before.receipt.launchId !== after.receipt.launchId || before.receipt.backend !== after.receipt.backend) return false;
  if (!validateLaunchReceiptTransition(before.receipt, after.receipt).ok) return false;
  if (before.pending !== undefined) {
    const samePending = JSON.stringify(before.pending) === JSON.stringify(after.pending);
    const removed = after.pending === undefined && !after.receipt.resources.some((resource) =>
      resource.kind === before.pending!.resource.kind && resource.id === before.pending!.resource.id);
    if (!samePending && !removed) return false;
  }
  if (before.receipt.cleanup.state === "verified") return false;
  return true;
}
function isValidCheckpoint(checkpoint: RailwayDestroyCheckpoint): boolean {
  return isRailwayDestroyCheckpoint(checkpoint) && checkpoint.receipt.cleanup.state !== "verified"
    && project(checkpoint.receipt) !== undefined;
}

function notice(code: HostingNotice["code"], message: string, resources?: readonly HostingResourceReference[]): HostingNotice {
  return {
    severity: code === "hosting.confirmation-required" || code === "hosting.receipt-action-required" ? "blocking" : "error",
    code,
    message,
    ...(resources === undefined ? {} : { resources }),
    repairTarget: { kind: "authenticated-provider-api" },
  };
}

function remaining(checkpoint: RailwayDestroyCheckpoint): readonly HostingResourceReference[] {
  return checkpoint.receipt.resources;
}

function receiptUpdate(
  request: RailwayDestroyRequest,
  checkpoint: RailwayDestroyCheckpoint,
  stage: RailwayDestroyStage,
  input: {
    readonly cleanup: LaunchReceipt["cleanup"];
    readonly resources?: readonly HostingResourceReference[] | undefined;
    readonly pending?: RailwayDestroyCheckpoint["pending"] | undefined;
  },
): RailwayDestroyCheckpoint {
  return {
    schemaVersion: RAILWAY_DESTROY_CHECKPOINT_SCHEMA_VERSION,
    stage,
    ...(input.pending === undefined ? {} : { pending: input.pending }),
    receipt: {
      ...checkpoint.receipt,
      revision: checkpoint.receipt.revision + 1,
      updatedAt: request.now(),
      cleanup: input.cleanup,
      ...(input.resources === undefined ? {} : { resources: input.resources }),
    },
  };
}

async function persist(
  request: RailwayDestroyRequest,
  checkpoint: RailwayDestroyCheckpoint,
): Promise<boolean> {
  try {
    await request.persistCheckpoint(checkpoint);
    return true;
  } catch {
    return false;
  }
}

async function failure(
  request: RailwayDestroyRequest,
  stage: RailwayDestroyStage,
  code: RailwayDestroyFailureCode,
  checkpoint: RailwayDestroyCheckpoint,
  message: string,
): Promise<RailwayDestroyResult> {
  // Mark a persisted cleanup as failed when possible. A caller can resume it by
  // transitioning that exact receipt from failed to in-progress.
  // Validation and confirmation failures happen before cleanup begins and must
  // not alter a receipt or make an unconfirmed destroy look started.
  const mayPersistFailure = code !== "invalid-checkpoint" && code !== "confirmation-required"
    && checkpoint.receipt.cleanup.state !== "not-required";
  const failed = !mayPersistFailure || checkpoint.receipt.cleanup.state === "failed"
    ? checkpoint
    : receiptUpdate(request, checkpoint, stage, { cleanup: { state: "failed" }, pending: checkpoint.pending });
  const durable = failed === checkpoint || await persist(request, failed);
  const finalCheckpoint = durable ? failed : checkpoint;
  return {
    outcome: "failure",
    stage,
    code: durable ? code : "persistence-failure",
    checkpoint: finalCheckpoint,
    remainingResources: remaining(finalCheckpoint),
    notices: [notice(code === "confirmation-required" ? "hosting.confirmation-required" : "hosting.operation-failed", message, remaining(finalCheckpoint))],
  };
}

function actionFor(resource: HostingResourceReference): RailwayDestroyAction | undefined {
  if (resource.kind === DOMAIN_KIND) return "domain-delete";
  if (resource.kind === VOLUME_KIND) return "volume-delete";
  if (resource.kind === SERVICE_KIND) return "service-delete";
  if (resource.kind === PROJECT_KIND) return "project-delete";
  return undefined;
}

function stageFor(action: RailwayDestroyAction): RailwayDestroyStage {
  return action === "domain-delete" ? "domain" : action === "volume-delete" ? "volume" : action === "service-delete" ? "service" : "project";
}

function order(resources: readonly HostingResourceReference[]): readonly HostingResourceReference[] {
  // Mounted volumes cannot be deleted while their services still exist.
  const kinds = [DOMAIN_KIND, SERVICE_KIND, VOLUME_KIND, PROJECT_KIND];
  return kinds.flatMap((kind) => resources.filter((resource) => resource.kind === kind));
}

function same(reference: RailwayDestroyInventoryEntry, resource: HostingResourceReference): boolean {
  return reference.kind === resource.kind && reference.id === resource.id;
}

async function projectContainsOnlyReceiptResources(
  request: RailwayDestroyRequest,
  projectId: string,
  receipt: LaunchReceipt,
): Promise<"safe" | "unsafe" | "failure"> {
  try {
    const inventory = await request.executor.inventoryProjectResources({ projectId });
    return inventory.every((entry) => receipt.resources.some((resource) => same(entry, resource))) ? "safe" : "unsafe";
  } catch {
    return "failure";
  }
}

async function receiptResourcesAreAbsent(
  request: RailwayDestroyRequest,
  projectId: string,
  receipt: LaunchReceipt,
): Promise<readonly RailwayDestroyInventoryEntry[] | null> {
  try {
    return await request.executor.inventoryReceiptResources({ projectId, resources: receipt.resources });
  } catch {
    return null;
  }
}

async function waitForResourceAbsent(
  request: RailwayDestroyRequest,
  projectId: string,
  receipt: LaunchReceipt,
  target: HostingResourceReference,
): Promise<"absent" | "survives" | "failure"> {
  for (let attempt = 1; attempt <= request.poll.maxAttempts; attempt += 1) {
    if (attempt > 1 && request.poll.beforeAttempt !== undefined) {
      try { await request.poll.beforeAttempt({ attempt }); }
      catch { return "failure"; }
    }
    const survivors = await receiptResourcesAreAbsent(request, projectId, receipt);
    if (survivors === null) return "failure";
    if (!survivors.some((entry) => same(entry, target))) return "absent";
  }
  return "survives";
}

async function deleteExact(
  request: RailwayDestroyRequest,
  action: RailwayDestroyAction,
  resource: HostingResourceReference,
  environment: string | undefined,
): Promise<void> {
  if (action === "domain-delete") return request.executor.deleteDomain({ domainId: resource.id });
  if (action === "volume-delete") return request.executor.deleteVolume({ volumeId: resource.id });
  if (action === "service-delete") return request.executor.deleteService({ serviceId: resource.id, ...(environment === undefined ? {} : { environmentId: environment }) });
  return request.executor.deleteProject({ projectId: resource.id });
}

/**
 * Deletes only exact receipt IDs. A failed or interrupted run preserves a
 * before-effect checkpoint and never performs name-based recovery. Railway's
 * project deletion can be asynchronous; bounded caller policy returns pending
 * instead of assuming an accepted mutation has completed.
 */
export async function destroyRailwayDeployment(request: RailwayDestroyRequest): Promise<RailwayDestroyResult> {
  let checkpoint = request.checkpoint;
  if (!isValidCheckpoint(checkpoint)) {
    return failure(request, "validate", "invalid-checkpoint", checkpoint, "The Railway destroy checkpoint is invalid.");
  }
  const initialProject = project(checkpoint.receipt)!;
  if (request.confirmProjectId !== initialProject.id) {
    return failure(request, "confirm", "confirmation-required", checkpoint, "Destroy requires the exact Railway project ID from the launch receipt.");
  }
  if (!Number.isSafeInteger(request.poll.maxAttempts) || request.poll.maxAttempts < 1) {
    return failure(request, "validate", "invalid-checkpoint", checkpoint, "Destroy requires a positive bounded project-observation policy.");
  }

  // The complete project inventory is a billing fence, not merely a final
  // project-delete guard. Re-run it on every resume before the first provider
  // deletion so an interrupted preflight can never be mistaken for proof.
  const preflight = await projectContainsOnlyReceiptResources(request, initialProject.id, checkpoint.receipt);
  if (preflight === "failure") {
    return failure(request, "validate", "executor-failure", checkpoint, "Receipt ownership could not be inventoried before cleanup.");
  }
  if (preflight === "unsafe") {
    return failure(request, "validate", "unknown-project-resource", checkpoint, "Cleanup stopped because the project contains a resource absent from the launch receipt.");
  }

  if (checkpoint.receipt.cleanup.state === "not-required") {
    const pending = receiptUpdate(request, checkpoint, "checkpoint", { cleanup: { state: "pending" } });
    if (!await persist(request, pending)) return failure(request, "checkpoint", "persistence-failure", checkpoint, "Destroy progress could not be checkpointed safely.");
    checkpoint = pending;
  }
  if (checkpoint.receipt.cleanup.state === "pending" || checkpoint.receipt.cleanup.state === "failed") {
    // A failed checkpoint can retain the durable before-effect delete intent.
    // Its stage must remain causally compatible with that pending action;
    // `checkpoint` is valid only when there is no action-specific pending
    // effect to resume.
    const resumeStage = checkpoint.pending === undefined ? "checkpoint" : stageFor(checkpoint.pending.action);
    const started = receiptUpdate(request, checkpoint, resumeStage, { cleanup: { state: "in-progress" }, pending: checkpoint.pending });
    if (!await persist(request, started)) return failure(request, "checkpoint", "persistence-failure", checkpoint, "Destroy progress could not be checkpointed safely.");
    checkpoint = started;
  }

  const environment = environmentId(checkpoint.receipt);
  for (;;) {
    const target = checkpoint.pending?.resource ?? order(checkpoint.receipt.resources).find((resource) => actionFor(resource) !== undefined);
    if (target === undefined) break;
    const action = checkpoint.pending?.action ?? actionFor(target)!;
    const stage = stageFor(action);

    if (action === "project-delete") {
      const safety = await projectContainsOnlyReceiptResources(request, target.id, checkpoint.receipt);
      if (safety === "failure") return failure(request, stage, "executor-failure", checkpoint, "Receipt ownership could not be inventoried before project deletion.");
      if (safety === "unsafe") return failure(request, stage, "unknown-project-resource", checkpoint, "Project deletion stopped because the project contains a resource absent from the launch receipt.");
    }

    if (checkpoint.pending === undefined) {
      const before = receiptUpdate(request, checkpoint, stage, {
        cleanup: { state: "in-progress" },
        pending: { action, resource: target },
      });
      if (!await persist(request, before)) return failure(request, stage, "persistence-failure", checkpoint, "Destroy progress could not be checkpointed safely.");
      checkpoint = before;
    }

    try {
      await deleteExact(request, action, target, environment);
    } catch {
      // A provider may report an already-absent ID as an error. Final exact-ID
      // inventory below decides whether it is actually clean before retrying.
    }

    if (action === "project-delete") break;
    const absence = await waitForResourceAbsent(request, initialProject.id, checkpoint.receipt, target);
    if (absence === "failure") return failure(request, stage, "executor-failure", checkpoint, "Receipt ownership could not be verified after deletion.");
    if (absence === "survives") {
      return failure(request, stage, "receipt-resource-survives", checkpoint, "The receipt-owned resource still exists after Railway accepted deletion.");
    }
    const next = receiptUpdate(request, checkpoint, stage, {
      cleanup: { state: "in-progress" },
      resources: checkpoint.receipt.resources.filter((resource) => !(resource.kind === target.kind && resource.id === target.id)),
    });
    if (!await persist(request, next)) return failure(request, stage, "persistence-failure", checkpoint, "Delete completion could not be checkpointed safely.");
    checkpoint = next;
  }

  for (let attempt = 1; attempt <= request.poll.maxAttempts; attempt += 1) {
    if (attempt > 1 && request.poll.beforeAttempt !== undefined) {
      try { await request.poll.beforeAttempt({ attempt }); }
      catch { return failure(request, "verify-project-absent", "executor-failure", checkpoint, "Destroy polling could not continue safely."); }
    }
    let observed: RailwayProject | null;
    try { observed = await request.executor.getProject({ projectId: initialProject.id }); }
    catch { return failure(request, "verify-project-absent", "executor-failure", checkpoint, "Railway project absence could not be observed safely."); }
    if (observed === null) {
      const survivors = await receiptResourcesAreAbsent(request, initialProject.id, checkpoint.receipt);
      if (survivors === null) return failure(request, "verify-resources-absent", "executor-failure", checkpoint, "Receipt resource absence could not be verified safely.");
      if (survivors.length > 0) return failure(request, "verify-resources-absent", "receipt-resource-survives", checkpoint, "A receipt-owned Railway resource survives project deletion.");
      const verified = receiptUpdate(request, checkpoint, "verify-resources-absent", {
        cleanup: { state: "verified", verifiedAt: request.now() },
        resources: [],
      });
      if (!await persist(request, verified)) return failure(request, "verify-resources-absent", "persistence-failure", checkpoint, "Verified destroy completion could not be checkpointed safely.");
      return { outcome: "complete", checkpoint: verified };
    }
    if (observed.id !== initialProject.id) return failure(request, "verify-project-absent", "identity-mismatch", checkpoint, "Railway returned a project different from the receipt-owned ID.");
  }

  return {
    outcome: "pending",
    stage: "verify-project-absent",
    checkpoint,
    notices: [notice("hosting.resources-retained", "Railway accepted project deletion but the exact project ID is still present; retry observation with the same receipt.", remaining(checkpoint))],
  };
}
