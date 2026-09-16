import type {
  McpHealth,
  McpServer,
  McpServerConfig,
  McpServerCreateInput,
  McpTransport,
  McpTransportKind,
} from "../../lib/mcp-servers-api";

export const TRUST_TIERS = ["standard", "high", "admin", "guest"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

const DEFAULT_TRUST_TIER: TrustTier = "standard";

/** Prefix marking a `host` as local (relay-hosted): `relay-<relayId>`. */
const RELAY_HOST_PREFIX = "relay-";

/** The official (server-hosted) host value. */
const SERVER_HOST = "server";

/**
 * D384 host tier: "official" runs inside `nautilo-server` (admin-managed,
 * SEC7-gated); "local" runs on the user's machine via their relay
 * (`host = relay-<relayId>`, owner self-service).
 */
export type ConnectionTier = "official" | "local";

/** Derive the tier from a raw `host` string. `relay-*` ⇒ local, else official. */
export function hostTier(host: string): ConnectionTier {
  return host.startsWith(RELAY_HOST_PREFIX) ? "local" : "official";
}

/** Tier of a server row (thin wrapper over {@link hostTier}). */
export function serverTier(server: McpServer): ConnectionTier {
  return hostTier(server.host);
}

/** Build a local host value from a relay id: `relay-<relayId>`. */
export function relayHostForId(relayId: string): string {
  return `${RELAY_HOST_PREFIX}${relayId}`;
}

/** Extract the relay id from a `relay-<id>` host, or null if not a local host. */
export function relayIdFromHost(host: string): string | null {
  return host.startsWith(RELAY_HOST_PREFIX)
    ? host.slice(RELAY_HOST_PREFIX.length)
    : null;
}

/**
 * Best-effort discovery of the current relay id from the existing server list.
 * Returns the first non-empty relay id found among local-tier rows, else null.
 * Prefer {@link resolveRelayId} with a live endpoint result when available.
 */
export function deriveRelayId(servers: McpServer[]): string | null {
  for (const s of servers) {
    const id = relayIdFromHost(s.host);
    if (id && id.length > 0) return id;
  }
  return null;
}

/**
 * Resolve the relay id for local-tier create/edit: prefer the live connected
 * relay from `GET /api/mcp-servers/relays`, fall back to {@link deriveRelayId}.
 */
export function resolveRelayId(
  liveRelayId: string | null,
  servers: McpServer[],
): string | null {
  if (liveRelayId && liveRelayId.length > 0) return liveRelayId;
  return deriveRelayId(servers);
}

export type ConnectionEditorSelection =
  | { readonly kind: "selected"; readonly server: McpServer }
  | { readonly kind: "ambiguous"; readonly choices: readonly McpServer[] }
  | { readonly kind: "missing" };

/** Resolve an edit deep link without ever choosing an arbitrary namesake. */
export function resolveConnectionEditorSelection(
  servers: readonly McpServer[],
  name: string,
  host: string | null,
): ConnectionEditorSelection {
  const named = servers.filter((server) => server.name === name);
  if (host) {
    const exact = named.filter((server) => server.host === host);
    return exact.length === 1
      ? { kind: "selected", server: exact[0] }
      : exact.length > 1 ? { kind: "ambiguous", choices: exact } : { kind: "missing" };
  }
  return named.length === 1
    ? { kind: "selected", server: named[0] }
    : named.length > 1 ? { kind: "ambiguous", choices: named } : { kind: "missing" };
}

export interface TierAvailabilityInput {
  canManageOfficial: boolean;
  relayId: string | null;
}

/**
 * Which tiers a user may pick when creating a new MCP connection.
 * Official requires admin (`manage_server_security`); Local requires a
 * connected relay (live endpoint or derived from existing local rows).
 */
export function creatableTiers({
  canManageOfficial,
  relayId,
}: TierAvailabilityInput): ConnectionTier[] {
  const tiers: ConnectionTier[] = [];
  if (canManageOfficial) tiers.push("official");
  if (relayId) tiers.push("local");
  return tiers;
}

/** Whether the user may create any MCP from the Connections UI. */
export function canCreateMcp(input: TierAvailabilityInput): boolean {
  return creatableTiers(input).length > 0;
}

/** Hint shown under the tier picker when creating a new local-tier MCP. */
export function localCreateHint(relayId: string | null): string {
  if (relayId) {
    return "Local MCPs run on this machine via your relay.";
  }
  return "Connect your relay (desktop app / nautilo-relay) to add a local MCP.";
}

/**
 * Parse a comma-separated user string into a trimmed, non-empty array.
 * "a, b ,, c " → ["a", "b", "c"]; "" / whitespace → [].
 */
export function parseCommaList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Join an array (or null/undefined) back into a display string for a text input. */
export function joinCommaList(items: string[] | null | undefined): string {
  return (items ?? []).join(", ");
}

export function transportLabel(kind: McpTransportKind): string {
  switch (kind) {
    case "stdio":
      return "stdio";
    case "streamable-http":
      return "HTTP";
    case "sse-legacy":
      return "SSE";
  }
}

/** Namespace scope label — "global" when the server has no namespace. */
export function scopeLabel(namespaceId: string | null): string {
  return namespaceId ?? "global";
}

/**
 * UI5 (D384 3.2.1) — human-readable "who can access this server's tools?"
 * explanation for the scope. `null` namespace = global (every agent, every
 * namespace); a set namespace = visible only where the requesting human can
 * read that namespace (the human-subset rule — no per-agent axis).
 */
export function scopeDescription(namespaceId: string | null): string {
  return namespaceId === null
    ? "Global — this server's tools are visible to every agent in every namespace."
    : "Namespace-scoped — visible only to agents whose human can read this namespace (the human-subset rule). Agents outside it never see these tools.";
}

/**
 * Build the transport object from the editor's raw fields. stdio uses
 * `command` + `args`; streamable-http / sse-legacy use `url`. Irrelevant
 * fields are dropped so the payload only carries what the kind needs.
 */
export function buildTransport(
  kind: McpTransportKind,
  fields: { command: string; args: string; url: string },
): McpTransport {
  if (kind === "stdio") {
    return {
      command: fields.command.trim(),
      args: parseCommaList(fields.args),
    };
  }
  return { url: fields.url.trim() };
}

/** Raw editor form values (all strings — the UI edits text). */
export interface ConnectionFormValues {
  name: string;
  tier: ConnectionTier;
  transportKind: McpTransportKind;
  command: string;
  args: string;
  url: string;
  envPassthrough: string;
  namespaceId: string;
  includeTools: string;
  excludeTools: string;
  trustTier: TrustTier;
}

export function emptyForm(): ConnectionFormValues {
  return {
    name: "",
    tier: "official",
    transportKind: "stdio",
    command: "",
    args: "",
    url: "",
    envPassthrough: "",
    namespaceId: "",
    includeTools: "",
    excludeTools: "",
    trustTier: DEFAULT_TRUST_TIER,
  };
}

/** Derive editable form values from an existing server row (edit mode). */
export function serverToForm(server: McpServer): ConnectionFormValues {
  const tier = TRUST_TIERS.find((t) => t === server.trustTier) ?? DEFAULT_TRUST_TIER;
  return {
    name: server.name,
    tier: serverTier(server),
    transportKind: server.transportKind,
    command: server.transport.command ?? "",
    args: joinCommaList(server.transport.args),
    url: server.transport.url ?? "",
    envPassthrough: joinCommaList(server.envPassthrough),
    namespaceId: server.namespaceId ?? "",
    includeTools: joinCommaList(server.includeTools),
    excludeTools: joinCommaList(server.excludeTools),
    trustTier: tier,
  };
}

/**
 * Resolve a form's tier + an optional relay id into a concrete `host` value.
 * official ⇒ "server"; local ⇒ `relay-<relayId>`. Returns null for a local
 * tier with no relay id (unresolvable — caller must not offer Local then).
 */
export function resolveHost(
  tier: ConnectionTier,
  relayId: string | null,
): string | null {
  if (tier === "official") return SERVER_HOST;
  if (!relayId) return null;
  return relayHostForId(relayId);
}

/**
 * Build the config payload shared by create (POST) and update (PUT).
 * Carries `host` only when the tier resolves to a concrete value (the server
 * still forces `enabled=false` on create and governs host acceptance per tier).
 */
export function buildConfigPayload(
  form: ConnectionFormValues,
  relayId: string | null = null,
): McpServerConfig {
  const namespace = form.namespaceId.trim();
  const host = resolveHost(form.tier, relayId);
  return {
    transportKind: form.transportKind,
    transport: buildTransport(form.transportKind, {
      command: form.command,
      args: form.args,
      url: form.url,
    }),
    envPassthrough: parseCommaList(form.envPassthrough),
    namespaceId: namespace.length > 0 ? namespace : null,
    includeTools: parseCommaList(form.includeTools),
    excludeTools: parseCommaList(form.excludeTools),
    trustTier: form.trustTier,
    ...(host ? { host } : {}),
  };
}

/** Build the create payload — config plus the (trimmed) name. */
export function buildCreatePayload(
  form: ConnectionFormValues,
  relayId: string | null = null,
): McpServerCreateInput {
  return {
    name: form.name.trim(),
    ...buildConfigPayload(form, relayId),
  };
}

/** Map an existing server row back into a config payload (for a PUT). */
export function serverToConfig(server: McpServer): McpServerConfig {
  return {
    transportKind: server.transportKind,
    transport: server.transport,
    envPassthrough: server.envPassthrough ?? [],
    namespaceId: server.namespaceId,
    includeTools: server.includeTools ?? [],
    excludeTools: server.excludeTools ?? [],
    trustTier: server.trustTier,
    host: server.host,
  };
}

export interface RowDisplay {
  name: string;
  transportLabel: string;
  scopeLabel: string;
  scopeDescription: string;
  enabled: boolean;
}

export function rowDisplay(server: McpServer): RowDisplay {
  return {
    name: server.name,
    transportLabel: transportLabel(server.transportKind),
    scopeLabel: scopeLabel(server.namespaceId),
    scopeDescription: scopeDescription(server.namespaceId),
    enabled: server.enabled,
  };
}

/** Stable alphabetical ordering by name (case-insensitive). */
export function sortServers(servers: McpServer[]): McpServer[] {
  return [...servers].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/** Two-tier grouping for the list, each group alphabetically sorted. */
export interface GroupedServers {
  official: McpServer[];
  local: McpServer[];
}

export function groupServers(servers: McpServer[]): GroupedServers {
  const sorted = sortServers(servers);
  return {
    official: sorted.filter((s) => serverTier(s) === "official"),
    local: sorted.filter((s) => serverTier(s) === "local"),
  };
}

/**
 * D384 UI6 — map live health to a status dot. Returns null when health is
 * absent/unknown (older server that doesn't report it) so the UI degrades to
 * no dot. `color` is a CSS value usable directly in `style.backgroundColor`.
 */
export interface HealthDot {
  color: string;
  label: string;
}

export function healthDot(
  health: McpHealth | null | undefined,
): HealthDot | null {
  switch (health) {
    case "connected":
      return { color: "var(--success)", label: "Connected" };
    case "disconnected":
      return { color: "var(--foreground-dim)", label: "Disconnected" };
    case "error":
      return { color: "var(--error)", label: "Error" };
    case "circuit-open":
      return { color: "var(--warning)", label: "Circuit open — retrying" };
    default:
      // "unknown" or missing → no dot (graceful degrade).
      return null;
  }
}

/**
 * A short one-line description for a compact row: what the server runs.
 * The schema has no free-text description field, so we summarize the transport
 * target (stdio command+args, or the HTTP URL). Falls back to a generic label.
 */
export function describeServer(server: McpServer): string {
  const t = server.transport;
  if (server.transportKind === "stdio") {
    const parts = [t.command ?? "", ...(t.args ?? [])].filter((p) => p.length > 0);
    return parts.length > 0 ? parts.join(" ") : "Local stdio MCP server";
  }
  return t.url && t.url.length > 0 ? t.url : "HTTP MCP server";
}

/** Whether a tool is enabled = NOT present in the server's excludeTools list. */
export function toolEnabled(
  toolName: string,
  excludeTools: string[] | null | undefined,
): boolean {
  return !(excludeTools ?? []).includes(toolName);
}

/**
 * Compute the next `excludeTools` after toggling one tool.
 * Enabling removes it from the deny-list; disabling adds it (deduped, stable).
 */
export function computeNextExcludeTools(
  current: string[] | null | undefined,
  toolName: string,
  enabled: boolean,
): string[] {
  const set = new Set(current ?? []);
  if (enabled) set.delete(toolName);
  else set.add(toolName);
  return [...set];
}
