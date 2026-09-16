import { parseLaunchReceipt, type HostingResourceReference, type LaunchReceipt } from "@nautilo/hosting";

import type {
  RailwayReconcileCheckpoint,
  RailwayReconcileDesiredState,
  RailwayReconcileEffectKind,
  RailwayReconcileFailureCode,
  RailwayReconcileRequest,
  RailwayReconcileResult,
  RailwayReconcileStage,
  RailwayReconcileSurvivingResource,
} from "./reconcile-types";

const PROJECT_KIND = "railway.project";
const ENVIRONMENT_KIND = "railway.environment";
const SERVICE_KIND = "railway.service";
const VOLUME_KIND = "railway.volume";
const VARIABLES_KIND = "railway.variable-collection";
const SERVICE_IMAGE_KIND = "railway.service-image";
const DOMAIN_KIND = "railway.domain";
const DEPLOYMENT_KIND = "railway.deployment";

function resource(kind: string, id: string, name: string): HostingResourceReference {
  return { kind, id, name };
}

function known(receipt: LaunchReceipt, kind: string, name: string): HostingResourceReference | undefined {
  return receipt.resources.find((candidate) => candidate.kind === kind && candidate.name === name);
}

/**
 * Railway accepts image references, including mutable tags.  A reconciliation
 * receipt needs an immutable statement that can be observed again after a
 * response loss, so the driver accepts only a SHA-256 digest reference.  A
 * registry port is valid before a slash; a tag on the final path segment is
 * deliberately rejected even when accompanied by a digest.
 */
function isDigestImageReference(value: string): boolean {
  if (/\s/.test(value)) return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [repository, digest] = parts;
  if (!repository || !digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) return false;
  const lastSegment = repository.slice(repository.lastIndexOf("/") + 1);
  return lastSegment.length > 0 && !lastSegment.includes(":");
}

function hasExactImageSource(
  observed: { readonly serviceId: string; readonly environmentId: string; readonly source?: { readonly image?: string | null | undefined; readonly repo?: string | null | undefined } | null | undefined } | null,
  serviceId: string,
  environmentId: string,
  image: string,
): boolean {
  const source = observed?.source;
  return observed !== null
    && observed.serviceId === serviceId
    && observed.environmentId === environmentId
    && source?.image === image
    && (source.repo === null || source.repo === undefined);
}

function hasExactRuntimeIntent(
  observed: ({
    readonly serviceId: string;
    readonly environmentId: string;
    readonly source?: { readonly image?: string | null | undefined; readonly repo?: string | null | undefined } | null | undefined;
    readonly startCommand?: string | null | undefined;
  } | null),
  serviceId: string,
  environmentId: string,
  image: string,
  startCommand: string | undefined,
): boolean {
  return hasExactImageSource(observed, serviceId, environmentId, image)
    && (observed?.startCommand ?? undefined) === startCommand;
}

function hasNoSource(
  observed: { readonly source?: { readonly image?: string | null | undefined; readonly repo?: string | null | undefined } | null | undefined } | null,
): boolean {
  const source = observed?.source;
  return observed !== null
    && (source === null || source === undefined
      || ((source.image === null || source.image === undefined)
        && (source.repo === null || source.repo === undefined)));
}

function saneDesired(desired: RailwayReconcileDesiredState): boolean {
  const nonEmpty = (value: string): boolean => value.length > 0;
  const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
  return nonEmpty(desired.project.name)
    && nonEmpty(desired.project.workspaceId)
    && nonEmpty(desired.environment.name)
    && unique(desired.services.map((service) => service.name))
    && unique(desired.volumes.map((volume) => volume.logicalName))
    && unique(desired.domains.map((domain) => domain.logicalName))
    && desired.services.every((service) => nonEmpty(service.name)
      && (service.image === undefined || isDigestImageReference(service.image))
      && (service.startCommand === undefined || service.startCommand.trim().length > 0)
      && (!service.deploy || service.image !== undefined))
    && desired.volumes.every((volume) => nonEmpty(volume.logicalName)
      && nonEmpty(volume.service) && nonEmpty(volume.mountPath))
    && desired.domains.every((domain) => nonEmpty(domain.logicalName)
      && nonEmpty(domain.service) && Number.isSafeInteger(domain.targetPort) && domain.targetPort > 0);
}

function validCheckpoint(checkpoint: RailwayReconcileCheckpoint): boolean {
  const receipt = checkpoint.receipt;
  const pending = checkpoint.pending;
  return receipt.backend === "railway"
    && parseLaunchReceipt(receipt).ok
    && receipt.stage !== "planned"
    && receipt.cleanup.state === "not-required"
    && (pending === undefined || (
      pending.logicalName.length > 0
      && (pending.kind === "service-connect"
        ? isDigestImageReference(pending.image ?? "")
        : pending.image === undefined)
      && (pending.kind === "project-create"
        ? pending.attempt === undefined || pending.attempt === 1 || pending.attempt === 2
        : pending.attempt === undefined)
    ));
}

function projectId(checkpoint: RailwayReconcileCheckpoint): string | undefined {
  return known(checkpoint.receipt, PROJECT_KIND, checkpoint.receipt.resources.find((entry) => entry.kind === PROJECT_KIND)?.name ?? "")?.id;
}

function environmentId(checkpoint: RailwayReconcileCheckpoint): string | undefined {
  return checkpoint.receipt.resources.find((entry) => entry.kind === ENVIRONMENT_KIND)?.id;
}

function hasPending(checkpoint: RailwayReconcileCheckpoint, kind: RailwayReconcileEffectKind, logicalName: string): boolean {
  return checkpoint.pending?.kind === kind && checkpoint.pending.logicalName === logicalName;
}

async function persist(
  request: RailwayReconcileRequest,
  checkpoint: RailwayReconcileCheckpoint,
): Promise<boolean> {
  try {
    await request.persistCheckpoint(checkpoint);
    return true;
  } catch {
    return false;
  }
}

async function failure(
  request: RailwayReconcileRequest,
  stage: RailwayReconcileStage,
  code: RailwayReconcileFailureCode,
  checkpoint: RailwayReconcileCheckpoint,
): Promise<RailwayReconcileResult> {
  let survivors: readonly RailwayReconcileSurvivingResource[] = [];
  try {
    survivors = await request.executor.inventorySurvivors({
      ...(projectId(checkpoint) === undefined ? {} : { projectId: projectId(checkpoint) }),
      ...(environmentId(checkpoint) === undefined ? {} : { environmentId: environmentId(checkpoint) }),
    });
  } catch {
    // A provider error message is deliberately never carried into a result.
  }
  return { outcome: "failure", stage, code, checkpoint, survivingResources: survivors };
}

function withResource(
  request: RailwayReconcileRequest,
  checkpoint: RailwayReconcileCheckpoint,
  next: HostingResourceReference,
): RailwayReconcileCheckpoint {
  const existing = checkpoint.receipt.resources.find((entry) => entry.kind === next.kind && entry.name === next.name);
  const resources = existing === undefined
    ? [...checkpoint.receipt.resources, next]
    : checkpoint.receipt.resources;
  return {
    receipt: {
      ...checkpoint.receipt,
      revision: checkpoint.receipt.revision + 1,
      stage: checkpoint.receipt.stage === "authorized" ? "provisioning" : checkpoint.receipt.stage,
      resources,
      updatedAt: request.now(),
    },
  };
}

async function beginEffect(
  request: RailwayReconcileRequest,
  checkpoint: RailwayReconcileCheckpoint,
  kind: RailwayReconcileEffectKind,
  logicalName: string,
): Promise<RailwayReconcileCheckpoint | null> {
  const pending: RailwayReconcileCheckpoint = {
    ...checkpoint,
    pending: { kind, logicalName, ...(kind === "project-create" ? { attempt: 1 as const } : {}) },
  };
  return await persist(request, pending) ? pending : null;
}

async function beginServiceConnect(
  request: RailwayReconcileRequest,
  checkpoint: RailwayReconcileCheckpoint,
  logicalName: string,
  image: string,
): Promise<RailwayReconcileCheckpoint | null> {
  const pending: RailwayReconcileCheckpoint = {
    ...checkpoint,
    pending: { kind: "service-connect", logicalName, image },
  };
  return await persist(request, pending) ? pending : null;
}

async function finishResource(
  request: RailwayReconcileRequest,
  checkpoint: RailwayReconcileCheckpoint,
  next: HostingResourceReference,
): Promise<RailwayReconcileCheckpoint | null> {
  const finished = withResource(request, checkpoint, next);
  return await persist(request, finished) ? finished : null;
}

function exactlyOne<T>(items: readonly T[]): T | "none" | "ambiguous" {
  return items.length === 0 ? "none" : items.length === 1 ? items[0]! : "ambiguous";
}

/**
 * Walking, receipt-backed resource reconciliation. Every mutation gets a
 * durable before-effect intent and a durable exact provider ID afterward.
 * When a pending non-idempotent effect cannot be uniquely recovered, it stops
 * instead of issuing a second create. Variable upsert is the sole idempotent
 * exception and is retried at its exact scoped collection identity.
 */
export async function reconcileRailwayResources(
  request: RailwayReconcileRequest,
): Promise<RailwayReconcileResult> {
  let checkpoint = request.checkpoint;
  if (!validCheckpoint(checkpoint)) return failure(request, "validate", "invalid-checkpoint", checkpoint);
  if (!saneDesired(request.desired)) return failure(request, "validate", "invalid-desired-state", checkpoint);

  const desired = request.desired;
  const pendingUnexpected = (kind: RailwayReconcileEffectKind, logicalName: string): boolean => (
    checkpoint.pending !== undefined && !hasPending(checkpoint, kind, logicalName)
  );

  // Project
  let project = known(checkpoint.receipt, PROJECT_KIND, desired.project.name);
  if (project) {
    try {
      const observed = await request.executor.getProject({ projectId: project.id });
      if (!observed || observed.id !== project.id || observed.name !== desired.project.name || observed.workspaceId !== desired.project.workspaceId) {
        return failure(request, "project", "identity-mismatch", checkpoint);
      }
    } catch { return failure(request, "project", "executor-failure", checkpoint); }
  } else {
    if (pendingUnexpected("project-create", desired.project.name)) return failure(request, "project", "recovery-required", checkpoint);
    let matches;
    try { matches = (await request.executor.listProjects({ workspaceId: desired.project.workspaceId })).filter((item) => item.name === desired.project.name); }
    catch { return failure(request, "project", "executor-failure", checkpoint); }
    const recovered = exactlyOne(matches);
    if (recovered === "ambiguous") return failure(request, "project", "ambiguous-resource", checkpoint);
    if (hasPending(checkpoint, "project-create", desired.project.name)) {
      if (recovered === "none") {
        const attempt = checkpoint.pending?.attempt ?? 1;
        if (request.retryAbsentProjectCreate !== true || attempt !== 1) {
          return failure(request, "project", "recovery-required", checkpoint);
        }
        const retry: RailwayReconcileCheckpoint = {
          ...checkpoint,
          pending: { kind: "project-create", logicalName: desired.project.name, attempt: 2 },
        };
        if (!await persist(request, retry)) return failure(request, "project", "persistence-failure", checkpoint);
        checkpoint = retry;
        let created;
        try { created = await request.executor.createProject(desired.project); }
        catch { return failure(request, "project", "executor-failure", checkpoint); }
        if (created.name !== desired.project.name || created.workspaceId !== desired.project.workspaceId) {
          return failure(request, "project", "identity-mismatch", checkpoint);
        }
        const next = withResource(request, checkpoint, resource(PROJECT_KIND, created.id, desired.project.name));
        if (!await persist(request, next)) return failure(request, "project", "persistence-failure", next);
        checkpoint = next; project = known(checkpoint.receipt, PROJECT_KIND, desired.project.name)!;
      } else {
        const finished = await finishResource(request, checkpoint, resource(PROJECT_KIND, recovered.id, desired.project.name));
        if (!finished) return failure(request, "project", "persistence-failure", withResource(request, checkpoint, resource(PROJECT_KIND, recovered.id, desired.project.name)));
        checkpoint = finished; project = known(checkpoint.receipt, PROJECT_KIND, desired.project.name)!;
      }
    } else if (recovered !== "none") {
      const finished = await finishResource(request, checkpoint, resource(PROJECT_KIND, recovered.id, desired.project.name));
      if (!finished) return failure(request, "project", "persistence-failure", withResource(request, checkpoint, resource(PROJECT_KIND, recovered.id, desired.project.name)));
      checkpoint = finished; project = known(checkpoint.receipt, PROJECT_KIND, desired.project.name)!;
    } else {
      const before = await beginEffect(request, checkpoint, "project-create", desired.project.name);
      if (!before) return failure(request, "project", "persistence-failure", checkpoint);
      checkpoint = before;
      let created;
      try { created = await request.executor.createProject(desired.project); }
      catch { return failure(request, "project", "executor-failure", checkpoint); }
      if (created.name !== desired.project.name || created.workspaceId !== desired.project.workspaceId) return failure(request, "project", "identity-mismatch", checkpoint);
      const next = withResource(request, checkpoint, resource(PROJECT_KIND, created.id, desired.project.name));
      if (!await persist(request, next)) return failure(request, "project", "persistence-failure", next);
      checkpoint = next; project = known(checkpoint.receipt, PROJECT_KIND, desired.project.name)!;
    }
  }

  // Environment
  let environment = known(checkpoint.receipt, ENVIRONMENT_KIND, desired.environment.name);
  if (environment) {
    try {
      const observed = await request.executor.getEnvironment({ projectId: project.id, environmentId: environment.id });
      if (!observed || observed.id !== environment.id || observed.name !== desired.environment.name) return failure(request, "environment", "identity-mismatch", checkpoint);
    } catch { return failure(request, "environment", "executor-failure", checkpoint); }
  } else {
    if (pendingUnexpected("environment-create", desired.environment.name)) return failure(request, "environment", "recovery-required", checkpoint);
    let matches;
    try { matches = (await request.executor.listEnvironments({ projectId: project.id })).filter((item) => item.name === desired.environment.name); }
    catch { return failure(request, "environment", "executor-failure", checkpoint); }
    const recovered = exactlyOne(matches);
    if (recovered === "ambiguous") return failure(request, "environment", "ambiguous-resource", checkpoint);
    if (hasPending(checkpoint, "environment-create", desired.environment.name) && recovered === "none") return failure(request, "environment", "recovery-required", checkpoint);
    if (recovered !== "none") {
      const next = withResource(request, checkpoint, resource(ENVIRONMENT_KIND, recovered.id, desired.environment.name));
      if (!await persist(request, next)) return failure(request, "environment", "persistence-failure", next);
      checkpoint = next; environment = known(checkpoint.receipt, ENVIRONMENT_KIND, desired.environment.name)!;
    } else {
      const before = await beginEffect(request, checkpoint, "environment-create", desired.environment.name);
      if (!before) return failure(request, "environment", "persistence-failure", checkpoint);
      checkpoint = before;
      let created;
      try { created = await request.executor.createEnvironment({ projectId: project.id, name: desired.environment.name }); }
      catch { return failure(request, "environment", "executor-failure", checkpoint); }
      if (created.name !== desired.environment.name) return failure(request, "environment", "identity-mismatch", checkpoint);
      const next = withResource(request, checkpoint, resource(ENVIRONMENT_KIND, created.id, desired.environment.name));
      if (!await persist(request, next)) return failure(request, "environment", "persistence-failure", next);
      checkpoint = next; environment = known(checkpoint.receipt, ENVIRONMENT_KIND, desired.environment.name)!;
    }
  }

  const services = new Map<string, string>();
  for (const intent of desired.services) {
    let entry = known(checkpoint.receipt, SERVICE_KIND, intent.name);
    if (entry) {
      const recorded = entry;
      try {
        const observed = await request.executor.listServices({ projectId: project.id });
        if (!observed.some((service) => service.id === recorded.id && service.name === intent.name)) {
          return failure(request, "service", "identity-mismatch", checkpoint);
        }
      } catch { return failure(request, "service", "executor-failure", checkpoint); }
    } else {
      if (pendingUnexpected("service-create", intent.name)) return failure(request, "service", "recovery-required", checkpoint);
      let matches;
      try { matches = (await request.executor.listServices({ projectId: project.id })).filter((item) => item.name === intent.name); }
      catch { return failure(request, "service", "executor-failure", checkpoint); }
      const recovered = exactlyOne(matches);
      if (recovered === "ambiguous") return failure(request, "service", "ambiguous-resource", checkpoint);
      if (hasPending(checkpoint, "service-create", intent.name) && recovered === "none") return failure(request, "service", "recovery-required", checkpoint);
      if (recovered !== "none") {
        const next = withResource(request, checkpoint, resource(SERVICE_KIND, recovered.id, intent.name));
        if (!await persist(request, next)) return failure(request, "service", "persistence-failure", next);
        checkpoint = next; entry = known(checkpoint.receipt, SERVICE_KIND, intent.name)!;
      } else {
        const before = await beginEffect(request, checkpoint, "service-create", intent.name);
        if (!before) return failure(request, "service", "persistence-failure", checkpoint);
        checkpoint = before;
        let created;
        try { created = await request.executor.createService({ projectId: project.id, environmentId: environment.id, name: intent.name }); }
        catch { return failure(request, "service", "executor-failure", checkpoint); }
        if (created.name !== intent.name) return failure(request, "service", "identity-mismatch", checkpoint);
        const next = withResource(request, checkpoint, resource(SERVICE_KIND, created.id, intent.name));
        if (!await persist(request, next)) return failure(request, "service", "persistence-failure", next);
        checkpoint = next; entry = known(checkpoint.receipt, SERVICE_KIND, intent.name)!;
      }
    }
    services.set(intent.name, entry.id);
  }

  for (const intent of desired.volumes) {
    const serviceId = services.get(intent.service);
    if (!serviceId) return failure(request, "volume", "invalid-desired-state", checkpoint);
    const entry = known(checkpoint.receipt, VOLUME_KIND, intent.logicalName);
    if (entry) {
      try {
        const observed = await request.executor.getVolume({ projectId: project.id, volumeId: entry.id });
        const attachments = await request.executor.listVolumeInstances({ projectId: project.id, environmentId: environment.id });
        if (!observed || observed.id !== entry.id || observed.projectId !== project.id
          || !attachments.some((instance) => instance.volumeId === entry.id && instance.serviceId === serviceId && instance.mountPath === intent.mountPath)) {
          return failure(request, "volume", "identity-mismatch", checkpoint);
        }
      } catch { return failure(request, "volume", "executor-failure", checkpoint); }
    } else {
      if (pendingUnexpected("volume-create", intent.logicalName)) return failure(request, "volume", "recovery-required", checkpoint);
      let matches;
      try { matches = (await request.executor.listVolumeInstances({ projectId: project.id, environmentId: environment.id })).filter((item) => item.serviceId === serviceId && item.mountPath === intent.mountPath); }
      catch { return failure(request, "volume", "executor-failure", checkpoint); }
      const recovered = exactlyOne(matches);
      if (recovered === "ambiguous") return failure(request, "volume", "ambiguous-resource", checkpoint);
      if (hasPending(checkpoint, "volume-create", intent.logicalName) && recovered === "none") return failure(request, "volume", "recovery-required", checkpoint);
      if (recovered !== "none") {
        const next = withResource(request, checkpoint, resource(VOLUME_KIND, recovered.volumeId, intent.logicalName));
        if (!await persist(request, next)) return failure(request, "volume", "persistence-failure", next);
        checkpoint = next;
      } else {
        const before = await beginEffect(request, checkpoint, "volume-create", intent.logicalName);
        if (!before) return failure(request, "volume", "persistence-failure", checkpoint);
        checkpoint = before;
        let created;
        try { created = await request.executor.createVolume({ projectId: project.id, environmentId: environment.id, serviceId, mountPath: intent.mountPath, ...(intent.region === undefined ? {} : { region: intent.region }) }); }
        catch { return failure(request, "volume", "executor-failure", checkpoint); }
        if (created.projectId !== project.id) return failure(request, "volume", "identity-mismatch", checkpoint);
        const next = withResource(request, checkpoint, resource(VOLUME_KIND, created.id, intent.logicalName));
        if (!await persist(request, next)) return failure(request, "volume", "persistence-failure", next);
        checkpoint = next;
      }
    }
  }

  for (const intent of desired.services) {
    const serviceId = services.get(intent.name)!;
    const scopeId = `${environment.id}:${serviceId}`;
    const scopeName = `variables-${intent.name}`;
    // An empty collection is a deliberate structure-only phase. Do not create
    // a misleading "variables applied" receipt that would suppress the later
    // runtime configuration phase.
    if (Object.keys(intent.variables).length === 0) continue;
    // Collection upsert is idempotent and uses skipDeploys. Re-apply it even
    // when a receipt exists so resumed deployment phases and key rotations do
    // not silently retain an older runtime configuration.
    if (known(checkpoint.receipt, VARIABLES_KIND, scopeName)) {
      try { await request.executor.upsertVariables({ projectId: project.id, environmentId: environment.id, serviceId, variables: intent.variables }); }
      catch { return failure(request, "variables", "executor-failure", checkpoint); }
      continue;
    }
    if (pendingUnexpected("variables-upsert", scopeName)) return failure(request, "variables", "recovery-required", checkpoint);
    const before = hasPending(checkpoint, "variables-upsert", scopeName)
      ? checkpoint
      : await beginEffect(request, checkpoint, "variables-upsert", scopeName);
    if (!before) return failure(request, "variables", "persistence-failure", checkpoint);
    checkpoint = before;
    try { await request.executor.upsertVariables({ projectId: project.id, environmentId: environment.id, serviceId, variables: intent.variables }); }
    catch { return failure(request, "variables", "executor-failure", checkpoint); }
    const next = withResource(request, checkpoint, resource(VARIABLES_KIND, scopeId, scopeName));
    if (!await persist(request, next)) return failure(request, "variables", "persistence-failure", next);
    checkpoint = next;
  }

  // Attach the immutable runtime source only after the complete variable
  // collection has been accepted with skipDeploys.  Connecting an image can
  // start Railway deployment, so reversing this order can boot without the
  // intended runtime configuration.
  for (const intent of desired.services.filter((service): service is typeof service & { readonly image: string } => service.image !== undefined)) {
    const serviceId = services.get(intent.name)!;
    const receiptName = intent.name;
    const recorded = known(checkpoint.receipt, SERVICE_IMAGE_KIND, receiptName);
    if (recorded) {
      if (recorded.id !== serviceId) return failure(request, "image", "identity-mismatch", checkpoint);
      try {
        const observed = await request.executor.getServiceInstance({ serviceId, environmentId: environment.id });
        if (!hasExactRuntimeIntent(observed, serviceId, environment.id, intent.image, intent.startCommand)) {
          return failure(request, "image", "identity-mismatch", checkpoint);
        }
      } catch { return failure(request, "image", "executor-failure", checkpoint); }
      continue;
    }

    if (pendingUnexpected("service-connect", receiptName)) return failure(request, "image", "recovery-required", checkpoint);
    let observed;
    try { observed = await request.executor.getServiceInstance({ serviceId, environmentId: environment.id }); }
    catch { return failure(request, "image", "executor-failure", checkpoint); }

    if (hasExactRuntimeIntent(observed, serviceId, environment.id, intent.image, intent.startCommand)) {
      const next = withResource(request, checkpoint, resource(SERVICE_IMAGE_KIND, serviceId, receiptName));
      if (!await persist(request, next)) return failure(request, "image", "persistence-failure", next);
      checkpoint = next;
      continue;
    }

    if (hasPending(checkpoint, "service-connect", receiptName)) {
      if (checkpoint.pending?.image !== intent.image) return failure(request, "image", "identity-mismatch", checkpoint);
      // The response may have been lost.  Never reissue serviceConnect without
      // an exact observed source; a different source is an operator repair
      // condition, while an empty source leaves the pending effect ambiguous.
      return failure(request, "image", hasNoSource(observed) ? "recovery-required" : "identity-mismatch", checkpoint);
    }
    if (!hasNoSource(observed)) return failure(request, "image", "identity-mismatch", checkpoint);

    const before = await beginServiceConnect(request, checkpoint, receiptName, intent.image);
    if (!before) return failure(request, "image", "persistence-failure", checkpoint);
    checkpoint = before;
    let connected;
    try { connected = await request.executor.connectService({ serviceId, environmentId: environment.id, image: intent.image, ...(intent.startCommand === undefined ? {} : { startCommand: intent.startCommand }) }); }
    catch { return failure(request, "image", "executor-failure", checkpoint); }
    if (!hasExactRuntimeIntent(connected, serviceId, environment.id, intent.image, intent.startCommand)) {
      return failure(request, "image", "identity-mismatch", checkpoint);
    }
    const next = withResource(request, checkpoint, resource(SERVICE_IMAGE_KIND, serviceId, receiptName));
    if (!await persist(request, next)) return failure(request, "image", "persistence-failure", next);
    checkpoint = next;
  }

  for (const intent of desired.domains) {
    const serviceId = services.get(intent.service);
    if (!serviceId) return failure(request, "domain", "invalid-desired-state", checkpoint);
    const recorded = known(checkpoint.receipt, DOMAIN_KIND, intent.logicalName);
    if (recorded) {
      try {
        const observed = await request.executor.listDomains({ projectId: project.id, environmentId: environment.id, serviceId });
        if (!observed.some((domain) => domain.id === recorded.id && domain.targetPort === intent.targetPort)) {
          return failure(request, "domain", "identity-mismatch", checkpoint);
        }
      } catch { return failure(request, "domain", "executor-failure", checkpoint); }
      continue;
    }
    if (pendingUnexpected("domain-create", intent.logicalName)) return failure(request, "domain", "recovery-required", checkpoint);
    let matches;
    try { matches = (await request.executor.listDomains({ projectId: project.id, environmentId: environment.id, serviceId })).filter((item) => item.targetPort === intent.targetPort); }
    catch { return failure(request, "domain", "executor-failure", checkpoint); }
    const recovered = exactlyOne(matches);
    if (recovered === "ambiguous") return failure(request, "domain", "ambiguous-resource", checkpoint);
    if (hasPending(checkpoint, "domain-create", intent.logicalName) && recovered === "none") return failure(request, "domain", "recovery-required", checkpoint);
    if (recovered !== "none") {
      const next = withResource(request, checkpoint, resource(DOMAIN_KIND, recovered.id, intent.logicalName));
      if (!await persist(request, next)) return failure(request, "domain", "persistence-failure", next);
      checkpoint = next;
    } else {
      const before = await beginEffect(request, checkpoint, "domain-create", intent.logicalName);
      if (!before) return failure(request, "domain", "persistence-failure", checkpoint);
      checkpoint = before;
      let created;
      try { created = await request.executor.createDomain({ serviceId, environmentId: environment.id, targetPort: intent.targetPort }); }
      catch { return failure(request, "domain", "executor-failure", checkpoint); }
      if (created.targetPort !== intent.targetPort) return failure(request, "domain", "identity-mismatch", checkpoint);
      const next = withResource(request, checkpoint, resource(DOMAIN_KIND, created.id, intent.logicalName));
      if (!await persist(request, next)) return failure(request, "domain", "persistence-failure", next);
      checkpoint = next;
    }
  }

  for (const intent of desired.services.filter((service) => service.deploy)) {
    const serviceId = services.get(intent.name)!;
    const recorded = known(checkpoint.receipt, DEPLOYMENT_KIND, intent.name);
    if (recorded) {
      try {
        const observed = await request.executor.getLatestDeployment({ environmentId: environment.id, serviceId });
        if (observed?.id !== recorded.id) {
          return failure(request, "deployment", "identity-mismatch", checkpoint);
        }
      } catch { return failure(request, "deployment", "executor-failure", checkpoint); }
      continue;
    }
    if (pendingUnexpected("deployment-create", intent.name)) return failure(request, "deployment", "recovery-required", checkpoint);
    let recovered;
    try { recovered = await request.executor.waitForLatestDeployment({ environmentId: environment.id, serviceId }); }
    catch { return failure(request, "deployment", "executor-failure", checkpoint); }
    if (hasPending(checkpoint, "deployment-create", intent.name) && recovered === null) return failure(request, "deployment", "recovery-required", checkpoint);
    if (recovered !== null) {
      const next = withResource(request, checkpoint, resource(DEPLOYMENT_KIND, recovered.id, intent.name));
      if (!await persist(request, next)) return failure(request, "deployment", "persistence-failure", next);
      checkpoint = next;
    } else return failure(request, "deployment", "executor-failure", checkpoint);
  }

  return { outcome: "complete", checkpoint };
}
