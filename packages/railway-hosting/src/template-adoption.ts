import type { LaunchReceipt, HostingResourceReference } from "@nautilo/hosting";
import type { VerifiedReleaseManifest } from "@nautilo/hosting";

import {
  compileRailwayHeldTemplateScaffold,
  RAILWAY_HELD_TEMPLATE_SECRET_FUNCTION,
  type RailwayHeldTemplateScaffold,
} from "./template-held-scaffold";

export const RAILWAY_TEMPLATE_ADOPTION_AUDIT_SCHEMA_VERSION = 1 as const;

export const RAILWAY_TEMPLATE_GENERATED_SECRET_SLOTS = [
  "app-postgres-superuser-password",
  "app-nautilo-db-password",
  "app-nautilo-agent-db-password",
  "app-nautilo-crypto-db-password",
  "logto-postgres-superuser-password",
  "logto-db-password",
  "logto-bootstrap-handoff-token",
  "nautilo-bootstrap-token",
  "nautilo-logto-email-webhook-secret",
] as const;

export type RailwayTemplateGeneratedSecretSlot =
  (typeof RAILWAY_TEMPLATE_GENERATED_SECRET_SLOTS)[number];

export type RailwayTemplateAdoptionAuditCode =
  | "railway.template-adoption.ready"
  | "railway.template-adoption.release-invalid"
  | "railway.template-adoption.discovery-failed"
  | "railway.template-adoption.no-match"
  | "railway.template-adoption.ambiguous"
  | "railway.template-adoption.provenance-mismatch"
  | "railway.template-adoption.digest-mismatch"
  | "railway.template-adoption.hold-mismatch"
  | "railway.template-adoption.resource-mismatch"
  | "railway.template-adoption.variable-mismatch";

export interface RailwayTemplateAdoptionServiceObservation {
  readonly id: string;
  readonly name: string;
  readonly image: string | null;
  readonly startCommand: string | null;
  readonly templateId: string | null;
  readonly templateServiceId: string | null;
  readonly templateThreadSlug: string | null;
  readonly deploymentId: string;
  readonly deploymentStatus: string;
  /** Request-memory only. It must never be returned by the public result. */
  readonly variables: Readonly<Record<string, string>>;
  /** Request-memory only provider rendering evidence. */
  readonly unrenderedVariables: Readonly<Record<string, string>>;
}

export interface RailwayTemplateAdoptionObservation {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly sourceTemplateId: string | null;
  readonly sourceTemplateThreadSlug: string | null;
  readonly services: readonly RailwayTemplateAdoptionServiceObservation[];
  readonly volumes: readonly {
    readonly id: string;
    readonly name: string;
    readonly serviceId: string;
    readonly mountPath: string;
  }[];
  readonly domains: readonly {
    readonly id: string;
    readonly serviceId: string;
    readonly targetPort: number;
  }[];
}

export interface RailwayTemplateAdoptionDiscovery {
  /**
   * Return only projects containing at least one canonical Nautilo service
   * name. Unrelated Railway projects are not candidates and their variables
   * must never be queried.
   */
  discoverNautiloShapedProjects(): Promise<readonly RailwayTemplateAdoptionObservation[]>;
}

export type RailwayTemplateAdoptionAuditResult = Readonly<
  | {
      readonly schemaVersion: typeof RAILWAY_TEMPLATE_ADOPTION_AUDIT_SCHEMA_VERSION;
      readonly operation: "adopt-audit";
      readonly backend: "railway";
      readonly outcome: "ready";
      readonly code: "railway.template-adoption.ready";
      readonly projectName: string;
      readonly releaseId: string;
      readonly nextAction: "review-adoption-plan";
      readonly mutationAuthorized: false;
    }
  | {
      readonly schemaVersion: typeof RAILWAY_TEMPLATE_ADOPTION_AUDIT_SCHEMA_VERSION;
      readonly operation: "adopt-audit";
      readonly backend: "railway";
      readonly outcome: "blocked";
      readonly code: Exclude<RailwayTemplateAdoptionAuditCode, "railway.template-adoption.ready">;
      readonly nextAction: "repair-or-remove-held-project";
      readonly mutationAuthorized: false;
    }
>;

export interface RailwayTemplateAdoptionPrepared {
  readonly observation: RailwayTemplateAdoptionObservation;
  readonly receipt: LaunchReceipt;
  readonly generatedSecrets: ReadonlyMap<RailwayTemplateGeneratedSecretSlot, string>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,159}$/;
const SECRET_VALUE_MIN_BYTES = 32;
const SECRET_VALUE_MAX_BYTES = 256;

function blocked(code: Exclude<RailwayTemplateAdoptionAuditCode, "railway.template-adoption.ready">): RailwayTemplateAdoptionAuditResult {
  return Object.freeze({
    schemaVersion: RAILWAY_TEMPLATE_ADOPTION_AUDIT_SCHEMA_VERSION,
    operation: "adopt-audit" as const,
    backend: "railway" as const,
    outcome: "blocked" as const,
    code,
    nextAction: "repair-or-remove-held-project" as const,
    mutationAuthorized: false as const,
  });
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function safeIdentity(value: string): boolean {
  return SAFE_ID.test(value);
}

function exactObjectKeys(value: Readonly<Record<string, string>>, keys: readonly string[]): boolean {
  return sameStrings(Object.keys(value), keys);
}

function hasObjectKeys(value: Readonly<Record<string, string>>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}

function validSecret(value: string): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  return value.trim() === value && bytes >= SECRET_VALUE_MIN_BYTES && bytes <= SECRET_VALUE_MAX_BYTES;
}

// A separately named constant keeps TypeScript's indexed lookup narrow.
const slots = {
  "app-postgres\0POSTGRES_PASSWORD": "app-postgres-superuser-password",
  "app-postgres\0NAUTILO_TEMPLATE_APP_DB_PASSWORD": "app-nautilo-db-password",
  "app-postgres\0NAUTILO_TEMPLATE_AGENT_DB_PASSWORD": "app-nautilo-agent-db-password",
  "app-postgres\0NAUTILO_TEMPLATE_CRYPTO_DB_PASSWORD": "app-nautilo-crypto-db-password",
  "logto-postgres\0POSTGRES_PASSWORD": "logto-postgres-superuser-password",
  "logto-postgres\0NAUTILO_TEMPLATE_LOGTO_DB_PASSWORD": "logto-db-password",
  "logto\0NAUTILO_TEMPLATE_LOGTO_HANDOFF_TOKEN": "logto-bootstrap-handoff-token",
  "nautilo-server\0NAUTILO_BOOTSTRAP_TOKEN": "nautilo-bootstrap-token",
  "nautilo-server\0NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET": "nautilo-logto-email-webhook-secret",
} as const;

function secretSlot(service: string, key: string): RailwayTemplateGeneratedSecretSlot | undefined {
  const slot = `${service}\0${key}`;
  return slots[slot as keyof typeof slots];
}

function validateCandidate(
  candidate: RailwayTemplateAdoptionObservation,
  scaffold: RailwayHeldTemplateScaffold,
): { readonly ok: true; readonly secrets: ReadonlyMap<RailwayTemplateGeneratedSecretSlot, string> }
  | { readonly ok: false; readonly code: Exclude<RailwayTemplateAdoptionAuditCode, "railway.template-adoption.ready" | "railway.template-adoption.release-invalid" | "railway.template-adoption.discovery-failed" | "railway.template-adoption.no-match" | "railway.template-adoption.ambiguous"> } {
  if (![candidate.workspaceId, candidate.projectId, candidate.environmentId].every(safeIdentity)
    || !SAFE_NAME.test(candidate.projectName) || !SAFE_NAME.test(candidate.environmentName)) {
    return { ok: false, code: "railway.template-adoption.resource-mismatch" };
  }
  const expectedNames = scaffold.services.map((service) => service.name);
  if (!sameStrings(candidate.services.map((service) => service.name), expectedNames)
    || candidate.services.length !== expectedNames.length
    || new Set(candidate.services.map((service) => service.id)).size !== candidate.services.length
    || candidate.services.some((service) => !safeIdentity(service.id) || !safeIdentity(service.deploymentId))
    || new Set(candidate.services.map((service) => service.deploymentId)).size !== candidate.services.length) {
    return { ok: false, code: "railway.template-adoption.resource-mismatch" };
  }
  const templateId = candidate.sourceTemplateId;
  if (templateId === null || !safeIdentity(templateId)
    || candidate.services.some((service) => service.templateId !== templateId
      || service.templateServiceId === null || !safeIdentity(service.templateServiceId)
      || service.templateThreadSlug !== candidate.sourceTemplateThreadSlug)
    || new Set(candidate.services.map((service) => service.templateServiceId)).size !== candidate.services.length) {
    return { ok: false, code: "railway.template-adoption.provenance-mismatch" };
  }
  const expectedByName = new Map(scaffold.services.map((service) => [service.name, service]));
  for (const observed of candidate.services) {
    const expected = expectedByName.get(observed.name as RailwayHeldTemplateScaffold["services"][number]["name"]);
    if (expected === undefined || observed.image !== expected.image) {
      return { ok: false, code: "railway.template-adoption.digest-mismatch" };
    }
    if (observed.startCommand !== expected.startCommand || observed.deploymentStatus !== "SUCCESS") {
      return { ok: false, code: "railway.template-adoption.hold-mismatch" };
    }
  }
  const servicesById = new Map(candidate.services.map((service) => [service.id, service.name]));
  const expectedMounts = scaffold.volumes.map((mount) => `${mount.service}\0${mount.mountPath}`);
  const observedMounts = candidate.volumes.map((volume) => `${servicesById.get(volume.serviceId) ?? ""}\0${volume.mountPath}`);
  if (candidate.volumes.length !== 3 || new Set(candidate.volumes.map((volume) => volume.id)).size !== 3
    || !sameStrings(observedMounts, expectedMounts)) {
    return { ok: false, code: "railway.template-adoption.resource-mismatch" };
  }
  const expectedDomains = scaffold.domains.map((domain) => `${domain.service}\0${domain.targetPort}`);
  const observedDomains = candidate.domains.map((domain) => `${servicesById.get(domain.serviceId) ?? ""}\0${domain.targetPort}`);
  if (candidate.domains.length !== 2 || new Set(candidate.domains.map((domain) => domain.id)).size !== 2
    || !sameStrings(observedDomains, expectedDomains)) {
    return { ok: false, code: "railway.template-adoption.resource-mismatch" };
  }
  const secrets = new Map<RailwayTemplateGeneratedSecretSlot, string>();
  for (const service of candidate.services) {
    const expected = expectedByName.get(service.name as RailwayHeldTemplateScaffold["services"][number]["name"]);
    const expectedKeys = expected?.variables.map((variable) => variable.key) ?? [];
    // Railway injects its own RAILWAY_* runtime variables only in the rendered
    // collection. The unrendered collection remains the exact template-owned
    // authority and therefore rejects every extra user-supplied variable.
    if (expected === undefined || !hasObjectKeys(service.variables, expectedKeys)
      || !exactObjectKeys(service.unrenderedVariables, expectedKeys)) {
      return { ok: false, code: "railway.template-adoption.variable-mismatch" };
    }
    for (const variable of expected.variables) {
      const rendered = service.variables[variable.key];
      const unrendered = service.unrenderedVariables[variable.key];
      if (rendered === undefined || unrendered === undefined) return { ok: false, code: "railway.template-adoption.variable-mismatch" };
      if (variable.custody === "safe-literal") {
        if (rendered !== variable.value || unrendered !== variable.value) return { ok: false, code: "railway.template-adoption.variable-mismatch" };
        continue;
      }
      if (!validSecret(rendered)
        || (unrendered !== RAILWAY_HELD_TEMPLATE_SECRET_FUNCTION && unrendered !== rendered)) {
        return { ok: false, code: "railway.template-adoption.variable-mismatch" };
      }
      const slot = secretSlot(service.name, variable.key);
      if (slot === undefined || secrets.has(slot)) return { ok: false, code: "railway.template-adoption.variable-mismatch" };
      secrets.set(slot, rendered);
    }
  }
  if (secrets.size !== RAILWAY_TEMPLATE_GENERATED_SECRET_SLOTS.length) {
    return { ok: false, code: "railway.template-adoption.variable-mismatch" };
  }
  return { ok: true, secrets };
}

function logicalResources(candidate: RailwayTemplateAdoptionObservation): readonly HostingResourceReference[] {
  const serviceById = new Map(candidate.services.map((service) => [service.id, service.name]));
  const volumeLogicalName = (serviceId: string): string => ({
    "app-postgres": "app-postgres-data",
    "logto-postgres": "logto-postgres-data",
    "nautilo-server": "nautilo-data",
  } as const)[serviceById.get(serviceId) as "app-postgres" | "logto-postgres" | "nautilo-server"];
  const domainLogicalName = (serviceId: string): string => serviceById.get(serviceId) === "logto" ? "logto-public" : "nautilo-public";
  return [
    { kind: "railway.project", id: candidate.projectId, name: candidate.projectName },
    { kind: "railway.environment", id: candidate.environmentId, name: candidate.environmentName },
    ...candidate.services.map((service) => ({ kind: "railway.service", id: service.id, name: service.name })),
    ...candidate.services.map((service) => ({ kind: "railway.deployment", id: service.deploymentId, name: service.name })),
    ...candidate.volumes.map((volume) => ({ kind: "railway.volume", id: volume.id, name: volumeLogicalName(volume.serviceId) })),
    ...candidate.domains.map((domain) => ({ kind: "railway.domain", id: domain.id, name: domainLogicalName(domain.serviceId) })),
  ].sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
}

export async function auditRailwayTemplateAdoption(input: {
  readonly manifest: VerifiedReleaseManifest;
  readonly discovery: RailwayTemplateAdoptionDiscovery;
}): Promise<RailwayTemplateAdoptionAuditResult> {
  const compiled = compileRailwayHeldTemplateScaffold(structuredClone(input.manifest));
  if (!compiled.ok) return blocked("railway.template-adoption.release-invalid");
  let candidates: readonly RailwayTemplateAdoptionObservation[];
  try {
    candidates = await input.discovery.discoverNautiloShapedProjects();
  } catch {
    return blocked("railway.template-adoption.discovery-failed");
  }
  if (candidates.length === 0) return blocked("railway.template-adoption.no-match");
  if (candidates.length > 1) return blocked("railway.template-adoption.ambiguous");
  const validation = validateCandidate(candidates[0]!, compiled.scaffold);
  if (!validation.ok) return blocked(validation.code);
  return Object.freeze({
    schemaVersion: RAILWAY_TEMPLATE_ADOPTION_AUDIT_SCHEMA_VERSION,
    operation: "adopt-audit" as const,
    backend: "railway" as const,
    outcome: "ready" as const,
    code: "railway.template-adoption.ready" as const,
    projectName: candidates[0]!.projectName,
    releaseId: compiled.scaffold.releaseId,
    nextAction: "review-adoption-plan" as const,
    mutationAuthorized: false as const,
  });
}

/**
 * Gate 3 preparation proof. The exact non-secret receipt is persisted first;
 * only then may generated values move from request memory into OS credential
 * custody. No provider mutation is present in this API.
 */
export async function prepareRailwayTemplateAdoption(input: {
  readonly manifest: VerifiedReleaseManifest;
  readonly discovery: RailwayTemplateAdoptionDiscovery;
  readonly launchId: string;
  readonly now: string;
  readonly persistReceipt: (
    receipt: LaunchReceipt,
    target: { readonly workspaceId: string; readonly projectName: string; readonly environmentName: string },
  ) => Promise<void>;
  readonly storeGeneratedSecrets: (
    binding: { readonly launchId: string; readonly releaseId: string },
    secrets: ReadonlyMap<RailwayTemplateGeneratedSecretSlot, string>,
  ) => Promise<void>;
}): Promise<RailwayTemplateAdoptionAuditResult> {
  const compiled = compileRailwayHeldTemplateScaffold(structuredClone(input.manifest));
  if (!compiled.ok || !safeIdentity(input.launchId) || !Number.isFinite(Date.parse(input.now))) {
    return blocked("railway.template-adoption.release-invalid");
  }
  let candidates: readonly RailwayTemplateAdoptionObservation[];
  try {
    candidates = await input.discovery.discoverNautiloShapedProjects();
  } catch {
    return blocked("railway.template-adoption.discovery-failed");
  }
  if (candidates.length === 0) return blocked("railway.template-adoption.no-match");
  if (candidates.length > 1) return blocked("railway.template-adoption.ambiguous");
  const candidate = candidates[0]!;
  const validation = validateCandidate(candidate, compiled.scaffold);
  if (!validation.ok) return blocked(validation.code);
  const receipt: LaunchReceipt = {
    schemaVersion: 1,
    launchId: input.launchId,
    backend: "railway",
    revision: 1,
    stage: "authorized",
    resources: logicalResources(candidate),
    cleanup: { state: "not-required" },
    createdAt: input.now,
    updatedAt: input.now,
  };
  try {
    await input.persistReceipt(structuredClone(receipt), {
      workspaceId: candidate.workspaceId,
      projectName: candidate.projectName,
      environmentName: candidate.environmentName,
    });
    await input.storeGeneratedSecrets(
      { launchId: input.launchId, releaseId: compiled.scaffold.releaseId },
      new Map(validation.secrets),
    );
  } catch {
    return blocked("railway.template-adoption.discovery-failed");
  }
  return Object.freeze({
    schemaVersion: RAILWAY_TEMPLATE_ADOPTION_AUDIT_SCHEMA_VERSION,
    operation: "adopt-audit" as const,
    backend: "railway" as const,
    outcome: "ready" as const,
    code: "railway.template-adoption.ready" as const,
    projectName: candidate.projectName,
    releaseId: compiled.scaffold.releaseId,
    nextAction: "review-adoption-plan" as const,
    mutationAuthorized: false as const,
  });
}
