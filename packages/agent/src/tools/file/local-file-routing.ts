/**
 * M206 — strict relay selection for `current`/`absolute` unified `file` commands.
 *
 * Requires protocol v4+, `profile:"desktop-agent"`, `localFileExecution:true`,
 * and paired-owner routing. Never falls back to `fs` byte transport or server fs.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import {
  LOCAL_FILE_EXECUTION_UNSUPPORTED,
  DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION,
  DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE,
} from "@nautilo/relay";
import type {
  RelayServerMessage,
  RelayDesktopFilesystemGrantSnapshot,
  RelayDesktopFilesystemGrantSnapshotEntry,
} from "@nautilo/relay";
import type { ResolvedFocusedResource } from "@nautilo/types";
import type { ToolRelayRegistry } from "../../nodes/tools";

/**
 * D418 — the versioned server→relay grant-reference envelope. Derived
 * structurally from the exported relay dispatch message so this package does
 * not need a direct dependency on `@nautilo/desktop-filesystem-grants` (only the relay
 * protocol) to name the type.
 */
export type RelayDesktopFilesystemGrantRequest = NonNullable<
  Extract<RelayServerMessage, { type: "relay:dispatch" }>["desktopFilesystemGrantRequest"]
>;
type DesktopFilesystemGrantSubject = RelayDesktopFilesystemGrantRequest["subject"];
type DesktopFilesystemAccessOperation = RelayDesktopFilesystemGrantRequest["operation"];

export type LocalFileZone = "current" | "absolute";

// M206 introduced this execution class in protocol v4. Do not gate existing
// file operations on later additive protocol versions (such as D417 media).
const LOCAL_FILE_PROTOCOL_VERSION = 4;

const MUTATING_FILE_COMMANDS = new Set<string>([
  "create",
  "write",
  "insert",
  "str_replace",
  "move",
  "copy",
  "delete",
  "undo",
  "redo",
  "undo_turn",
  "pin_revision",
  "unpin_revision",
]);

export function isLocalFileZone(zone: string | undefined): zone is LocalFileZone {
  return zone === "current" || zone === "absolute";
}

export function isMutatingLocalFileCommand(command: string): boolean {
  return MUTATING_FILE_COMMANDS.has(command);
}

// ── D418 — read-only grant-reference selection (server-side, advisory) ──
//
// This slice is DISCOVERY ONLY. Selecting a snapshot grant never creates a
// grant and never treats the advertised snapshot as filesystem authority: the
// desktop live grant store stays authoritative, and the relay-local resolver
// reloads it to re-validate subject/policy/lifetime/identity before any access.
// A snapshot reference that is stale or revoked therefore fails closed locally.
// The path here is deliberately narrow: only the structurally read-only local
// file commands map to the explicit `read` operation, and everything else
// (mutations, ambiguous paths, generic shell, terminal, copy/move) attaches no
// envelope and keeps the pre-D418 baseline behavior.

/**
 * Structurally read-only unified `file` commands that map to the explicit
 * workstation `read` operation. Anything not listed here never produces a
 * grant reference in this slice.
 */
const READ_ONLY_LOCAL_FILE_COMMANDS = new Set<string>([
  "read",
  "list",
  "stat",
  "glob",
  "grep",
]);

/**
 * Map a unified `file` command to the single Desktop filesystem access operation this
 * slice supports. Returns `"read"` only for the structurally read-only
 * commands; every mutating or ambiguous command returns `undefined` so no
 * D418 envelope is attached.
 */
export function localFileReadOperation(
  command: string,
): DesktopFilesystemAccessOperation | undefined {
  return READ_ONLY_LOCAL_FILE_COMMANDS.has(command) ? "read" : undefined;
}

/** Canonical absolute path guard: absolute and already lexically normalized. */
function isCanonicalAbsolutePath(candidate: string): boolean {
  return path.isAbsolute(candidate) && path.normalize(candidate) === candidate;
}

/**
 * Separator-safe lexical containment for already-canonical absolute paths.
 * A candidate is within `root` when it equals the root or sits under it on a
 * real path separator — so `/a/b` never matches `/a/bc`. This mirrors the
 * desktop grant store's containment rule without importing it (the agent
 * package depends on the relay protocol, not `@nautilo/desktop-filesystem-grants`).
 */
function isPathWithinRoot(root: string, candidate: string): boolean {
  if (!path.isAbsolute(root) || !path.isAbsolute(candidate)) return false;
  const normalizedRoot = path.normalize(root);
  const normalizedCandidate = path.normalize(candidate);
  if (normalizedRoot === path.parse(normalizedRoot).root) {
    return normalizedCandidate.startsWith(normalizedRoot);
  }
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

/**
 * Pure selection over an advisory snapshot: return the single most-specific
 * active grant entry that could satisfy `candidatePath` + `operation`, or
 * `undefined` when none matches.
 *
 * It never mutates, never contacts the filesystem, and never treats the
 * snapshot as authority — it only chooses which already-advertised grant id the
 * server may reference. A match requires ALL of:
 *   - the snapshot's agent scope is the only supported value (bound owner);
 *   - the snapshot instance equals the caller's expected instance/scope;
 *   - the entry lists the exact requested operation; and
 *   - the entry's canonical root contains the candidate (separator-safe).
 * The narrowest (longest canonical root) match wins; a tie between distinct
 * equally-specific roots is ambiguous and yields `undefined` (fail closed).
 */
export function selectDesktopFilesystemGrantSnapshotGrant(args: {
  snapshot: RelayDesktopFilesystemGrantSnapshot;
  expectedInstanceId: string;
  candidatePath: string;
  operation: DesktopFilesystemAccessOperation;
}): RelayDesktopFilesystemGrantSnapshotEntry | undefined {
  const { snapshot, expectedInstanceId, candidatePath, operation } = args;

  if (snapshot.agentScope !== DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE) return undefined;
  if (!expectedInstanceId || snapshot.instanceId !== expectedInstanceId) return undefined;
  if (!isCanonicalAbsolutePath(candidatePath)) return undefined;

  let best: RelayDesktopFilesystemGrantSnapshotEntry | undefined;
  let bestAmbiguous = false;
  for (const entry of snapshot.grants) {
    if (!entry.access.includes(operation)) continue;
    if (!isPathWithinRoot(entry.canonicalRoot, candidatePath)) continue;
    if (best === undefined || entry.canonicalRoot.length > best.canonicalRoot.length) {
      best = entry;
      bestAmbiguous = false;
    } else if (entry.canonicalRoot.length === best.canonicalRoot.length && entry.id !== best.id) {
      bestAmbiguous = true;
    }
  }
  return bestAmbiguous ? undefined : best;
}

/**
 * Build the single-grant `RelayDesktopFilesystemGrantRequest` for a structurally
 * read-only local file command, or `undefined` when nothing matches.
 *
 * The request is a REFERENCE, not authority: it carries exactly one grant id
 * plus stale-detection metadata (policy version / lifetime / expiry) copied
 * from the advisory snapshot, and a subject bound to the authenticated dispatch
 * user, the target relay id, and the snapshot's instance/scope. It never
 * serializes platform authorization, filesystem identity, bookmarks, origin,
 * timestamps, or any other secret — only the discovery fields the relay-local
 * resolver needs to reload and re-authorize the live local grant. If the
 * command is not read-only, the candidate path is not canonical/absolute, the
 * relay advertised no snapshot, or no snapshot grant matches, this returns
 * `undefined` and the caller keeps the pre-D418 baseline (no envelope).
 */
export function buildLocalFileReadDesktopFilesystemGrantRequest(args: {
  command: string;
  candidatePath: string;
  subjectUserId: string;
  relayId: string;
  registry: ToolRelayRegistry | null;
}): RelayDesktopFilesystemGrantRequest | undefined {
  const { command, candidatePath, subjectUserId, relayId, registry } = args;

  const operation = localFileReadOperation(command);
  if (operation === undefined) return undefined;
  if (!subjectUserId || !relayId) return undefined;
  if (!isCanonicalAbsolutePath(candidatePath)) return undefined;
  if (!registry?.getDesktopFilesystemGrantSnapshot) return undefined;
  const protocolVersion = registry.getProtocolVersion?.(relayId);
  if (
    typeof protocolVersion !== "number" ||
    protocolVersion < DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION
  ) {
    return undefined;
  }

  const snapshot = registry.getDesktopFilesystemGrantSnapshot(relayId);
  if (!snapshot) return undefined;

  const entry = selectDesktopFilesystemGrantSnapshotGrant({
    snapshot,
    expectedInstanceId: snapshot.instanceId,
    candidatePath,
    operation,
  });
  if (entry === undefined) return undefined;

  const subject: DesktopFilesystemGrantSubject = {
    userId: subjectUserId,
    instanceId: snapshot.instanceId,
    relayId,
    agentScope: snapshot.agentScope,
  };
  return {
    version: 1,
    grantIds: [entry.id],
    requestedRoot: candidatePath,
    operation,
    subject,
    policy: {
      policyVersion: entry.policyVersion,
      lifetime: entry.lifetime,
      ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
    },
  };
}

export const RELAY_OWNERSHIP_MISMATCH = "relay_ownership_mismatch";

export type LocalFileRelaySelection =
  | {
      ok: true;
      relayId: string;
      allowedRoots: readonly string[];
      /**
       * D418 — at most one advisory grant reference for a structurally
       * read-only local file command. Present only when the caller supplied a
       * canonical candidate path + authenticated user AND the chosen relay
       * advertised a snapshot grant that covers it for `read`. Discovery only:
       * the relay-local resolver reloads the live desktop grant store and
       * decides access, so a stale/revoked reference fails closed there.
       */
      desktopFilesystemGrantRequest?: RelayDesktopFilesystemGrantRequest | undefined;
    }
  | {
      ok: false;
      error: string;
      code: typeof LOCAL_FILE_EXECUTION_UNSUPPORTED | typeof RELAY_OWNERSHIP_MISMATCH;
    };

const DESKTOP_REQUIRED_MESSAGE =
  "file operations on zone=\"current\" or zone=\"absolute\" require the Nautilo " +
  "desktop app with local file execution enabled. Open the Nautilo desktop app " +
  "on your Mac, ensure it is connected to this server, and retry. " +
  "Headless relay and server-side filesystem access are not supported for local files.";

function relayQualifies(
  registry: ToolRelayRegistry,
  relayId: string,
): boolean {
  const caps = registry.getCapabilities(relayId);
  if (!caps || caps.profile !== "desktop-agent") return false;
  if (caps.localFileExecution !== true) return false;
  const version = registry.getProtocolVersion?.(relayId);
  return typeof version === "number" && version >= LOCAL_FILE_PROTOCOL_VERSION;
}

/**
 * Pick the paired-owner relay that can execute typed `local-file` dispatches.
 */
const CROSS_RELAY_MESSAGE =
  "local revision ref belongs to a different desktop relay than the one connected " +
  "for this user. Use list_revisions from the relay that recorded the edit, or retry " +
  "from the Mac where that local history was created.";

export function resolveLocalFileRelay(args: {
  command: string;
  ownerId: string;
  registry: ToolRelayRegistry | null;
  /** When set (from `local:<relayId>:<uuid>`), dispatch must target this relay exactly. */
  relayIdHint?: string | undefined;
  /**
   * D423 Phase 5 — message returned with `RELAY_OWNERSHIP_MISMATCH` when a
   * `relayIdHint` is set but the hinted relay is not paired/qualifying. Defaults
   * to the revision-ref message; focus-ref callers pass
   * `FOCUSED_RELAY_MISMATCH_MESSAGE` so the failure reads correctly for a
   * focused local file.
   */
  relayHintMismatchMessage?: string | undefined;
  /**
   * D418 — canonical absolute path the read-only command will touch on the
   * relay machine. When supplied together with `ownerId`, a matching advisory
   * snapshot grant on the chosen relay yields a single `desktopFilesystemGrantRequest`
   * on the ok result. Omitted (or non-canonical) keeps the baseline: no
   * envelope, and never attached for a mutating/ambiguous command.
   */
  candidatePath?: string | undefined;
}): LocalFileRelaySelection {
  const { command, ownerId, registry, relayIdHint, candidatePath } = args;
  const mismatchMessage = args.relayHintMismatchMessage ?? CROSS_RELAY_MESSAGE;

  if (!registry?.localFileDispatch) {
    return { ok: false, error: DESKTOP_REQUIRED_MESSAGE, code: LOCAL_FILE_EXECUTION_UNSUPPORTED };
  }

  const mutating = isMutatingLocalFileCommand(command);
  const capability = mutating ? "canWriteWorkspace" : "canReadWorkspace";
  const candidates = registry.findByCapabilityForUser(capability, ownerId);

  // D418 — a matching advisory snapshot grant becomes at most one grant
  // reference. Never attached for mutations (localFileReadOperation gates the
  // command) or when no canonical candidate path is available.
  const grantRequestFor = (relayId: string): RelayDesktopFilesystemGrantRequest | undefined =>
    candidatePath !== undefined && ownerId
      ? buildLocalFileReadDesktopFilesystemGrantRequest({
          command,
          candidatePath,
          subjectUserId: ownerId,
          relayId,
          registry,
        })
      : undefined;

  if (relayIdHint) {
    if (!candidates.includes(relayIdHint) || !relayQualifies(registry, relayIdHint)) {
      return { ok: false, error: mismatchMessage, code: RELAY_OWNERSHIP_MISMATCH };
    }
    const allowedRoots = registry.getCapabilities(relayIdHint)?.allowedRoots ?? [];
    const desktopFilesystemGrantRequest = grantRequestFor(relayIdHint);
    return {
      ok: true,
      relayId: relayIdHint,
      allowedRoots: [...allowedRoots],
      ...(desktopFilesystemGrantRequest ? { desktopFilesystemGrantRequest } : {}),
    };
  }

  const relayId = candidates.find((id) => relayQualifies(registry, id));
  if (!relayId) {
    return { ok: false, error: DESKTOP_REQUIRED_MESSAGE, code: LOCAL_FILE_EXECUTION_UNSUPPORTED };
  }

  const allowedRoots = registry.getCapabilities(relayId)?.allowedRoots ?? [];
  const desktopFilesystemGrantRequest = grantRequestFor(relayId);
  return {
    ok: true,
    relayId,
    allowedRoots: [...allowedRoots],
    ...(desktopFilesystemGrantRequest ? { desktopFilesystemGrantRequest } : {}),
  };
}

// ---------------------------------------------------------------------------
// D423 Phase 5 — exact-relay routing for focused local files.
//
// A validated local-file focus ref carries the EXACT originating Electron
// relay (server-resolved, owner-paired). When an approved unified
// `file` / Office / media operation targets a path that maps back to one of
// those refs, private routing pins dispatch to that relay's id — the model
// still sees only `{ tool:"file", zone, path }`. Paths NOT introduced by a
// ref keep the existing current/absolute relay selection (no hint ⇒ default).
//
// Concurrency: the hint set is bound to the async chain via AsyncLocalStorage,
// mirroring `runWithTurn` from `@nautilo/logger`. The tools node binds it once
// per turn from `state.focusedResources`; every relay selection inside the
// dispatched tool reads it without explicit threading through factory
// closures (which keeps `file-tool.ts` / `officecli.ts` / `convert-tool.ts`
// unchanged).
// ---------------------------------------------------------------------------

/** D423 Phase 5 — a validated local-file focus ref reduced to its routing bits. */
export interface FocusedLocalFileHint {
  /** Exact originating Electron relay; never model-visible. */
  relayId: string;
  /** Canonical absolute path (`path.normalize`'d) of the focused file. */
  path: string;
}

/**
 * D423 Phase 5 — fail-closed message for a focused local file whose relay is
 * not the connected, owner-paired, qualifying desktop relay. Used for both
 * file and Office relay selection so a focused ref can never execute on a
 * different relay and never silently falls back.
 */
export const FOCUSED_RELAY_MISMATCH_MESSAGE =
  "the focused local file belongs to a different desktop relay than the one " +
  "connected for this user. Re-focus the file from the Nautilo Files pane on " +
  "the Mac where it originates, or drop a fresh local file reference.";

const focusedLocalFileStorage = new AsyncLocalStorage<readonly FocusedLocalFileHint[]>();
const EMPTY_HINTS: readonly FocusedLocalFileHint[] = Object.freeze([]);

/**
 * D423 Phase 5 — bind a set of validated local-file focus hints to the current
 * async chain for the duration of `fn`. Relay selections inside `fn` map a
 * tool input path to an exact originating relay id.
 */
export function runWithFocusedLocalFileHints<T>(
  hints: readonly FocusedLocalFileHint[],
  fn: () => T,
): T {
  return focusedLocalFileStorage.run(hints, fn);
}

/** D423 Phase 5 — the focus hints bound to the current async chain (empty if none). */
export function getFocusedLocalFileHints(): readonly FocusedLocalFileHint[] {
  return focusedLocalFileStorage.getStore() ?? EMPTY_HINTS;
}

/**
 * D423 Phase 5 — build the private focus-hint list from the server-resolved
 * focused-resource manifest. Only `kind:"local-file"` entries with a
 * `{ relayId, path }` locator contribute; the absolute path is canonicalized
 * with `path.normalize` to match the server resolver's derivation. Workspace
 * artifacts and D271 message attachments never contribute a relay hint (they
 * do not route through the local-file relay tier).
 */
export function buildFocusedLocalFileHints(
  focusedResources: readonly ResolvedFocusedResource[] | undefined,
): FocusedLocalFileHint[] {
  if (!focusedResources || focusedResources.length === 0) return [];
  const out: FocusedLocalFileHint[] = [];
  for (const resource of focusedResources) {
    if (resource.kind !== "local-file") continue;
    const locator = resource.locator as { relayId?: unknown; path?: unknown } | undefined;
    const relayId = locator?.relayId;
    const rawPath = locator?.path;
    if (typeof relayId !== "string" || relayId.length === 0) continue;
    if (typeof rawPath !== "string" || rawPath.length === 0) continue;
    out.push({ relayId, path: path.normalize(rawPath) });
  }
  return out;
}

/** D423 Phase 5 — canonicalize an absolute local path for hint comparison. */
export function canonicalLocalFilePath(p: string): string {
  return path.normalize(p);
}

function reconstructAbsolutePath(
  inputPath: string,
  zone: "current" | "absolute",
  currentFolder: string | null,
): string | null {
  if (!inputPath) return null;
  if (zone === "absolute") return path.normalize(inputPath);
  // zone:"current" — the model-facing path is relative to the trusted current
  // folder (server-derived). Reconstruct the absolute path the same way the
  // server resolver produced the relative form.
  if (!currentFolder || !path.isAbsolute(currentFolder)) return null;
  return path.normalize(path.join(currentFolder, inputPath));
}

/**
 * D423 Phase 5 — resolve the exact originating relay for a tool input path by
 * mapping `(path, zone, currentFolder)` back to a focused local-file ref.
 *
 * Returns the ref's `relayId` when the input reconstructs to a focused
 * canonical absolute path; returns `undefined` when no ref matches, no hints
 * are bound, or the input cannot be reconstructed (caller preserves the
 * existing current/absolute relay selection and policy). Never throws — a
 * miss is a non-event, not an error.
 */
export function resolveFocusedRelayHintForPath(args: {
  path: string;
  zone: "current" | "absolute";
  currentFolder: string | null;
}): string | undefined {
  const hints = getFocusedLocalFileHints();
  if (hints.length === 0) return undefined;
  const abs = reconstructAbsolutePath(args.path, args.zone, args.currentFolder);
  if (abs === null) return undefined;
  for (const hint of hints) {
    if (hint.path === abs) return hint.relayId;
  }
  return undefined;
}
