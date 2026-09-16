/**
 * D423 Phase 4 — Generic focused-resource substrate.
 *
 * One extensible, kind-keyed resolver registry that turns the discriminated
 * `ChatFocusedResourceRef` union (plus the legacy `artifactRefs` and D271
 * attachment lanes) into a single authoritative `ResolvedFocusedResource[]`
 * manifest. The manifest is what reaches the agent prompt as ONE
 * `## Focused resources` block; private locators (absolute paths, relay IDs,
 * internal row ids) never enter that block.
 *
 * Hard rules (ISSUE-D423):
 * 1. Focus refs never imply ingestion. A capability describes what an approved
 *    tool operation MAY do, not what has already happened.
 * 2. Capabilities are server/relay-derived, never client-authored.
 * 3. D271 attachment upload/storage/scanning/lifecycle stays intact — the
 *    attachment adapter runs AFTER normalization and only mirrors accepted
 *    attachments into the common manifest.
 * 4. Build compatibility adapters; do not rewrite existing lanes.
 *
 * The local-file resolver (Phase 4.1.3) validates each local-file focus ref
 * against the connected-relay registry: the relay must be connected, owned by
 * the sending actor, protocol v4+, `profile:"desktop-agent"`, and
 * `localFileExecution:true`. It derives a model-facing `file` target
 * (`zone:"current"` when the path is under the trusted current-folder context,
 * else `zone:"absolute"`) and NEVER uses the client `rootPath` as authority.
 * On any validation failure it FAILS CLOSED: no manifest entry, no read, no
 * upload, no fallback. Relay IDs and API transport never reach prompt output.
 */
import path from "node:path";
import { log } from "@nautilo/logger";
import type {
  ChatArtifactRef,
  ChatAttachmentStatus,
  ChatFocusedResourceRef,
  ResolvedFocusedResource,
} from "@nautilo/types";
import { resolveChatArtifactRefs, adaptResolvedArtifactRefs } from "./artifact-refs";
import { adaptNormalizedAttachments } from "./attachments";

/** D423 — maximum focus refs per send (each resolver defines its dedupe key). */
export const MAX_FOCUSED_RESOURCES = 30;

const MAX_LOCAL_FILE_FIELD_LEN = 1024;
const MAX_RELAY_ID_LEN = 256;
const MAX_ARTIFACT_ID_LEN = 256;

/**
 * D423 — kind-specific stable dedupe key for a wire focus ref. Two refs with
 * the same key collapse to one manifest entry. Workspace artifacts dedupe by
 * external `artifactId` (so a legacy `artifactRefs` entry and a
 * `focusedResources[].kind:"workspace-artifact"` entry for the same artifact
 * become one). Local files dedupe by `(relayId, path)`.
 */
export function focusedResourceDedupeKey(ref: ChatFocusedResourceRef): string {
  if (ref.kind === "workspace-artifact") {
    return `workspace-artifact:${ref.artifactId}`;
  }
  return `local-file:${ref.relayId}:${ref.path}`;
}

/**
 * D423 — kind-specific stable dedupe key for a resolved manifest entry. Mirrors
 * {@link focusedResourceDedupeKey} so legacy-adapted entries and newly-resolved
 * entries for the same underlying resource collapse.
 */
export function resolvedFocusedResourceDedupeKey(resource: ResolvedFocusedResource): string {
  if (resource.kind === "workspace-artifact") {
    const locator = resource.locator as { artifactId?: string } | string | undefined;
    const artifactId =
      typeof locator === "string" ? locator : (locator?.artifactId ?? "");
    return `workspace-artifact:${artifactId}`;
  }
  if (resource.kind === "message-attachment") {
    const locator = resource.locator as { attachmentId?: string } | string | undefined;
    const attachmentId =
      typeof locator === "string" ? locator : (locator?.attachmentId ?? "");
    return `message-attachment:${attachmentId}`;
  }
  const locator = resource.locator as { relayId?: string; path?: string } | undefined;
  return `local-file:${locator?.relayId ?? ""}:${locator?.path ?? ""}`;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isAbsoluteLocalPath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith("/")) return true;
  // Windows drive root, e.g. C:\ or C:/
  return /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * D423 — parse the wire `focusedResources` array. Shape + bounds only;
 * authority (namespace access, relay ownership/profile) is enforced by the
 * kind resolvers. Rejects empty/control-character/oversized fields,
 * non-absolute local paths, names containing separators, and over-cap arrays.
 */
export function parseChatFocusedResourceRefs(raw: unknown): ChatFocusedResourceRef[] {
  if (raw == null) return [];
  if (!isUnknownArray(raw)) {
    throw new Error("focusedResources must be an array");
  }
  if (raw.length > MAX_FOCUSED_RESOURCES) {
    throw new Error(`focusedResources exceeds maximum of ${MAX_FOCUSED_RESOURCES}`);
  }
  const out: ChatFocusedResourceRef[] = [];
  for (let index = 0; index < raw.length; index++) {
    const item: unknown = raw[index];
    if (!item || typeof item !== "object") {
      throw new Error(`focusedResources[${index}] must be an object`);
    }
    const candidate = item as Record<string, unknown>;
    const kind = candidate["kind"];
    if (kind === "workspace-artifact") {
      const artifactId = candidate["artifactId"];
      if (typeof artifactId !== "string" || artifactId.trim().length === 0) {
        throw new Error(`focusedResources[${index}].artifactId must be a non-empty string`);
      }
      if (CONTROL_CHAR_RE.test(artifactId)) {
        throw new Error(`focusedResources[${index}].artifactId contains control characters`);
      }
      if (artifactId.length > MAX_ARTIFACT_ID_LEN) {
        throw new Error(`focusedResources[${index}].artifactId exceeds maximum length`);
      }
      out.push({ kind: "workspace-artifact", artifactId });
      continue;
    }
    if (kind === "local-file") {
      const path = candidate["path"];
      const rootPath = candidate["rootPath"];
      const name = candidate["name"];
      const relayId = candidate["relayId"];
      if (typeof path !== "string" || !path) {
        throw new Error(`focusedResources[${index}].path must be a non-empty string`);
      }
      if (!isAbsoluteLocalPath(path)) {
        throw new Error(`focusedResources[${index}].path must be an absolute path`);
      }
      if (CONTROL_CHAR_RE.test(path) || path.length > MAX_LOCAL_FILE_FIELD_LEN) {
        throw new Error(`focusedResources[${index}].path is malformed or too long`);
      }
      if (typeof rootPath !== "string" || !isAbsoluteLocalPath(rootPath)) {
        throw new Error(`focusedResources[${index}].rootPath must be an absolute path`);
      }
      if (CONTROL_CHAR_RE.test(rootPath) || rootPath.length > MAX_LOCAL_FILE_FIELD_LEN) {
        throw new Error(`focusedResources[${index}].rootPath is malformed or too long`);
      }
      if (typeof name !== "string" || !name) {
        throw new Error(`focusedResources[${index}].name must be a non-empty string`);
      }
      if (CONTROL_CHAR_RE.test(name) || /[\\/]/.test(name) || name.length > 255) {
        throw new Error(
          `focusedResources[${index}].name must be a bounded basename (no separators)`,
        );
      }
      if (typeof relayId !== "string" || relayId.trim().length === 0) {
        throw new Error(`focusedResources[${index}].relayId must be a non-empty string`);
      }
      if (CONTROL_CHAR_RE.test(relayId) || relayId.length > MAX_RELAY_ID_LEN) {
        throw new Error(`focusedResources[${index}].relayId is malformed or too long`);
      }
      out.push({ kind: "local-file", path, rootPath, name, relayId });
      continue;
    }
    throw new Error(`focusedResources[${index}].kind must be a supported focus-ref kind`);
  }
  return out;
}

/** Context handed to every kind resolver. Capabilities are server-derived. */
export interface FocusResolverContext {
  readableNamespaceIds: readonly string[];
  /**
   * D423 4.1.3 — the sending actor id (the authenticated user owning the
   * turn). The local-file resolver validates the focused relay is owned by
   * this actor before producing any manifest entry.
   */
  senderActorId?: string | undefined;
  /**
   * D423 4.1.3 — the trusted current-folder context for this turn
   * (server-validated, advisory per D304). The local-file resolver derives
   * `zone:"current"` when the ref path lies under this folder, else
   * `zone:"absolute"`. Never the client `rootPath`.
   */
  currentFolder?: string | null;
  /**
   * D423 4.1.3 — connected-relay registry used to validate sender/relay
   * ownership, protocol version, and `localFileExecution`. When absent the
   * local-file resolver fails closed (no manifest entry, no read, no upload).
   */
  relayRegistry?: FocusedResourceRelayRegistry | null;
}

/**
 * D423 4.1.3 — narrow registry port for local-file relay validation.
 * Structurally satisfied by `@nautilo/runtime::InMemoryRelayRegistry`'s
 * `snapshotForFocusedResource`. Declared here so this module does not depend
 * on the full runtime registry surface.
 */
export interface FocusedResourceRelayRegistry {
  snapshotForFocusedResource(
    relayId: string,
    actorId: string,
  ): FocusedResourceRelaySnapshot | null;
}

/** D423 4.1.3 — server-private snapshot of a connected relay. */
export interface FocusedResourceRelaySnapshot {
  ownedByActor: boolean;
  protocolVersion: number;
  profile: "device-relay" | "desktop-agent";
  localFileExecution: boolean;
  allowedRoots: readonly string[];
  canRunOffice: boolean;
}

/**
 * D423 — a kind-keyed resolver. Input is client identity only; output
 * metadata/capabilities/toolTarget are authoritative. Returns `null` to fail
 * closed (drop the ref) — never throws for an unavailable/unauthorized ref.
 */
export interface FocusKindResolver {
  readonly kind: ChatFocusedResourceRef["kind"];
  resolve(
    ref: ChatFocusedResourceRef,
    ctx: FocusResolverContext,
  ): Promise<ResolvedFocusedResource | null>;
}

/**
 * D423 — registry keyed by `kind`. Adding a future resource kind requires
 * registering a resolver here plus tests — not another composer pipeline.
 */
export class FocusResolverRegistry {
  private readonly resolvers = new Map<string, FocusKindResolver>();

  register(resolver: FocusKindResolver): void {
    this.resolvers.set(resolver.kind, resolver);
  }

  has(kind: string): boolean {
    return this.resolvers.has(kind);
  }

  resolve(
    ref: ChatFocusedResourceRef,
    ctx: FocusResolverContext,
  ): Promise<ResolvedFocusedResource | null> {
    const resolver = this.resolvers.get(ref.kind);
    if (!resolver) {
      log(`[focused-resources] no resolver registered for kind=${ref.kind}; dropping ref`);
      return Promise.resolve(null);
    }
    return resolver.resolve(ref, ctx);
  }
}

/**
 * D423 — workspace-artifact resolver. Reuses the DB-backed
 * {@link resolveChatArtifactRefs} so a `focusedResources[].kind:
 * "workspace-artifact"` ref gets the SAME authoritative namespace resolution
 * as a legacy `artifactRefs` entry. Client metadata is replaced by DB values.
 */
class WorkspaceArtifactResolver implements FocusKindResolver {
  readonly kind = "workspace-artifact" as const;

  async resolve(
    ref: Extract<ChatFocusedResourceRef, { kind: "workspace-artifact" }>,
    ctx: FocusResolverContext,
  ): Promise<ResolvedFocusedResource | null> {
    if (ctx.readableNamespaceIds.length === 0) return null;
    // Placeholder metadata is overwritten by DB-authoritative values inside
    // resolveChatArtifactRefs; the client never supplies authoritative bytes.
    const resolved = await resolveChatArtifactRefs({
      refs: [
        {
          artifactId: ref.artifactId,
          path: "",
          mimeType: "application/octet-stream",
          size: 0,
        },
      ],
      readableNamespaceIds: ctx.readableNamespaceIds,
    });
    if (resolved.length === 0) return null;
    const adapted = adaptResolvedArtifactRefs(resolved);
    return adapted[0] ?? null;
  }
}

/**
 * D423 4.1.3 — the local-file resolver. A local-file focus ref resolves to a
 * `ResolvedFocusedResource` ONLY after server-side actor/relay validation:
 *
 *   1. `ctx.relayRegistry` is present (server booted with a relay registry).
 *   2. The relay is currently connected (snapshot non-null).
 *   3. The relay is owned by the sending actor (`ownedByActor`).
 *   4. Protocol v4+ (the `local-file` execution class gate, M174/M206).
 *   5. `profile:"desktop-agent"` (headless `device-relay` relays cannot
 *      execute local-file ops).
 *   6. `localFileExecution:true` (the relay advertises typed local-file
 *      dispatch).
 *
 * On ANY failure the ref is dropped (resolver returns `null`) — no byte read,
 * no upload, no fallback device switch. The orchestrator reserves the dedupe
 * key so a duplicate ref later in the array is not retried.
 *
 * Zone derivation: `zone:"current"` when `ctx.currentFolder` is a trusted,
 * absolute folder AND the ref path lies textually under it (the relay reruns
 * realpath/symlink guards at execution time per M206 — this resolver does NOT
 * authorize filesystem access). Otherwise `zone:"absolute"`. The client
 * `rootPath` is advisory only and is NEVER used as authority.
 *
 * Privacy: `displayName` is the bounded basename only; `locator` retains the
 * private `{ relayId, path }` (never prompt prose); `toolTarget.path` is the
 * model-facing path — relative to the current folder for `current`, absolute
 * for `absolute`. Capabilities are relay-derived (`localFileExecution`,
 * `canRunOffice`) — never inferred from the file extension.
 */
class LocalFileResolver implements FocusKindResolver {
  readonly kind = "local-file" as const;

  resolve(
    ref: Extract<ChatFocusedResourceRef, { kind: "local-file" }>,
    ctx: FocusResolverContext,
  ): Promise<ResolvedFocusedResource | null> {
    const registry = ctx.relayRegistry ?? null;
    const actorId = ctx.senderActorId ?? "";
    if (!registry) {
      log(
        `[focused-resources] local-file ref dropped: no relay registry ` +
          `(server booted without one) name=${redact(ref.name)}`,
      );
      return Promise.resolve(null);
    }
    if (!actorId) {
      log(
        `[focused-resources] local-file ref dropped: no authenticated sender ` +
          `actor name=${redact(ref.name)}`,
      );
      return Promise.resolve(null);
    }
    let snapshot: FocusedResourceRelaySnapshot | null = null;
    try {
      snapshot = registry.snapshotForFocusedResource(ref.relayId, actorId);
    } catch (err) {
      log(
        `[focused-resources] local-file ref dropped: relay registry threw ` +
          `name=${redact(ref.name)} err=${
            err instanceof Error ? err.message : String(err)
          }`,
      );
      return Promise.resolve(null);
    }
    if (snapshot === null) {
      log(
        `[focused-resources] local-file ref dropped: relay not connected ` +
          `name=${redact(ref.name)}`,
      );
      return Promise.resolve(null);
    }
    if (!snapshot.ownedByActor) {
      log(
        `[focused-resources] local-file ref dropped: relay not owned by ` +
          `sender name=${redact(ref.name)}`,
      );
      return Promise.resolve(null);
    }
    if (snapshot.protocolVersion < 4) {
      log(
        `[focused-resources] local-file ref dropped: relay protocol ` +
          `${snapshot.protocolVersion} < v4 name=${redact(ref.name)}`,
      );
      return Promise.resolve(null);
    }
    if (snapshot.profile !== "desktop-agent") {
      log(
        `[focused-resources] local-file ref dropped: relay profile ` +
          `${snapshot.profile} is not desktop-agent name=${redact(ref.name)}`,
      );
      return Promise.resolve(null);
    }
    if (!snapshot.localFileExecution) {
      log(
        `[focused-resources] local-file ref dropped: relay does not advertise ` +
          `localFileExecution name=${redact(ref.name)}`,
      );
      return Promise.resolve(null);
    }

    const { zone, modelPath } = deriveLocalFileTarget(ref.path, ctx.currentFolder ?? null);

    const capabilities: ResolvedFocusedResource["capabilities"] = [
      "read",
      "edit",
      ...(snapshot.canRunOffice ? (["convert"] as const) : []),
    ];

    const resource: ResolvedFocusedResource = {
      kind: "local-file",
      displayName: ref.name,
      location: "relay",
      lifetime: "turn",
      capabilities,
      toolTarget: { tool: "file", zone, path: modelPath },
      locator: { relayId: ref.relayId, path: ref.path },
    };
    return Promise.resolve(resource);
  }
}

/**
 * D423 4.1.3 — derive the model-facing `file` target for a local-file ref.
 * `zone:"current"` (with a path relative to the current folder) when the path
 * lies textually under the trusted current-folder context; otherwise
 * `zone:"absolute"` (with the normalized absolute path). Lexical containment
 * only — the relay reruns realpath/symlink guards at execution time (M206).
 */
function deriveLocalFileTarget(
  rawPath: string,
  currentFolder: string | null,
): { zone: "current" | "absolute"; modelPath: string } {
  const resolvedPath = path.normalize(rawPath);
  if (currentFolder && path.isAbsolute(currentFolder)) {
    const folder = path.normalize(currentFolder);
    const folderWithSep = folder.endsWith(path.sep) ? folder : folder + path.sep;
    if (resolvedPath === folder || resolvedPath.startsWith(folderWithSep)) {
      const rel = path.relative(folder, resolvedPath);
      // `path.relative` of a contained path is forward (no leading `..`).
      // Guard against an empty result (the folder itself) by falling back
      // to "." so the model-facing path is always well-formed.
      return { zone: "current", modelPath: rel === "" ? "." : rel };
    }
  }
  return { zone: "absolute", modelPath: resolvedPath };
}

function redact(value: string): string {
  // Never log raw private locators verbatim; surface a bounded, sanitized hint.
  // eslint-disable-next-line no-control-regex
  const safe = value.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 64);
  return safe.length === value.length ? safe : `${safe}…`;
}

/** D423 — the default registry: workspace-artifact (DB-backed) + local-file (relay-validated, fail-closed). */
export function createDefaultFocusResolverRegistry(): FocusResolverRegistry {
  const registry = new FocusResolverRegistry();
  registry.register(new WorkspaceArtifactResolver());
  registry.register(new LocalFileResolver());
  return registry;
}

/**
 * D423 — build ONE authoritative manifest from all three input lanes:
 *   - legacy `artifactRefs`  → already DB-resolved → artifact adapter
 *   - D271 `attachments`     → already normalized   → attachment adapter
 *   - new `focusedResources` → kind-keyed registry  → workspace-artifact / local-file
 *
 * Dedupe is kind-specific and global across lanes (a workspace artifact
 * arriving via both `artifactRefs` and `focusedResources` collapses to one
 * entry). The manifest preserves each resource's original authority/lifetime;
 * it does NOT merge D271 attachment lifecycle into focus-ref semantics.
 */
export async function resolveFocusedResources(args: {
  focusedResourceRefs: readonly ChatFocusedResourceRef[];
  /** Legacy lane — already DB-resolved + namespace-validated upstream. */
  resolvedArtifactRefs: readonly ChatArtifactRef[];
  /** D271 lane — already normalized (capabilities gated) upstream. */
  attachmentStatuses: readonly ChatAttachmentStatus[];
  readableNamespaceIds: readonly string[];
  /**
   * D423 4.1.3 — sending actor id (authenticated user owning the turn).
   * Required for local-file relay ownership validation; absent ⇒ local-file
   * refs fail closed.
   */
  senderActorId?: string | undefined;
  /**
   * D423 4.1.3 — trusted current-folder context (server-validated). Drives
   * `zone:"current"` vs `zone:"absolute"` for local-file refs.
   */
  currentFolder?: string | null;
  /**
   * D423 4.1.3 — connected-relay registry for local-file validation. Absent
   * ⇒ local-file refs fail closed (no manifest entry, no read, no upload).
   */
  relayRegistry?: FocusedResourceRelayRegistry | null;
  /** Inject a custom registry in tests; production uses the default. */
  registry?: FocusResolverRegistry;
}): Promise<ResolvedFocusedResource[]> {
  const registry = args.registry ?? createDefaultFocusResolverRegistry();
  const ctx: FocusResolverContext = {
    readableNamespaceIds: args.readableNamespaceIds,
    senderActorId: args.senderActorId,
    currentFolder: args.currentFolder ?? null,
    relayRegistry: args.relayRegistry ?? null,
  };

  const manifest: ResolvedFocusedResource[] = [];
  const seen = new Set<string>();

  const push = (resource: ResolvedFocusedResource | null | undefined): void => {
    if (!resource) return;
    const key = resolvedFocusedResourceDedupeKey(resource);
    if (seen.has(key)) return;
    seen.add(key);
    manifest.push(resource);
  };

  // Legacy artifact lane → adapter. DB-authoritative metadata already applied.
  for (const resource of adaptResolvedArtifactRefs(args.resolvedArtifactRefs)) {
    push(resource);
  }

  // D271 attachment lane → adapter. Only accepted attachments enter the
  // manifest; rejected/stub/blocked entries never reach the model this way.
  for (const resource of adaptNormalizedAttachments(args.attachmentStatuses)) {
    push(resource);
  }

  // New generic focus refs → kind-keyed resolver. Local-file fails closed.
  for (const ref of args.focusedResourceRefs) {
    const key = focusedResourceDedupeKey(ref);
    if (seen.has(key)) continue;
    const resource = await registry.resolve(ref, ctx);
    if (!resource) {
      // Failed closed (unauthorized / unavailable / not-implemented resolver).
      // Reserve the key so a duplicate ref later in the array is not retried.
      seen.add(key);
      continue;
    }
    push(resource);
  }

  return manifest;
}
