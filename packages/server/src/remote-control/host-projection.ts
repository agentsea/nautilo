/**
 * D458 Wave 7.3 — transform caller-scoped durable bindings plus one bounded
 * live-registry snapshot into the deliberately small public host projection.
 *
 * This is not an authority resolver.  `remoteHostId` is a durable binding id;
 * every later command must resolve it again against the caller and an exact
 * current relay generation.  In particular, this module never returns a
 * relay id, installation id, session id, generation, path, or raw capability
 * object.
 */
import { HEARTBEAT_TIMEOUT_MS, RELAY_PROTOCOL_VERSION } from "@nautilo/relay";

export type RemoteHostReadiness =
  | "compatible_online"
  | "incompatible_online"
  | "stale"
  | "unknown"
  | "offline"
  | "identity_conflict";

export interface PairedHostRow {
  readonly remoteHostId: string;
  readonly label: string | null;
  /** Exact relay_tokens.id copied into the binding; server-private. */
  readonly pairingGeneration: string;
  readonly durableLastSeenAt: Date | null;
}

/** A narrow structural port so the HTTP projector does not own the registry. */
export interface RemoteHostPresence {
  readonly pairingGeneration: string;
  readonly userId: string;
  readonly desktopSessionId: string | null;
  readonly protocolVersion: number;
  readonly lastSeenAt: number;
  readonly capabilities: unknown;
}

export interface ProjectedRemoteHost {
  remoteHostId: string;
  label: string | null;
  connected: boolean;
  readiness: RemoteHostReadiness;
  lastSeenAt: string | null;
}

export interface ProjectRemoteHostsInput {
  readonly userId: string;
  readonly rows: readonly PairedHostRow[];
  readonly presence: readonly RemoteHostPresence[];
  readonly nowMs: number;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isoFromMs(value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoFromDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * This projects transport compatibility only. Individual Tool capabilities
 * are resolved later for the exact Tool call; screen-control support
 * must never gate the computer as a whole.
 */
function projectOne(
  row: PairedHostRow,
  matches: readonly RemoteHostPresence[],
  input: ProjectRemoteHostsInput,
): ProjectedRemoteHost {
  const offline = (readiness: RemoteHostReadiness = "offline"): ProjectedRemoteHost => ({
    remoteHostId: row.remoteHostId,
    label: row.label,
    connected: false,
    readiness,
    lastSeenAt: isoFromDate(row.durableLastSeenAt),
  });

  // Never select a winner from duplicate exact generations.  A duplicate is
  // an identity split and must be repaired/re-paired, not silently routed.
  if (matches.length > 1) return offline("identity_conflict");
  const live = matches[0];
  if (!live) return offline();
  if (live.userId !== input.userId || live.pairingGeneration !== row.pairingGeneration) {
    return offline("unknown");
  }

  const capabilities = asObject(live.capabilities);
  const malformedHeartbeat = !Number.isFinite(live.lastSeenAt) || live.lastSeenAt < 0;
  if (malformedHeartbeat || !capabilities) return offline("unknown");
  if (input.nowMs - live.lastSeenAt > HEARTBEAT_TIMEOUT_MS || live.lastSeenAt > input.nowMs) {
    return {
      ...offline("stale"),
      lastSeenAt: isoFromMs(live.lastSeenAt) ?? isoFromDate(row.durableLastSeenAt),
    };
  }
  if (!live.desktopSessionId || live.desktopSessionId.trim() === "") {
    return { ...offline("incompatible_online"), lastSeenAt: isoFromMs(live.lastSeenAt) };
  }
  if (!Number.isInteger(live.protocolVersion)) return offline("unknown");
  if (live.protocolVersion < RELAY_PROTOCOL_VERSION ||
      capabilities["profile"] !== "desktop-agent") {
    return { ...offline("incompatible_online"), lastSeenAt: isoFromMs(live.lastSeenAt) };
  }
  return {
    remoteHostId: row.remoteHostId,
    label: row.label,
    connected: true,
    readiness: "compatible_online",
    lastSeenAt: isoFromMs(live.lastSeenAt) ?? isoFromDate(row.durableLastSeenAt),
  };
}

/**
 * O(B + R): index the one caller-filtered registry snapshot by exact durable
 * pairing generation, then project every SQL binding once.  The route makes
 * exactly one durable query and one snapshot call; this function issues none.
 */
export function projectRemoteHosts(input: ProjectRemoteHostsInput): ProjectedRemoteHost[] {
  const byGeneration = new Map<string, RemoteHostPresence[]>();
  for (const candidate of input.presence) {
    if (candidate.userId !== input.userId || !candidate.pairingGeneration) continue;
    const existing = byGeneration.get(candidate.pairingGeneration);
    if (existing) existing.push(candidate);
    else byGeneration.set(candidate.pairingGeneration, [candidate]);
  }
  return input.rows
    .map((row) => projectOne(row, byGeneration.get(row.pairingGeneration) ?? [], input))
    .sort((a, b) =>
      (a.label ?? "").localeCompare(b.label ?? "") ||
      a.remoteHostId.localeCompare(b.remoteHostId),
    );
}
