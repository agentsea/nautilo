import {
  RELEASE_TOPOLOGY_SCHEMA_VERSION,
  HOSTING_PROVIDERS,
  HOSTING_PROVIDER_ENV_VARS,
  type HostingProvider,
  type ReleaseImageName,
  type ReleaseServiceRole,
  type VerifiedReleaseManifest,
} from "@nautilo/hosting";

/** The Railway topology grammar. It is intentionally separate from release schema versioning. */
export const RAILWAY_TOPOLOGY_SCHEMA_VERSION = 1 as const;
export const RAILWAY_POSTGRES_PORT = 5432 as const;
export const RAILWAY_LOGTO_PORT = 4301 as const;
export const RAILWAY_LOGTO_ADMIN_PORT = 4302 as const;
export const RAILWAY_NAUTILO_PORT = 3001 as const;
/** Public handoff port exposed by the transient hosted Logto bootstrap. */
export const RAILWAY_LOGTO_BOOTSTRAP_PORT = 8080 as const;

const FINAL_SERVICE_NAMES = [
  "app-postgres",
  "logto-postgres",
  "logto-seed",
  "logto",
  "nautilo-server",
] as const;

export type RailwayFinalServiceName = (typeof FINAL_SERVICE_NAMES)[number];
export type RailwayMountName = "app-postgres-data" | "logto-postgres-data" | "nautilo-data";
export type RailwayGeneratedDomainName = "logto-public" | "nautilo-public";

/** Metadata only. A secret value is generated/resolved by a later driver and never serializes here. */
export interface RailwayGeneratedSecretSlot {
  readonly kind: "generated-secret-slot";
  readonly slot: RailwayGeneratedSecretSlotName;
  readonly purpose: string;
}

export type RailwayGeneratedSecretSlotName =
  | "app-postgres-superuser-password"
  | "app-nautilo-db-password"
  | "app-nautilo-agent-db-password"
  | "app-nautilo-crypto-db-password"
  | "logto-postgres-superuser-password"
  | "logto-db-password"
  | "logto-bootstrap-handoff-token"
  | "nautilo-bootstrap-token"
  | "nautilo-logto-email-webhook-secret";

/** Metadata only. The customer supplies the actual provider key outside a plan or receipt. */
export interface RailwayExternalProviderSecretSlot {
  readonly kind: "external-provider-secret-slot";
  readonly provider: HostingProvider;
  readonly slot: string;
}

/** Railway's documented service-reference grammar is represented structurally, not interpolated here. */
export interface RailwayServicePrivateReference {
  readonly kind: "railway-service-private-reference";
  readonly service: "app-postgres" | "logto-postgres" | "logto";
  readonly variable: "RAILWAY_PRIVATE_DOMAIN";
}

/** Resolved only after Railway creates the generated public domain. */
export interface RailwayPublicDomainReference {
  readonly kind: "generated-public-domain-reference";
  readonly domain: RailwayGeneratedDomainName;
  readonly scheme: "https";
}

/** Produced by the later idempotent Logto reconciliation, never guessed in a plan. */
export interface RailwayBootstrapOutputReference {
  readonly kind: "bootstrap-output-reference";
  readonly producer: "logto-post-seed-reconciliation";
  readonly output:
    | "logto-workbench-app-id"
    | "logto-tui-app-id"
    | "logto-tui-loopback-app-id"
    | "logto-desktop-app-id"
    | "logto-mobile-app-id"
    | "logto-mobile-web-app-id"
    | "logto-m2m-app-id"
    | "logto-m2m-app-secret"
    | "logto-resource";
}

/** A non-secret literal; secret-looking values are intentionally not representable as literals. */
export interface RailwaySafeLiteral {
  readonly kind: "safe-literal";
  readonly value: string;
}

export type RailwayVariablePart =
  | RailwaySafeLiteral
  | RailwayGeneratedSecretSlot
  | RailwayExternalProviderSecretSlot
  | RailwayServicePrivateReference
  | RailwayPublicDomainReference
  | RailwayBootstrapOutputReference;

/** A Railway-documented value composed from text and reference variables. */
export interface RailwayTemplateCompositeValue {
  readonly kind: "railway-template-composite";
  readonly parts: readonly RailwayVariablePart[];
}

export type RailwayVariableValue = RailwayVariablePart | RailwayTemplateCompositeValue;

export interface RailwayVariableIntent {
  readonly key: string;
  readonly value: RailwayVariableValue;
}

export interface RailwayPrivatePortIntent {
  readonly port:
    | typeof RAILWAY_POSTGRES_PORT
    | typeof RAILWAY_LOGTO_PORT
    | typeof RAILWAY_LOGTO_ADMIN_PORT
    | typeof RAILWAY_NAUTILO_PORT;
  readonly visibility: "private";
}

export interface RailwayHealthcheckIntent {
  readonly path: "/health";
}

export interface RailwayFinalServiceIntent {
  readonly name: RailwayFinalServiceName;
  readonly image: string;
  readonly imageName: ReleaseImageName;
  readonly kind: "long-lived" | "run-once";
  readonly privatePorts: readonly RailwayPrivatePortIntent[];
  readonly variables: readonly RailwayVariableIntent[];
  /** Railway image start-command override. Omitted to preserve the image default. */
  readonly startCommand?: string | undefined;
  readonly healthcheck?: RailwayHealthcheckIntent | undefined;
}

/** Railway VolumeCreateInput has no user supplied volume name; logical names stay on this side only. */
export interface RailwayMountIntent {
  readonly logicalName: RailwayMountName;
  readonly service: "app-postgres" | "logto-postgres" | "nautilo-server";
  readonly mountPath: "/var/lib/postgresql/data" | "/var/lib/nautilo";
}

export interface RailwayGeneratedPublicDomainIntent {
  readonly logicalName: RailwayGeneratedDomainName;
  readonly service: "logto" | "nautilo-server";
  readonly targetPort: typeof RAILWAY_LOGTO_PORT | typeof RAILWAY_NAUTILO_PORT;
}

/**
 * The sixth service only exists during reconciliation. It is deliberately not
 * part of `finalServices`, and its descriptors never contain values.
 */
export interface RailwayTransientBootstrapIntent {
  readonly kind: "transient-bootstrap";
  readonly serviceName: "nautilo-bootstrap";
  readonly image: string;
  readonly imageName: "nautilo-bootstrap";
  readonly lifecycle: readonly ["create", "run-idempotent-reconciler", "checkpoint-success", "delete", "verify-absent"];
  readonly inputs: readonly RailwayVariableIntent[];
  readonly prohibitedLongLivedServices: readonly RailwayFinalServiceName[];
}

export type RailwayTopologyQualificationCode =
  | "runtime.logto-post-seed-reconciliation-unqualified";

export interface RailwayTopologyQualification {
  readonly code: RailwayTopologyQualificationCode;
  readonly disposition: "blocking";
  readonly explanation: string;
}

/** Pure desired state. There are no Railway IDs, secrets, receipts, or mutable image tags. */
export interface RailwayTopology {
  readonly schemaVersion: typeof RAILWAY_TOPOLOGY_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly finalServices: readonly RailwayFinalServiceIntent[];
  readonly mounts: readonly RailwayMountIntent[];
  readonly generatedPublicDomains: readonly RailwayGeneratedPublicDomainIntent[];
  readonly transientBootstrap: RailwayTransientBootstrapIntent;
  /** Runs only after Logto seed/core are healthy; deleted after HTTPS handoff. */
  readonly transientLogtoBootstrap: RailwayTransientBootstrapIntent;
  readonly qualifications: readonly RailwayTopologyQualification[];
}

export type RailwayTopologyBuildFailureCode =
  | "railway.topology.invalid-verified-manifest"
  | "railway.topology.unsupported-release-topology";

export type RailwayTopologyBuildResult =
  | { readonly ok: true; readonly topology: RailwayTopology }
  | { readonly ok: false; readonly code: RailwayTopologyBuildFailureCode };

const REQUIRED_IMAGE_NAMES = [
  "app-postgres",
  "logto-postgres",
  "logto",
  "nautilo-server",
  "nautilo-bootstrap",
] as const;

const EXPECTED_SERVICE_IMAGES: Readonly<Record<ReleaseServiceRole, ReleaseImageName>> = {
  "app-postgres": "app-postgres",
  "logto-postgres": "logto-postgres",
  "logto-seed": "logto",
  logto: "logto",
  "nautilo-server": "nautilo-server",
};

const EXPECTED_MOUNTS: Readonly<Record<RailwayMountName, { readonly service: "app-postgres" | "logto-postgres" | "nautilo-server"; readonly mountPath: "/var/lib/postgresql/data" | "/var/lib/nautilo" }>> = {
  "app-postgres-data": { service: "app-postgres", mountPath: "/var/lib/postgresql/data" },
  "logto-postgres-data": { service: "logto-postgres", mountPath: "/var/lib/postgresql/data" },
  "nautilo-data": { service: "nautilo-server", mountPath: "/var/lib/nautilo" },
};

const IMAGE_DIGEST_PATTERN = /@sha256:[a-f0-9]{64}$/;

function literal(value: string): RailwaySafeLiteral {
  return { kind: "safe-literal", value };
}

function generated(slot: RailwayGeneratedSecretSlotName, purpose: string): RailwayGeneratedSecretSlot {
  return { kind: "generated-secret-slot", slot, purpose };
}

function external(
  provider: RailwayExternalProviderSecretSlot["provider"],
  slot: string,
): RailwayExternalProviderSecretSlot {
  return { kind: "external-provider-secret-slot", provider, slot };
}

function privateDomain(service: RailwayServicePrivateReference["service"]): RailwayServicePrivateReference {
  return { kind: "railway-service-private-reference", service, variable: "RAILWAY_PRIVATE_DOMAIN" };
}

function publicDomain(domain: RailwayGeneratedDomainName): RailwayPublicDomainReference {
  return { kind: "generated-public-domain-reference", domain, scheme: "https" };
}

function bootstrapOutput(output: RailwayBootstrapOutputReference["output"]): RailwayBootstrapOutputReference {
  return { kind: "bootstrap-output-reference", producer: "logto-post-seed-reconciliation", output };
}

function composite(...parts: readonly RailwayVariablePart[]): RailwayTemplateCompositeValue {
  return { kind: "railway-template-composite", parts };
}

function variables(...entries: readonly RailwayVariableIntent[]): readonly RailwayVariableIntent[] {
  return [...entries].sort((left, right) => left.key.localeCompare(right.key));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function imageMap(manifest: unknown): ReadonlyMap<ReleaseImageName, string> | null {
  if (!isRecord(manifest)) return null;
  const rawImages = manifest["images"];
  if (!Array.isArray(rawImages) || rawImages.length !== REQUIRED_IMAGE_NAMES.length) return null;
  const images = new Map<ReleaseImageName, string>();
  for (const rawImage of rawImages) {
    if (!isRecord(rawImage)) return null;
    const name = rawImage["name"];
    const reference = rawImage["reference"];
    if (typeof name !== "string" || typeof reference !== "string") return null;
    if (!REQUIRED_IMAGE_NAMES.includes(name as ReleaseImageName) || !IMAGE_DIGEST_PATTERN.test(reference)) {
      return null;
    }
    const typedName = name as ReleaseImageName;
    if (images.has(typedName)) return null;
    images.set(typedName, reference);
  }
  return REQUIRED_IMAGE_NAMES.every((name) => images.has(name)) ? images : null;
}

function isSupportedVerifiedV1Manifest(manifest: VerifiedReleaseManifest): boolean {
  const value: unknown = manifest;
  if (!isRecord(value) || typeof value["releaseId"] !== "string" || value["releaseId"].length === 0) return false;
  if (manifest.topology?.schemaVersion !== RELEASE_TOPOLOGY_SCHEMA_VERSION) return false;
  if (manifest.topology?.bootstrap?.image !== "nautilo-bootstrap") return false;
  const expectedRoles: readonly ReleaseServiceRole[] = FINAL_SERVICE_NAMES;
  if (!Array.isArray(manifest.topology?.services) || manifest.topology.services.length !== expectedRoles.length) return false;
  if (!expectedRoles.every((role) => manifest.topology.services.some((service) => (
    service.role === role && service.name === role && service.image === EXPECTED_SERVICE_IMAGES[role]
  )))) {
    return false;
  }
  const expectedMountNames = Object.keys(EXPECTED_MOUNTS) as RailwayMountName[];
  if (!Array.isArray(manifest.topology?.persistentMounts) || manifest.topology.persistentMounts.length !== expectedMountNames.length) {
    return false;
  }
  if (!expectedMountNames.every((role) => manifest.topology.persistentMounts.some((mount) => (
    mount.role === role && mount.service === EXPECTED_MOUNTS[role].service && mount.mountPath === EXPECTED_MOUNTS[role].mountPath
  )))) {
    return false;
  }
  return imageMap(manifest) !== null;
}

function image(images: ReadonlyMap<ReleaseImageName, string>, name: ReleaseImageName): string {
  const reference = images.get(name);
  if (!reference) throw new Error(`Verified manifest missing image ${name}`);
  return reference;
}

/**
 * Build the exact, non-secret Railway V1 desired graph from a manifest already
 * verified by @nautilo/hosting. This function is intentionally pure and never
 * calls Railway or generates a credential.
 */
export function buildRailwayTopology(verifiedManifest: VerifiedReleaseManifest): RailwayTopologyBuildResult {
  if (!isSupportedVerifiedV1Manifest(verifiedManifest)) {
    return { ok: false, code: "railway.topology.invalid-verified-manifest" };
  }
  const images = imageMap(verifiedManifest);
  if (!images) return { ok: false, code: "railway.topology.invalid-verified-manifest" };

  const appPostgres: RailwayFinalServiceIntent = {
    name: "app-postgres",
    imageName: "app-postgres",
    image: image(images, "app-postgres"),
    kind: "long-lived",
    privatePorts: [{ port: RAILWAY_POSTGRES_PORT, visibility: "private" }],
    variables: variables(
      { key: "PGDATA", value: literal("/var/lib/postgresql/data/pgdata") },
      { key: "POSTGRES_PASSWORD", value: generated("app-postgres-superuser-password", "app postgres bootstrap administrator") },
      { key: "POSTGRES_USER", value: literal("postgres") },
    ),
  };

  const logtoPostgres: RailwayFinalServiceIntent = {
    name: "logto-postgres",
    imageName: "logto-postgres",
    image: image(images, "logto-postgres"),
    kind: "long-lived",
    privatePorts: [{ port: RAILWAY_POSTGRES_PORT, visibility: "private" }],
    variables: variables(
      { key: "PGDATA", value: literal("/var/lib/postgresql/data/pgdata") },
      { key: "POSTGRES_PASSWORD", value: generated("logto-postgres-superuser-password", "Logto postgres bootstrap administrator") },
      { key: "POSTGRES_USER", value: literal("postgres") },
    ),
  };

  const logtoDbUrl = composite(
    literal("postgres://logto:"),
    generated("logto-db-password", "Logto database role"),
    literal("@"),
    privateDomain("logto-postgres"),
    literal(`:${RAILWAY_POSTGRES_PORT}/logto_nautilo`),
  );

  const logtoSeed: RailwayFinalServiceIntent = {
    name: "logto-seed",
    imageName: "logto",
    image: image(images, "logto"),
    kind: "run-once",
    privatePorts: [],
    startCommand: "npm run cli db seed -- --swe",
    variables: variables({ key: "DB_URL", value: logtoDbUrl }),
  };

  const logto: RailwayFinalServiceIntent = {
    name: "logto",
    imageName: "logto",
    image: image(images, "logto"),
    kind: "long-lived",
    privatePorts: [
      { port: RAILWAY_LOGTO_PORT, visibility: "private" },
      { port: RAILWAY_LOGTO_ADMIN_PORT, visibility: "private" },
    ],
    variables: variables(
      { key: "ADMIN_ENDPOINT", value: literal(`http://logto.railway.internal:${RAILWAY_LOGTO_ADMIN_PORT}`) },
      { key: "ADMIN_PORT", value: literal(`${RAILWAY_LOGTO_ADMIN_PORT}`) },
      { key: "CASE_SENSITIVE_USERNAME", value: literal("false") },
      { key: "DB_URL", value: logtoDbUrl },
      { key: "ENDPOINT", value: publicDomain("logto-public") },
      { key: "HOSTNAME", value: literal("::") },
      { key: "PORT", value: literal(`${RAILWAY_LOGTO_PORT}`) },
      { key: "TRUST_PROXY_HEADER", value: literal("1") },
    ),
  };

  const appDbUrl = composite(
    literal("postgres://nautilo:"),
    generated("app-nautilo-db-password", "app database role"),
    literal("@"),
    privateDomain("app-postgres"),
    literal(`:${RAILWAY_POSTGRES_PORT}/nautilo`),
  );
  const appAgentDbUrl = composite(
    literal("postgres://nautilo_agent:"),
    generated("app-nautilo-agent-db-password", "app agent database role"),
    literal("@"),
    privateDomain("app-postgres"),
    literal(`:${RAILWAY_POSTGRES_PORT}/nautilo`),
  );
  const appCryptoDbUrl = composite(
    literal("postgres://nautilo_crypto:"),
    generated("app-nautilo-crypto-db-password", "restricted runtime crypto database role"),
    literal("@"),
    privateDomain("app-postgres"),
    literal(":5432/nautilo"),
  );

  const nautiloServer: RailwayFinalServiceIntent = {
    name: "nautilo-server",
    imageName: "nautilo-server",
    image: image(images, "nautilo-server"),
    kind: "long-lived",
    privatePorts: [{ port: RAILWAY_NAUTILO_PORT, visibility: "private" }],
    healthcheck: { path: "/health" },
    variables: variables(
      { key: "DB_AGENT_CONNECTION_STRING", value: appAgentDbUrl },
      { key: "DB_AGENT_DIRECT_CONNECTION", value: appAgentDbUrl },
      { key: "DB_CONNECTION_STRING", value: appDbUrl },
      { key: "DB_DIRECT_CONNECTION", value: appDbUrl },
      { key: "DB_CRYPTO_CONNECTION_STRING", value: appCryptoDbUrl },
      ...HOSTING_PROVIDERS.map((provider) => ({
        key: HOSTING_PROVIDER_ENV_VARS[provider],
        value: external(provider, `${provider}-api-key`),
      })),
      { key: "LOGTO_DESKTOP_APP_ID", value: bootstrapOutput("logto-desktop-app-id") },
      { key: "LOGTO_ENDPOINT", value: publicDomain("logto-public") },
      { key: "LOGTO_ENDPOINT_INTERNAL", value: composite(literal("http://"), privateDomain("logto"), literal(`:${RAILWAY_LOGTO_PORT}`)) },
      { key: "LOGTO_ISSUER", value: composite(publicDomain("logto-public"), literal("/oidc")) },
      { key: "LOGTO_JWKS_URI", value: composite(publicDomain("logto-public"), literal("/oidc/jwks")) },
      { key: "LOGTO_M2M_APP_ID", value: bootstrapOutput("logto-m2m-app-id") },
      { key: "LOGTO_M2M_APP_SECRET", value: bootstrapOutput("logto-m2m-app-secret") },
      { key: "LOGTO_MOBILE_APP_ID", value: bootstrapOutput("logto-mobile-app-id") },
      { key: "LOGTO_MOBILE_WEB_APP_ID", value: bootstrapOutput("logto-mobile-web-app-id") },
      { key: "LOGTO_RESOURCE", value: bootstrapOutput("logto-resource") },
      { key: "LOGTO_TUI_APP_ID", value: bootstrapOutput("logto-tui-app-id") },
      { key: "LOGTO_TUI_LOOPBACK_APP_ID", value: bootstrapOutput("logto-tui-loopback-app-id") },
      { key: "LOGTO_WORKBENCH_APP_ID", value: bootstrapOutput("logto-workbench-app-id") },
      { key: "NAUTILO_ARTIFACTS_ROOT", value: literal("/var/lib/nautilo/artifacts") },
      { key: "NAUTILO_BOOTSTRAP_TOKEN", value: generated("nautilo-bootstrap-token", "remote claim bearer") },
      { key: "NAUTILO_DB_BOOTSTRAP", value: literal("container") },
      { key: "NAUTILO_DISABLE_TLS", value: literal("1") },
      { key: "NAUTILO_DOTENV_PATH", value: literal("/var/lib/nautilo/config/instance.env") },
      { key: "NAUTILO_HOST", value: literal("::") },
      { key: "NAUTILO_HOSTING_MODE", value: literal("cloud") },
      { key: "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET", value: generated("nautilo-logto-email-webhook-secret", "Logto HTTP email connector bearer") },
      { key: "NAUTILO_MEDIA_ROOT", value: literal("/var/lib/nautilo/media") },
      { key: "NAUTILO_MIGRATIONS_DIR", value: literal("/srv/migrations") },
      { key: "NAUTILO_PORT", value: literal(`${RAILWAY_NAUTILO_PORT}`) },
      { key: "NAUTILO_PUBLIC_BASE_URL", value: publicDomain("nautilo-public") },
      { key: "NAUTILO_WORKBENCH_DIST", value: literal("/srv/workbench") },
    ),
  };

  return {
    ok: true,
    topology: {
      schemaVersion: RAILWAY_TOPOLOGY_SCHEMA_VERSION,
      releaseId: verifiedManifest.releaseId,
      finalServices: [appPostgres, logtoPostgres, logtoSeed, logto, nautiloServer],
      mounts: [
        { logicalName: "app-postgres-data", service: "app-postgres", mountPath: "/var/lib/postgresql/data" },
        { logicalName: "logto-postgres-data", service: "logto-postgres", mountPath: "/var/lib/postgresql/data" },
        { logicalName: "nautilo-data", service: "nautilo-server", mountPath: "/var/lib/nautilo" },
      ],
      generatedPublicDomains: [
        { logicalName: "logto-public", service: "logto", targetPort: RAILWAY_LOGTO_PORT },
        { logicalName: "nautilo-public", service: "nautilo-server", targetPort: RAILWAY_NAUTILO_PORT },
      ],
      transientBootstrap: {
        kind: "transient-bootstrap",
        serviceName: "nautilo-bootstrap",
        imageName: "nautilo-bootstrap",
        image: image(images, "nautilo-bootstrap"),
        lifecycle: ["create", "run-idempotent-reconciler", "checkpoint-success", "delete", "verify-absent"],
        inputs: variables(
          { key: "NAUTILO_BOOTSTRAP_MODE", value: literal("database") },
          { key: "APP_POSTGRES_ADMIN_URL", value: composite(literal("postgres://postgres:"), generated("app-postgres-superuser-password", "app postgres bootstrap administrator"), literal("@"), privateDomain("app-postgres"), literal(`:${RAILWAY_POSTGRES_PORT}/postgres`)) },
          { key: "APP_NAUTILO_AGENT_DB_PASSWORD", value: generated("app-nautilo-agent-db-password", "app agent database role") },
          { key: "APP_NAUTILO_CRYPTO_DB_PASSWORD", value: generated("app-nautilo-crypto-db-password", "restricted runtime crypto database role bootstrap") },
          { key: "APP_NAUTILO_DB_PASSWORD", value: generated("app-nautilo-db-password", "app database role") },
          { key: "LOGTO_DB_PASSWORD", value: generated("logto-db-password", "Logto database role") },
          { key: "LOGTO_POSTGRES_ADMIN_URL", value: composite(literal("postgres://postgres:"), generated("logto-postgres-superuser-password", "Logto postgres bootstrap administrator"), literal("@"), privateDomain("logto-postgres"), literal(`:${RAILWAY_POSTGRES_PORT}/postgres`)) },
        ),
        prohibitedLongLivedServices: ["logto-seed", "logto", "nautilo-server"],
      },
      transientLogtoBootstrap: {
        kind: "transient-bootstrap",
        serviceName: "nautilo-bootstrap",
        imageName: "nautilo-bootstrap",
        image: image(images, "nautilo-bootstrap"),
        lifecycle: ["create", "run-idempotent-reconciler", "checkpoint-success", "delete", "verify-absent"],
        inputs: variables(
          { key: "LOGTO_ADMIN_ENDPOINT_INTERNAL", value: composite(literal("http://"), privateDomain("logto"), literal(`:${RAILWAY_LOGTO_ADMIN_PORT}`)) },
          { key: "LOGTO_ENDPOINT_INTERNAL", value: composite(literal("http://"), privateDomain("logto"), literal(`:${RAILWAY_LOGTO_PORT}`)) },
          { key: "LOGTO_POSTGRES_URL", value: composite(literal("postgres://logto:"), generated("logto-db-password", "Logto database role"), literal("@"), privateDomain("logto-postgres"), literal(`:${RAILWAY_POSTGRES_PORT}/logto_nautilo`)) },
          { key: "LOGTO_RESOURCE", value: composite(publicDomain("nautilo-public"), literal("/api")) },
          { key: "NAUTILO_BOOTSTRAP_HANDOFF_TOKEN", value: generated("logto-bootstrap-handoff-token", "one-time hosted Logto output handoff") },
          { key: "NAUTILO_BOOTSTRAP_MODE", value: literal("logto") },
          { key: "NAUTILO_PUBLIC_BASE_URL", value: publicDomain("nautilo-public") },
          { key: "NAUTILO_WORKBENCH_REDIRECT_URI", value: composite(publicDomain("nautilo-public"), literal("/auth/callback")) },
          { key: "PORT", value: literal(`${RAILWAY_LOGTO_BOOTSTRAP_PORT}`) },
        ),
        prohibitedLongLivedServices: ["nautilo-server"],
      },
      qualifications: [],
    },
  };
}
