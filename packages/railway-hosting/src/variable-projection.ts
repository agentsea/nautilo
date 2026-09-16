import type { RailwayEnvironmentVariables } from "./operations";
import { HOSTING_PROVIDERS } from "@nautilo/hosting";
import type {
  RailwayBootstrapOutputReference,
  RailwayExternalProviderSecretSlot,
  RailwayFinalServiceName,
  RailwayGeneratedDomainName,
  RailwayGeneratedSecretSlotName,
  RailwayTopology,
  RailwayVariableIntent,
  RailwayVariablePart,
  RailwayVariableValue,
} from "./topology";

const FINAL_SERVICE_NAMES = new Set<RailwayFinalServiceName>([
  "app-postgres",
  "logto-postgres",
  "logto-seed",
  "logto",
  "nautilo-server",
]);

const GENERATED_SECRET_SLOTS = new Set<RailwayGeneratedSecretSlotName>([
  "app-postgres-superuser-password",
  "app-nautilo-db-password",
  "app-nautilo-agent-db-password",
  "app-nautilo-crypto-db-password",
  "logto-postgres-superuser-password",
  "logto-db-password",
  "logto-bootstrap-handoff-token",
  "nautilo-bootstrap-token",
  "nautilo-logto-email-webhook-secret",
]);

const GENERATED_PUBLIC_DOMAINS = new Set<RailwayGeneratedDomainName>([
  "logto-public",
  "nautilo-public",
]);
const GENERATED_PUBLIC_DOMAIN_SERVICES: Readonly<Record<RailwayGeneratedDomainName, RailwayFinalServiceName>> = {
  "logto-public": "logto",
  "nautilo-public": "nautilo-server",
};

const BOOTSTRAP_OUTPUTS = new Set<RailwayBootstrapOutputReference["output"]>([
  "logto-workbench-app-id",
  "logto-tui-app-id",
  "logto-tui-loopback-app-id",
  "logto-desktop-app-id",
  "logto-mobile-app-id",
  "logto-mobile-web-app-id",
  "logto-m2m-app-id",
  "logto-m2m-app-secret",
  "logto-resource",
]);

const EXTERNAL_PROVIDERS = new Set<string>(HOSTING_PROVIDERS);

/**
 * Request-memory-only values supplied by the caller. This module never
 * generates, persists, logs, or returns an input outside a successful runtime
 * variable map.
 */
export interface RailwayVariableProjectionInputs {
  readonly generatedSecrets: ReadonlyMap<RailwayGeneratedSecretSlotName, string>;
  /** Full `https://…` origins produced after Railway generated the domains. */
  readonly generatedPublicDomains: ReadonlyMap<RailwayGeneratedDomainName, string>;
  /** Outputs from the successful, transient Logto post-seed reconciliation. */
  readonly bootstrapOutputs: ReadonlyMap<RailwayBootstrapOutputReference["output"], string>;
  /** Keys use the stable `<provider>:<slot>` descriptor identity. */
  readonly externalProviderSecrets: ReadonlyMap<string, string>;
}

export type RailwayVariableProjectionBlockerCode =
  | "railway.variable-projection.unknown-service"
  | "railway.variable-projection.duplicate-service"
  | "railway.variable-projection.duplicate-variable-key"
  | "railway.variable-projection.unknown-generated-secret-slot"
  | "railway.variable-projection.missing-generated-secret"
  | "railway.variable-projection.unknown-generated-public-domain"
  | "railway.variable-projection.missing-generated-public-domain"
  | "railway.variable-projection.unknown-bootstrap-output"
  | "railway.variable-projection.missing-bootstrap-output"
  | "railway.variable-projection.unknown-external-provider-slot"
  | "railway.variable-projection.unknown-service-reference"
  | "railway.variable-projection.invalid-variable-value";

/**
 * Deliberately metadata-free: a blocker must remain safe to serialize even if
 * a caller accidentally injected a secret-looking value into an invalid
 * descriptor. The stable code gives a caller the repair path without carrying
 * a variable name, slot, provider response, or value.
 */
export interface RailwayVariableProjectionBlocker {
  readonly code: RailwayVariableProjectionBlockerCode;
}

export interface RailwayVariableProjection {
  readonly finalServices: Readonly<Record<RailwayFinalServiceName, RailwayEnvironmentVariables>>;
  readonly transientBootstrap: RailwayEnvironmentVariables;
  readonly transientLogtoBootstrap: RailwayEnvironmentVariables;
}

export type RailwayVariableProjectionResult =
  | { readonly ok: true; readonly projection: RailwayVariableProjection }
  | { readonly ok: false; readonly blockers: readonly RailwayVariableProjectionBlocker[] };

type ProjectionAttempt =
  | { readonly ok: true; readonly variables: RailwayEnvironmentVariables }
  | { readonly ok: false; readonly blockers: readonly RailwayVariableProjectionBlocker[] };

export type RailwayVariableCollectionProjectionResult = ProjectionAttempt;

/** An absent customer-owned provider key omits that optional runtime variable. */
const OMIT_OPTIONAL_VARIABLE = Symbol("omit-optional-variable");

type ResolvedVariableValue = string | RailwayVariableProjectionBlocker | typeof OMIT_OPTIONAL_VARIABLE;

function blocker(code: RailwayVariableProjectionBlockerCode): RailwayVariableProjectionBlocker {
  return { code };
}

function hasGeneratedSecretSlot(slot: string): slot is RailwayGeneratedSecretSlotName {
  return GENERATED_SECRET_SLOTS.has(slot as RailwayGeneratedSecretSlotName);
}

function hasGeneratedPublicDomain(domain: string): domain is RailwayGeneratedDomainName {
  return GENERATED_PUBLIC_DOMAINS.has(domain as RailwayGeneratedDomainName);
}

function hasBootstrapOutput(output: string): output is RailwayBootstrapOutputReference["output"] {
  return BOOTSTRAP_OUTPUTS.has(output as RailwayBootstrapOutputReference["output"]);
}

function isKnownExternalProviderSlot(value: RailwayExternalProviderSecretSlot): boolean {
  if (typeof value.provider !== "string" || typeof value.slot !== "string") return false;
  return EXTERNAL_PROVIDERS.has(value.provider) && value.slot === `${value.provider}-api-key`;
}

function externalProviderKey(value: RailwayExternalProviderSecretSlot): string {
  return `${value.provider}:${value.slot}`;
}

/** Railway's documented reference-variable grammar. */
function renderServiceReference(value: Extract<RailwayVariablePart, { readonly kind: "railway-service-private-reference" }>): string | null {
  if (typeof value.service !== "string" || !FINAL_SERVICE_NAMES.has(value.service as RailwayFinalServiceName)
    || value.variable !== "RAILWAY_PRIVATE_DOMAIN") return null;
  return `\${{${value.service}.${value.variable}}}`;
}

function resolvePart(
  value: RailwayVariablePart,
  inputs: RailwayVariableProjectionInputs,
): ResolvedVariableValue {
  switch (value.kind) {
    case "safe-literal":
      return typeof value.value === "string" ? value.value : blocker("railway.variable-projection.invalid-variable-value");
    case "generated-secret-slot": {
      if (typeof value.slot !== "string" || !hasGeneratedSecretSlot(value.slot)) return blocker("railway.variable-projection.unknown-generated-secret-slot");
      const resolved = inputs.generatedSecrets.get(value.slot);
      return typeof resolved === "string" ? resolved : blocker("railway.variable-projection.missing-generated-secret");
    }
    case "external-provider-secret-slot": {
      if (!isKnownExternalProviderSlot(value)) return blocker("railway.variable-projection.unknown-external-provider-slot");
      const resolved = inputs.externalProviderSecrets.get(externalProviderKey(value));
      return typeof resolved === "string" ? resolved : OMIT_OPTIONAL_VARIABLE;
    }
    case "generated-public-domain-reference": {
      if (typeof value.domain !== "string" || !hasGeneratedPublicDomain(value.domain)) return blocker("railway.variable-projection.unknown-generated-public-domain");
      // The domain intent is created before deployment. Railway documents its
      // system variable as a reference target, so retaining the template here
      // avoids a client-side create-domain/read-domain/rewrite cycle.
      return `https://\${{${GENERATED_PUBLIC_DOMAIN_SERVICES[value.domain]}.RAILWAY_PUBLIC_DOMAIN}}`;
    }
    case "bootstrap-output-reference": {
      if (typeof value.output !== "string" || !hasBootstrapOutput(value.output)) return blocker("railway.variable-projection.unknown-bootstrap-output");
      const resolved = inputs.bootstrapOutputs.get(value.output);
      return typeof resolved === "string" ? resolved : blocker("railway.variable-projection.missing-bootstrap-output");
    }
    case "railway-service-private-reference": {
      const rendered = renderServiceReference(value);
      return rendered ?? blocker("railway.variable-projection.unknown-service-reference");
    }
    default:
      return blocker("railway.variable-projection.invalid-variable-value");
  }
}

function projectValue(
  value: RailwayVariableValue,
  inputs: RailwayVariableProjectionInputs,
): ResolvedVariableValue {
  if (value === null || typeof value !== "object" || !("kind" in value)) {
    return blocker("railway.variable-projection.invalid-variable-value");
  }
  if (value.kind === "railway-template-composite") {
    if (value.parts.length === 0) {
      return blocker("railway.variable-projection.invalid-variable-value");
    }
    let rendered = "";
    for (const part of value.parts) {
      const resolved = resolvePart(part, inputs);
      if (resolved === OMIT_OPTIONAL_VARIABLE) return OMIT_OPTIONAL_VARIABLE;
      if (typeof resolved !== "string") return resolved;
      rendered += resolved;
    }
    return rendered;
  }
  return resolvePart(value, inputs);
}

function projectVariables(
  variables: readonly RailwayVariableIntent[],
  inputs: RailwayVariableProjectionInputs,
): ProjectionAttempt {
  const keys = new Set<string>();
  for (const variable of variables) {
    if (typeof variable.key !== "string" || variable.value === undefined) {
      return { ok: false, blockers: [blocker("railway.variable-projection.invalid-variable-value")] };
    }
    if (keys.has(variable.key)) return { ok: false, blockers: [blocker("railway.variable-projection.duplicate-variable-key")] };
    keys.add(variable.key);
  }

  const result: Record<string, string> = {};
  for (const variable of variables) {
    const value = projectValue(variable.value, inputs);
    if (value === OMIT_OPTIONAL_VARIABLE) continue;
    if (typeof value !== "string") return { ok: false, blockers: [value] };
    result[variable.key] = value;
  }
  return { ok: true, variables: result };
}

export function projectRailwayServiceVariables(
  service: RailwayTopology["finalServices"][number],
  inputs: RailwayVariableProjectionInputs,
): RailwayVariableCollectionProjectionResult {
  if (typeof service.name !== "string" || !FINAL_SERVICE_NAMES.has(service.name)) {
    return { ok: false, blockers: [blocker("railway.variable-projection.unknown-service")] };
  }
  return projectVariables(service.variables, inputs);
}

export function projectRailwayBootstrapVariables(
  bootstrap: RailwayTopology["transientBootstrap"],
  inputs: RailwayVariableProjectionInputs,
): RailwayVariableCollectionProjectionResult {
  return projectVariables(bootstrap.inputs, inputs);
}

function projectionFailure(blockers: readonly RailwayVariableProjectionBlocker[]): RailwayVariableProjectionResult {
  return { ok: false, blockers };
}

/**
 * Turns the certified topology's structured descriptors into request-only
 * Railway service variable maps. Railway explicitly documents combining text
 * and multiple reference variables in one value; composites preserve that
 * provider-side template syntax while resolving request-memory secrets.
 */
export function projectRailwayRuntimeVariables(
  topology: RailwayTopology,
  inputs: RailwayVariableProjectionInputs,
): RailwayVariableProjectionResult {
  const finalServices: Partial<Record<RailwayFinalServiceName, RailwayEnvironmentVariables>> = {};
  for (const service of topology.finalServices) {
    if (typeof service.name !== "string" || !FINAL_SERVICE_NAMES.has(service.name)) {
      return projectionFailure([blocker("railway.variable-projection.unknown-service")]);
    }
    if (finalServices[service.name] !== undefined) {
      return projectionFailure([blocker("railway.variable-projection.duplicate-service")]);
    }
    const projected = projectVariables(service.variables, inputs);
    if (!projected.ok) return projectionFailure(projected.blockers);
    finalServices[service.name] = projected.variables;
  }

  if (Object.keys(finalServices).length !== FINAL_SERVICE_NAMES.size) {
    return projectionFailure([blocker("railway.variable-projection.unknown-service")]);
  }

  const bootstrap = projectVariables(topology.transientBootstrap.inputs, inputs);
  if (!bootstrap.ok) return projectionFailure(bootstrap.blockers);
  const logtoBootstrap = projectVariables(topology.transientLogtoBootstrap.inputs, inputs);
  if (!logtoBootstrap.ok) return projectionFailure(logtoBootstrap.blockers);

  return {
    ok: true,
    projection: {
      finalServices: finalServices as Readonly<Record<RailwayFinalServiceName, RailwayEnvironmentVariables>>,
      transientBootstrap: bootstrap.variables,
      transientLogtoBootstrap: logtoBootstrap.variables,
    },
  };
}
