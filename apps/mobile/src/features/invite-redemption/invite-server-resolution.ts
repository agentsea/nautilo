/**
 * Exact-server invite resolution.
 *
 * An invite locator names exactly one server.  This seam deliberately knows
 * nothing about previews or invite bearers: it can probe, register, and bind
 * only that normalized origin.  The caller must echo the CeremonyRef through
 * every invocation and use `isCurrent` to make a replaced ceremony a no-op.
 */
import { normalizeInviteServerOrigin } from "@/lib/server-url";

import type { CeremonyRef } from "./invite-ceremony";

export type InviteServerRecord = Readonly<{
  id: string;
  serverUrl: string;
  displayName: string;
  lastActive: number;
}>;

export type InviteServerRegistry = Readonly<{
  servers: readonly InviteServerRecord[];
  activeId: string | null;
}>;

export type InviteServerProbe =
  | Readonly<{ ok: true; displayName: string }>
  | Readonly<{ ok: false; error: string }>;

export type InviteServerIdentity = Readonly<{
  ref: CeremonyRef;
  serverId: string;
  serverUrl: string;
}>;

type ResolutionBase = InviteServerIdentity;

export type InviteServerResolution =
  | (ResolutionBase & Readonly<{ kind: "known-active"; record: InviteServerRecord }> )
  | (ResolutionBase & Readonly<{ kind: "known-inactive"; record: InviteServerRecord }> )
  | (ResolutionBase & Readonly<{ kind: "requires-confirmation"; displayName: string }> )
  | (ResolutionBase & Readonly<{ kind: "unreachable" }> )
  | (ResolutionBase & Readonly<{ kind: "invalid-locator" }> )
  | (ResolutionBase & Readonly<{ kind: "server-mismatch" }> )
  | (ResolutionBase & Readonly<{ kind: "stale" }> );

export type InviteServerActivationOperation = "add" | "switch";

export type InviteServerActivation =
  | (ResolutionBase & Readonly<{ kind: "activated"; record: InviteServerRecord }> )
  | (ResolutionBase & Readonly<{ kind: "server-removed" }> )
  | (ResolutionBase & Readonly<{ kind: "requires-resolution" }> )
  | (ResolutionBase & Readonly<{ kind: "unreachable" }> )
  | (ResolutionBase & Readonly<{ kind: "server-mismatch" }> )
  | (ResolutionBase & Readonly<{ kind: "stale" }> );

/**
 * All production operations are injected so the decision logic remains pure
 * and has no dependency on React Native storage.  There intentionally is no
 * preview function here: this layer cannot accidentally fan a bearer out.
 */
export interface InviteServerResolutionDependencies {
  serverIdFromUrl: (serverUrl: string) => string;
  probeServer: (serverUrl: string) => Promise<InviteServerProbe>;
  loadRegistry: () => Promise<InviteServerRegistry>;
  upsertServer: (input: { serverUrl: string; displayName: string }) => Promise<InviteServerRecord>;
  setActiveServer: (serverId: string) => Promise<void>;
  /** Refreshes UI state and rebinds the existing API singleton. */
  refresh: () => Promise<void>;
  /** False means an incoming locator replaced this ceremony during an await. */
  isCurrent: (ref: CeremonyRef) => boolean;
}

export interface ResolveInviteServerInput {
  ref: CeremonyRef;
  serverUrl: string;
}

export interface ActivateInviteServerInput extends ResolveInviteServerInput {
  operation: InviteServerActivationOperation;
  /** Required only for an explicit, previously probed unknown-server add. */
  confirmation?: Extract<InviteServerResolution, { kind: "requires-confirmation" }>;
}

function sameRef(left: CeremonyRef, right: CeremonyRef): boolean {
  return left.generation === right.generation
    && left.serverId === right.serverId
    && left.ceremonyId === right.ceremonyId;
}

function identity(
  input: ResolveInviteServerInput,
  dependencies: Pick<InviteServerResolutionDependencies, "serverIdFromUrl">,
): InviteServerIdentity | null {
  const serverUrl = normalizeInviteServerOrigin(input.serverUrl);
  if (!serverUrl) return null;
  const serverId = dependencies.serverIdFromUrl(serverUrl);
  if (!serverId || input.ref.serverId !== serverId) return null;
  return { ref: input.ref, serverId, serverUrl };
}

function stale(identity: InviteServerIdentity): Extract<InviteServerResolution, { kind: "stale" }> {
  return { kind: "stale", ...identity };
}

function staleActivation(identity: InviteServerIdentity): Extract<InviteServerActivation, { kind: "stale" }> {
  return { kind: "stale", ...identity };
}

/**
 * Finds the one record that can represent this exact URL and rejects registry
 * corruption/collisions rather than quietly selecting an id or display name.
 */
function exactRecord(
  registry: InviteServerRegistry,
  target: InviteServerIdentity,
): InviteServerRecord | "mismatch" | null {
  const byId = registry.servers.find((server) => server.id === target.serverId) ?? null;
  const equivalent = registry.servers.filter(
    (server) => normalizeInviteServerOrigin(server.serverUrl) === target.serverUrl,
  );
  if (equivalent.some((server) => server.id !== target.serverId)) return "mismatch";
  if (!byId) return null;
  if (normalizeInviteServerOrigin(byId.serverUrl) !== target.serverUrl) return "mismatch";
  return byId;
}

/**
 * Classifies only the exact target. Known servers are read from the registry;
 * an unknown origin is probed once and then returned for an explicit UI
 * confirmation. It never adds, switches, previews, or inspects another host.
 */
export async function resolveInviteServer(
  input: ResolveInviteServerInput,
  dependencies: InviteServerResolutionDependencies,
): Promise<InviteServerResolution> {
  const normalizedInput = normalizeInviteServerOrigin(input.serverUrl);
  if (!normalizedInput) {
    return { kind: "invalid-locator", ref: input.ref, serverId: input.ref.serverId, serverUrl: "" };
  }
  const target = identity(input, dependencies);
  if (!target) return { kind: "server-mismatch", ref: input.ref, serverId: input.ref.serverId, serverUrl: normalizedInput };
  if (!dependencies.isCurrent(target.ref)) return stale(target);

  let registry: InviteServerRegistry;
  try {
    registry = await dependencies.loadRegistry();
  } catch {
    return dependencies.isCurrent(target.ref) ? { kind: "unreachable", ...target } : stale(target);
  }
  if (!dependencies.isCurrent(target.ref)) return stale(target);
  const record = exactRecord(registry, target);
  if (record === "mismatch") return { kind: "server-mismatch", ...target };
  if (record) {
    return {
      kind: registry.activeId === target.serverId ? "known-active" : "known-inactive",
      ...target,
      record,
    };
  }

  let probe: InviteServerProbe;
  try {
    probe = await dependencies.probeServer(target.serverUrl);
  } catch {
    return dependencies.isCurrent(target.ref) ? { kind: "unreachable", ...target } : stale(target);
  }
  if (!dependencies.isCurrent(target.ref)) return stale(target);
  if (!probe.ok) return { kind: "unreachable", ...target };
  return { kind: "requires-confirmation", ...target, displayName: probe.displayName };
}

function activationMismatchOrStale(
  input: ActivateInviteServerInput,
  dependencies: InviteServerResolutionDependencies,
): InviteServerActivation | null {
  const target = identity(input, dependencies);
  if (!target) {
    const serverUrl = normalizeInviteServerOrigin(input.serverUrl) ?? "";
    return { kind: "server-mismatch", ref: input.ref, serverId: input.ref.serverId, serverUrl };
  }
  if (!dependencies.isCurrent(target.ref)) return staleActivation(target);
  if (
    input.operation === "add"
    && (!input.confirmation
      || input.confirmation.kind !== "requires-confirmation"
      || !sameRef(input.confirmation.ref, target.ref)
      || input.confirmation.serverId !== target.serverId
      || input.confirmation.serverUrl !== target.serverUrl)
  ) {
    return { kind: "requires-resolution", ...target };
  }
  return null;
}

async function proveActivated(
  target: InviteServerIdentity,
  dependencies: InviteServerResolutionDependencies,
): Promise<InviteServerActivation> {
  try {
    await dependencies.refresh();
  } catch {
    return dependencies.isCurrent(target.ref) ? { kind: "unreachable", ...target } : staleActivation(target);
  }
  if (!dependencies.isCurrent(target.ref)) return staleActivation(target);
  let registry: InviteServerRegistry;
  try {
    registry = await dependencies.loadRegistry();
  } catch {
    return dependencies.isCurrent(target.ref) ? { kind: "unreachable", ...target } : staleActivation(target);
  }
  if (!dependencies.isCurrent(target.ref)) return staleActivation(target);
  const record = exactRecord(registry, target);
  if (record === "mismatch") return { kind: "server-mismatch", ...target };
  if (!record || registry.activeId !== target.serverId) return { kind: "server-removed", ...target };
  return { kind: "activated", ...target, record };
}

/**
 * Mutates only an explicitly selected exact record. Switch can never fall
 * back to an add after a concurrent removal; add requires the prior probe's
 * confirmation result. The post-write registry check proves the active API
 * binding still names the locator origin before preview is allowed.
 */
export async function activateInviteServer(
  input: ActivateInviteServerInput,
  dependencies: InviteServerResolutionDependencies,
): Promise<InviteServerActivation> {
  const early = activationMismatchOrStale(input, dependencies);
  if (early) return early;
  const target = identity(input, dependencies)!;

  let before: InviteServerRegistry;
  try {
    before = await dependencies.loadRegistry();
  } catch {
    return dependencies.isCurrent(target.ref) ? { kind: "unreachable", ...target } : staleActivation(target);
  }
  if (!dependencies.isCurrent(target.ref)) return staleActivation(target);
  const existing = exactRecord(before, target);
  if (existing === "mismatch") return { kind: "server-mismatch", ...target };

  if (input.operation === "switch") {
    // A disappearing known record is a terminal resolution result, never an
    // implicit add. The UI can resolve again if the Human chooses to retry.
    if (!existing) return { kind: "server-removed", ...target };
    try {
      await dependencies.setActiveServer(target.serverId);
    } catch {
      return dependencies.isCurrent(target.ref) ? { kind: "unreachable", ...target } : staleActivation(target);
    }
    if (!dependencies.isCurrent(target.ref)) return staleActivation(target);
    return proveActivated(target, dependencies);
  }

  // Confirmation was produced by a successful exact-origin probe. If a
  // concurrent actor added the URL, do not reinterpret this add as a switch.
  if (existing) return { kind: "requires-resolution", ...target };
  const confirmation = input.confirmation!;
  let created: InviteServerRecord;
  try {
    created = await dependencies.upsertServer({
      serverUrl: target.serverUrl,
      displayName: confirmation.displayName,
    });
  } catch {
    return dependencies.isCurrent(target.ref) ? { kind: "unreachable", ...target } : staleActivation(target);
  }
  if (!dependencies.isCurrent(target.ref)) return staleActivation(target);
  if (created.id !== target.serverId || normalizeInviteServerOrigin(created.serverUrl) !== target.serverUrl) {
    return { kind: "server-mismatch", ...target };
  }
  return proveActivated(target, dependencies);
}
