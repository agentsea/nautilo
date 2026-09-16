import { createHash } from "node:crypto";

import type { RailwayBootstrapHandoffOutput } from "./bootstrap-lifecycle";
import type { RailwayHttpsReadinessResult } from "./https-readiness";
import type { RailwayEnvironmentVariables } from "./operations";
import type { RailwayTopology } from "./topology";
import {
  projectRailwayBootstrapVariables,
  projectRailwayServiceVariables,
  type RailwayVariableProjectionInputs,
} from "./variable-projection";

export const RAILWAY_RESTORED_TARGET_ACTIVATION_SCHEMA_VERSION = 1 as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const IMAGE_DIGEST = /@sha256:([a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const HANDOFF_KEYS = ["logto-workbench-app-id", "logto-tui-app-id", "logto-tui-loopback-app-id", "logto-desktop-app-id", "logto-mobile-app-id", "logto-mobile-web-app-id", "logto-m2m-app-id", "logto-m2m-app-secret", "logto-resource"] as const;

export type RailwayRestoredTargetActivationStage =
  | "gates"
  | "logto-start"
  | "logto-observe"
  | "bootstrap-nautilo-start"
  | "nautilo-observe"
  | "readiness"
  | "complete";

export interface RailwayRestoredTargetActivationCheckpoint {
  readonly schemaVersion: typeof RAILWAY_RESTORED_TARGET_ACTIVATION_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly logtoServiceId: string;
  readonly nautiloServiceId: string;
  readonly logtoImageDigest: string;
  readonly nautiloImageDigest: string;
  readonly bootstrapImageDigest: string;
  readonly authorityGenerationId: string;
  readonly intentSha256: string;
  readonly effectSha256: string;
  readonly stage: RailwayRestoredTargetActivationStage;
  readonly logtoDeploymentId?: string | undefined;
  readonly nautiloDeploymentId?: string | undefined;
}

export type RailwayRestoredTargetChildObservation =
  | { readonly state: "running" }
  | { readonly state: "complete" }
  | { readonly state: "error" };

export type RailwayRestoredTargetBootstrapResult =
  | { readonly outcome: "pending" }
  | { readonly outcome: "complete" }
  | { readonly outcome: "failure" };

export interface RailwayRestoredTargetActivationExecutor {
  /** Durable ledgers, not request-memory booleans. */
  transferComplete(input: { readonly operationId: string }): Promise<boolean>;
  maintenanceCleanupComplete(input: { readonly operationId: string }): Promise<boolean>;
  /** Backed by RailwayExactServiceActivation.find/start, never latest deployment adoption. */
  ensureLogtoActivation(input: { readonly variables: RailwayEnvironmentVariables }): Promise<{ readonly jobId: string }>;
  observeLogtoActivation(input: { readonly jobId: string }): Promise<RailwayRestoredTargetChildObservation>;
  /**
   * Backed by the exact transient bootstrap lifecycle with exact-connect recovery.
   * It may return complete/delete the handoff only when applyOutput reports complete;
   * running or error must map to pending while the handoff remains refetchable.
   */
  runRestoredLogtoBootstrap(input: {
    readonly variables: RailwayEnvironmentVariables;
    readonly token: string;
    /** The adapter must retain/refetch the handoff until this reports complete. */
    readonly applyOutput: (output: RailwayBootstrapHandoffOutput) => Promise<RailwayRestoredTargetChildObservation>;
  }): Promise<RailwayRestoredTargetBootstrapResult>;
  /** Idempotent exact service-variable collection upsert inside applyOutput. */
  upsertFinalNautiloVariables(input: { readonly variables: RailwayEnvironmentVariables }): Promise<void>;
  /** Read-only recovery from the exact Nautilo activation child checkpoint. */
  findNautiloActivation(): Promise<{ readonly jobId: string } | undefined>;
  /** Backed by RailwayExactServiceActivation.find/start; replay returns the same child. */
  ensureNautiloActivation(input: { readonly variables: RailwayEnvironmentVariables }): Promise<{ readonly jobId: string }>;
  observeNautiloActivation(input: { readonly jobId: string }): Promise<RailwayRestoredTargetChildObservation>;
  /** Backed by the bounded exact `/health/ready` HTTPS primitive. */
  waitForNautiloReadiness(input: { readonly origin: string }): Promise<RailwayHttpsReadinessResult>;
}

export interface RailwayRestoredTargetActivationRequest {
  readonly operationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly logtoServiceId: string;
  readonly nautiloServiceId: string;
  /** Durable non-secret custody generation; rotation intentionally invalidates resumes. */
  readonly authorityGenerationId: string;
  readonly topology: RailwayTopology;
  readonly projectionInputs: RailwayVariableProjectionInputs;
  /** Request-memory old managed Workbench origin removed by populated restore reconciliation. */
  readonly sourceManagedWorkbenchOrigin: string;
  readonly checkpoint?: RailwayRestoredTargetActivationCheckpoint | undefined;
  readonly executor: RailwayRestoredTargetActivationExecutor;
  readonly persistCheckpoint: (checkpoint: RailwayRestoredTargetActivationCheckpoint) => Promise<void>;
}

export type RailwayRestoredTargetActivationFailureCode =
  | "invalid-input"
  | "invalid-checkpoint"
  | "projection-failed"
  | "transfer-incomplete"
  | "cleanup-incomplete"
  | "executor-failure"
  | "persistence-failure"
  | "logto-activation-failed"
  | "bootstrap-failed"
  | "nautilo-activation-missing"
  | "nautilo-activation-failed"
  | "readiness-failed";

export type RailwayRestoredTargetActivationResult =
  | { readonly outcome: "pending"; readonly stage: "logto-start" | "logto-observe" | "bootstrap-nautilo-start" | "nautilo-observe"; readonly checkpoint: RailwayRestoredTargetActivationCheckpoint }
  | { readonly outcome: "complete"; readonly checkpoint: RailwayRestoredTargetActivationCheckpoint }
  | { readonly outcome: "failure"; readonly code: RailwayRestoredTargetActivationFailureCode; readonly checkpoint?: RailwayRestoredTargetActivationCheckpoint | undefined };

interface Prepared {
  readonly request: RailwayRestoredTargetActivationRequest;
  readonly logtoVariables: RailwayEnvironmentVariables;
  readonly bootstrapVariables: RailwayEnvironmentVariables;
  readonly bootstrapToken: string;
  readonly sourceOrigin: string;
  readonly targetOrigin: string;
  readonly identity: Omit<RailwayRestoredTargetActivationCheckpoint, "stage" | "logtoDeploymentId" | "nautiloDeploymentId">;
}

type PreparationResult = { readonly ok: true; readonly prepared: Prepared }
  | { readonly ok: false; readonly code: "invalid-input" | "projection-failed" };

function canonicalOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return value.length <= 2048 && value === url.origin && url.protocol === "https:"
      && url.username === "" && url.password === "" && url.pathname === "/"
      && url.search === "" && url.hash === "" && url.hostname.length > 0 ? value : undefined;
  } catch { return undefined; }
}

function digest(image: string): string | undefined {
  return image.split("@").length === 2 && !/\s/.test(image) ? IMAGE_DIGEST.exec(image)?.[1] : undefined;
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const members = value.map(canonicalJson);
    return members.some((member) => member === undefined) ? undefined : `[${members.join(",")}]`;
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const encoded = canonicalJson(record[key]);
    if (encoded === undefined) return undefined;
    members.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${members.join(",")}}`;
}

function snapshotInputs(inputs: RailwayVariableProjectionInputs): RailwayVariableProjectionInputs {
  return {
    generatedSecrets: new Map(inputs.generatedSecrets),
    generatedPublicDomains: new Map(inputs.generatedPublicDomains),
    bootstrapOutputs: new Map(inputs.bootstrapOutputs),
    externalProviderSecrets: new Map(inputs.externalProviderSecrets),
  };
}

function snapshotExecutor(executor: RailwayRestoredTargetActivationExecutor): RailwayRestoredTargetActivationExecutor {
  return Object.freeze({
    transferComplete: executor.transferComplete.bind(executor),
    maintenanceCleanupComplete: executor.maintenanceCleanupComplete.bind(executor),
    ensureLogtoActivation: executor.ensureLogtoActivation.bind(executor),
    observeLogtoActivation: executor.observeLogtoActivation.bind(executor),
    runRestoredLogtoBootstrap: executor.runRestoredLogtoBootstrap.bind(executor),
    upsertFinalNautiloVariables: executor.upsertFinalNautiloVariables.bind(executor),
    findNautiloActivation: executor.findNautiloActivation.bind(executor),
    ensureNautiloActivation: executor.ensureNautiloActivation.bind(executor),
    observeNautiloActivation: executor.observeNautiloActivation.bind(executor),
    waitForNautiloReadiness: executor.waitForNautiloReadiness.bind(executor),
  });
}

function prepareUnsafe(input: RailwayRestoredTargetActivationRequest): PreparationResult {
  let topology: RailwayTopology;
  let projectionInputs: RailwayVariableProjectionInputs;
  let executor: RailwayRestoredTargetActivationExecutor;
  let checkpoint: RailwayRestoredTargetActivationCheckpoint | undefined;
  let persistCheckpoint: RailwayRestoredTargetActivationRequest["persistCheckpoint"];
  let bound: {
    readonly operationId: string; readonly projectId: string; readonly environmentId: string;
    readonly logtoServiceId: string; readonly nautiloServiceId: string; readonly authorityGenerationId: string;
    readonly sourceOrigin: string;
  };
  try {
    topology = structuredClone(input.topology);
    projectionInputs = snapshotInputs(input.projectionInputs);
    executor = snapshotExecutor(input.executor);
    checkpoint = input.checkpoint === undefined ? undefined : structuredClone(input.checkpoint);
    persistCheckpoint = input.persistCheckpoint;
    bound = {
      operationId: `${input.operationId}`, projectId: `${input.projectId}`, environmentId: `${input.environmentId}`,
      logtoServiceId: `${input.logtoServiceId}`, nautiloServiceId: `${input.nautiloServiceId}`,
      authorityGenerationId: `${input.authorityGenerationId}`,
      sourceOrigin: `${input.sourceManagedWorkbenchOrigin}`,
    };
  } catch { return { ok: false, code: "invalid-input" }; }
  const sourceOrigin = canonicalOrigin(bound.sourceOrigin);
  const targetOrigin = canonicalOrigin(projectionInputs.generatedPublicDomains.get("nautilo-public") ?? "");
  const logto = topology.finalServices.find((service) => service.name === "logto");
  const nautilo = topology.finalServices.find((service) => service.name === "nautilo-server");
  const logtoImageDigest = logto === undefined ? undefined : digest(logto.image);
  const nautiloImageDigest = nautilo === undefined ? undefined : digest(nautilo.image);
  const bootstrapImageDigest = digest(topology.transientLogtoBootstrap.image);
  const canonicalIntents = logto === undefined || nautilo === undefined ? undefined : canonicalJson({
    logto,
    nautilo,
    transientLogtoBootstrap: topology.transientLogtoBootstrap,
  });
  const intentSha256 = canonicalIntents === undefined ? undefined : sha(canonicalIntents);
  const bootstrapIntentExact = topology.transientLogtoBootstrap.kind === "transient-bootstrap"
    && topology.transientLogtoBootstrap.serviceName === "nautilo-bootstrap"
    && topology.transientLogtoBootstrap.imageName === "nautilo-bootstrap"
    && JSON.stringify(topology.transientLogtoBootstrap.lifecycle) === JSON.stringify(["create", "run-idempotent-reconciler", "checkpoint-success", "delete", "verify-absent"])
    && JSON.stringify(topology.transientLogtoBootstrap.prohibitedLongLivedServices) === JSON.stringify(["nautilo-server"]);
  if (!SAFE_ID.test(bound.operationId) || ![bound.projectId, bound.environmentId, bound.logtoServiceId, bound.nautiloServiceId, bound.authorityGenerationId, topology.releaseId].every((value) => SAFE_ID.test(value))
    || sourceOrigin === undefined || targetOrigin === undefined || sourceOrigin === targetOrigin
    || logto === undefined || nautilo === undefined || logto.kind !== "long-lived" || nautilo.kind !== "long-lived"
    || logtoImageDigest === undefined || nautiloImageDigest === undefined || bootstrapImageDigest === undefined || intentSha256 === undefined || !bootstrapIntentExact
    || topology.qualifications.some(({ disposition }) => disposition === "blocking")) return { ok: false, code: "invalid-input" };
  const logtoProjection = projectRailwayServiceVariables(logto, projectionInputs);
  const bootstrapProjection = projectRailwayBootstrapVariables(topology.transientLogtoBootstrap, projectionInputs);
  const placeholderOutputs = new Map(projectionInputs.bootstrapOutputs);
  for (const key of ["logto-workbench-app-id", "logto-tui-app-id", "logto-tui-loopback-app-id", "logto-desktop-app-id", "logto-mobile-app-id", "logto-mobile-web-app-id", "logto-m2m-app-id", "logto-m2m-app-secret"] as const) placeholderOutputs.set(key, `validation-${key}`);
  placeholderOutputs.set("logto-resource", `${targetOrigin}/api`);
  const nautiloProjection = projectRailwayServiceVariables(nautilo, { ...projectionInputs, bootstrapOutputs: placeholderOutputs });
  if (!logtoProjection.ok || !bootstrapProjection.ok || !nautiloProjection.ok) return { ok: false, code: "projection-failed" };
  if ("NAUTILO_MANAGED_WORKBENCH_SOURCE_ORIGIN" in bootstrapProjection.variables) return { ok: false, code: "invalid-input" };
  const bootstrapVariables: RailwayEnvironmentVariables = Object.freeze({
    ...bootstrapProjection.variables,
    NAUTILO_MANAGED_WORKBENCH_SOURCE_ORIGIN: sourceOrigin,
  });
  const bootstrapToken = bootstrapVariables["NAUTILO_BOOTSTRAP_HANDOFF_TOKEN"];
  if (typeof bootstrapToken !== "string" || bootstrapToken.length < 32) return { ok: false, code: "projection-failed" };
  const effectSha256 = sha(JSON.stringify({
    operationId: bound.operationId, projectId: bound.projectId, environmentId: bound.environmentId,
    logtoServiceId: bound.logtoServiceId, nautiloServiceId: bound.nautiloServiceId,
    authorityGenerationId: bound.authorityGenerationId,
    releaseId: topology.releaseId, logtoImageDigest, nautiloImageDigest, bootstrapImageDigest, intentSha256,
    sourceOriginSha256: sha(sourceOrigin), targetOriginSha256: sha(targetOrigin),
  }));
  const request: RailwayRestoredTargetActivationRequest = {
    ...input,
    operationId: bound.operationId, projectId: bound.projectId, environmentId: bound.environmentId,
    logtoServiceId: bound.logtoServiceId, nautiloServiceId: bound.nautiloServiceId,
    authorityGenerationId: bound.authorityGenerationId,
    sourceManagedWorkbenchOrigin: sourceOrigin,
    topology,
    projectionInputs,
    executor,
    persistCheckpoint,
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
  return { ok: true, prepared: {
    request,
    logtoVariables: Object.freeze({ ...logtoProjection.variables }),
    bootstrapVariables,
    bootstrapToken,
    sourceOrigin,
    targetOrigin,
    identity: {
      schemaVersion: RAILWAY_RESTORED_TARGET_ACTIVATION_SCHEMA_VERSION,
      releaseId: topology.releaseId,
      projectId: request.projectId,
      environmentId: request.environmentId,
      logtoServiceId: request.logtoServiceId,
      nautiloServiceId: request.nautiloServiceId,
      logtoImageDigest,
      nautiloImageDigest,
      bootstrapImageDigest,
      authorityGenerationId: bound.authorityGenerationId,
      intentSha256,
      effectSha256,
    },
  } };
}

function prepare(input: RailwayRestoredTargetActivationRequest): PreparationResult {
  try { return prepareUnsafe(input); } catch { return { ok: false, code: "invalid-input" }; }
}

function checkpointMatches(checkpoint: RailwayRestoredTargetActivationCheckpoint, identity: Prepared["identity"]): boolean {
  const stages = ["gates", "logto-start", "logto-observe", "bootstrap-nautilo-start", "nautilo-observe", "readiness", "complete"];
  const expectedKeys = ["authorityGenerationId", "bootstrapImageDigest", "effectSha256", "environmentId", "intentSha256", "logtoImageDigest", "logtoServiceId", "nautiloImageDigest", "nautiloServiceId", "projectId", "releaseId", "schemaVersion", "stage",
    ...(checkpoint.logtoDeploymentId === undefined ? [] : ["logtoDeploymentId"]),
    ...(checkpoint.nautiloDeploymentId === undefined ? [] : ["nautiloDeploymentId"])].sort();
  const actualKeys = Object.keys(checkpoint).sort();
  const index = stages.indexOf(checkpoint.stage);
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, keyIndex) => key === expectedKeys[keyIndex])
    && Object.entries(identity).every(([key, value]) => checkpoint[key as keyof RailwayRestoredTargetActivationCheckpoint] === value)
    && index >= 0 && SAFE_ID.test(checkpoint.authorityGenerationId) && SHA256.test(checkpoint.intentSha256) && SHA256.test(checkpoint.effectSha256) && SHA256.test(checkpoint.logtoImageDigest) && SHA256.test(checkpoint.nautiloImageDigest) && SHA256.test(checkpoint.bootstrapImageDigest)
    && (checkpoint.logtoDeploymentId === undefined || SAFE_ID.test(checkpoint.logtoDeploymentId))
    && (checkpoint.nautiloDeploymentId === undefined || SAFE_ID.test(checkpoint.nautiloDeploymentId))
    && (index >= stages.indexOf("logto-observe") || checkpoint.logtoDeploymentId === undefined)
    && (index >= stages.indexOf("nautilo-observe") || checkpoint.nautiloDeploymentId === undefined)
    && (index < stages.indexOf("logto-observe") || checkpoint.logtoDeploymentId !== undefined)
    && (index < stages.indexOf("nautilo-observe") || checkpoint.nautiloDeploymentId !== undefined)
    && (index < stages.indexOf("nautilo-observe") || checkpoint.logtoDeploymentId !== undefined);
}

function failed(code: RailwayRestoredTargetActivationFailureCode, checkpoint?: RailwayRestoredTargetActivationCheckpoint): RailwayRestoredTargetActivationResult {
  return checkpoint === undefined ? { outcome: "failure", code } : { outcome: "failure", code, checkpoint };
}

function snapshotOutput(output: RailwayBootstrapHandoffOutput, expectedResource: string): RailwayBootstrapHandoffOutput | undefined {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const actual = Object.keys(output).sort();
  if (actual.length !== HANDOFF_KEYS.length || ![...HANDOFF_KEYS].sort().every((key, index) => actual[index] === key)) return undefined;
  const snapshot: Partial<Record<(typeof HANDOFF_KEYS)[number], string>> = {};
  for (const key of HANDOFF_KEYS) {
    const value = output[key];
    const maximum = key === "logto-m2m-app-secret" ? 4096 : key === "logto-resource" ? 2048 : 512;
    const hasControl = typeof value === "string" && [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value
      || hasControl || Buffer.byteLength(value, "utf8") > maximum) return undefined;
    snapshot[key] = `${value}`;
  }
  try {
    const resource = new URL(snapshot["logto-resource"]!);
    if (snapshot["logto-resource"] !== expectedResource || resource.toString() !== expectedResource
      || resource.protocol !== "https:" || resource.username !== "" || resource.password !== ""
      || resource.hostname.length === 0 || resource.search !== "" || resource.hash !== "") return undefined;
  } catch { return undefined; }
  return Object.freeze(snapshot) as RailwayBootstrapHandoffOutput;
}

/** Complete restored-target activation; there is deliberately no seed or full-reconcile surface. */
export async function runRailwayRestoredTargetActivation(input: RailwayRestoredTargetActivationRequest): Promise<RailwayRestoredTargetActivationResult> {
  const preparation = prepare(input);
  if (!preparation.ok) return failed(preparation.code);
  const prepared = preparation.prepared;
  const { request, identity } = prepared;
  let checkpoint = request.checkpoint ?? { ...identity, stage: "gates" as const };
  if (!checkpointMatches(checkpoint, identity)) return failed("invalid-checkpoint");
  const persist = async (next: RailwayRestoredTargetActivationCheckpoint): Promise<boolean> => {
    try { await request.persistCheckpoint(next); return true; } catch { return false; }
  };
  let transferComplete: boolean;
  let cleanupComplete: boolean;
  try {
    transferComplete = await request.executor.transferComplete({ operationId: request.operationId });
    cleanupComplete = await request.executor.maintenanceCleanupComplete({ operationId: request.operationId });
  } catch { return failed("executor-failure", checkpoint); }
  if (!transferComplete) return failed("transfer-incomplete", checkpoint);
  if (!cleanupComplete) return failed("cleanup-incomplete", checkpoint);

  while (checkpoint.stage !== "complete") {
    if (checkpoint.stage === "gates") {
      checkpoint = { ...checkpoint, stage: "logto-start" };
      if (!await persist(checkpoint)) return failed("persistence-failure", checkpoint);
      continue;
    }
    if (checkpoint.stage === "logto-start") {
      let job: { readonly jobId: string };
      try { job = await request.executor.ensureLogtoActivation({ variables: prepared.logtoVariables }); }
      catch { return failed("executor-failure", checkpoint); }
      if (!SAFE_ID.test(job.jobId)) return failed("executor-failure", checkpoint);
      checkpoint = { ...checkpoint, stage: "logto-observe", logtoDeploymentId: job.jobId };
      if (!await persist(checkpoint)) return failed("persistence-failure", checkpoint);
      continue;
    }
    if (checkpoint.stage === "logto-observe") {
      let observed: RailwayRestoredTargetChildObservation;
      try { observed = await request.executor.observeLogtoActivation({ jobId: checkpoint.logtoDeploymentId! }); }
      catch { return failed("executor-failure", checkpoint); }
      if (observed.state === "running") return { outcome: "pending", stage: "logto-observe", checkpoint };
      if (observed.state === "error") {
        const { logtoDeploymentId: _failedDeploymentId, ...withoutFailedDeployment } = checkpoint;
        checkpoint = { ...withoutFailedDeployment, stage: "logto-start" };
        if (!await persist(checkpoint)) return failed("persistence-failure", checkpoint);
        return { outcome: "pending", stage: "logto-start", checkpoint };
      }
      checkpoint = { ...checkpoint, stage: "bootstrap-nautilo-start" };
      if (!await persist(checkpoint)) return failed("persistence-failure", checkpoint);
      continue;
    }
    if (checkpoint.stage === "bootstrap-nautilo-start") {
      let callbackJob: { readonly jobId: string } | undefined;
      let bootstrap: RailwayRestoredTargetBootstrapResult;
      try {
        bootstrap = await request.executor.runRestoredLogtoBootstrap({
          variables: prepared.bootstrapVariables,
          token: prepared.bootstrapToken,
          applyOutput: async (output) => {
            const stableOutput = snapshotOutput(output, `${prepared.targetOrigin}/api`);
            if (stableOutput === undefined) throw new Error("invalid bootstrap output");
            const bootstrapOutputs = new Map(request.projectionInputs.bootstrapOutputs);
            for (const key of HANDOFF_KEYS) bootstrapOutputs.set(key, stableOutput[key]);
            const nautilo = request.topology.finalServices.find((service) => service.name === "nautilo-server");
            if (nautilo === undefined) throw new Error("runtime projection failed");
            const projected = projectRailwayServiceVariables(nautilo, { ...request.projectionInputs, bootstrapOutputs });
            if (!projected.ok) throw new Error("runtime projection failed");
            const variables = Object.freeze({ ...projected.variables });
            await request.executor.upsertFinalNautiloVariables({ variables });
            callbackJob = await request.executor.ensureNautiloActivation({ variables });
            if (!SAFE_ID.test(callbackJob.jobId)) throw new Error("invalid child identity");
            let observed = await request.executor.observeNautiloActivation({ jobId: callbackJob.jobId });
            if (observed.state === "error") {
              callbackJob = await request.executor.ensureNautiloActivation({ variables });
              if (!SAFE_ID.test(callbackJob.jobId)) throw new Error("invalid child identity");
              observed = await request.executor.observeNautiloActivation({ jobId: callbackJob.jobId });
            }
            return observed;
          },
        });
      } catch { return failed("executor-failure", checkpoint); }
      if (bootstrap.outcome === "pending") return { outcome: "pending", stage: "bootstrap-nautilo-start", checkpoint };
      if (bootstrap.outcome === "failure") return failed("bootstrap-failed", checkpoint);
      let job = callbackJob;
      if (job === undefined) {
        try { job = await request.executor.findNautiloActivation(); }
        catch { return failed("executor-failure", checkpoint); }
      }
      if (job === undefined || !SAFE_ID.test(job.jobId)) return failed("nautilo-activation-missing", checkpoint);
      checkpoint = { ...checkpoint, stage: "nautilo-observe", nautiloDeploymentId: job.jobId };
      if (!await persist(checkpoint)) return failed("persistence-failure", checkpoint);
      continue;
    }
    if (checkpoint.stage === "nautilo-observe") {
      let observed: RailwayRestoredTargetChildObservation;
      try { observed = await request.executor.observeNautiloActivation({ jobId: checkpoint.nautiloDeploymentId! }); }
      catch { return failed("executor-failure", checkpoint); }
      if (observed.state === "running") return { outcome: "pending", stage: "nautilo-observe", checkpoint };
      if (observed.state === "error") return failed("nautilo-activation-failed", checkpoint);
      checkpoint = { ...checkpoint, stage: "readiness" };
      if (!await persist(checkpoint)) return failed("persistence-failure", checkpoint);
      continue;
    }
    if (checkpoint.stage === "readiness") {
      let readiness: RailwayHttpsReadinessResult;
      try { readiness = await request.executor.waitForNautiloReadiness({ origin: prepared.targetOrigin }); }
      catch { return failed("executor-failure", checkpoint); }
      if (readiness.outcome !== "complete") return failed("readiness-failed", checkpoint);
      checkpoint = { ...checkpoint, stage: "complete" };
      if (!await persist(checkpoint)) return failed("persistence-failure", checkpoint);
      continue;
    }
    return failed("invalid-checkpoint");
  }
  return { outcome: "complete", checkpoint };
}
