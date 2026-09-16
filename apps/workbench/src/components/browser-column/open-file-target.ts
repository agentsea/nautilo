/**
 * The target the workbench's reader-surface drawer opens.
 *
 * `id` (artifact variant) is the artifact row's INTERNAL uuid (stable
 * across renames, URL-safe). This is the value the
 * `/api/workspace/artifacts/:id/...` routes consume, NOT the agent-chosen
 * external `artifactId` from `ArtifactDto.artifactId` — that one is used
 * for cited-paths glyph matching against tool-event envelopes and is NOT
 * URL-safe (may contain `/`).
 */
export type OpenFileTarget =
  | {
      kind: "fs";
      path: string;
      rootPath: string;
      reloadToken?: number;
    }
  | {
      kind: "artifact";
      id: string;
      path: string;
      mimeType: string;
      roomId?: string;
      /** Authoritative artifact metadata when the opener has it. */
      sizeBytes?: number;
      /** Bumped by the shell when an already-open artifact changes on disk/server. */
      reloadToken?: number;
    };

/** Stable identity used to synchronize the open work surface with the Workspace tree. */
export type ActiveArtifactTarget = Pick<
  Extract<OpenFileTarget, { kind: "artifact" }>,
  "id" | "path"
>;

/** Close an access-lost viewer only when its stable internal id is in the managed set. */
export function shouldCloseManagedArtifactViewer(
  activeArtifact: ActiveArtifactTarget | null | undefined,
  managedArtifacts: readonly Pick<ActiveArtifactTarget, "id">[],
): boolean {
  return activeArtifact !== null
    && activeArtifact !== undefined
    && managedArtifacts.some((artifact) => artifact.id === activeArtifact.id);
}

/**
 * Builder for the FS variant. Lets call sites use a named function
 * (greppable, single source of truth for the wire shape) instead of
 * inlining the discriminator at every emit point. M088C item 4: a
 * future PR that drops `kind` from one of these emits would still
 * cause a TypeScript error here.
 */
export function fsOpenFileTarget(
  path: string,
  rootPath: string,
  reloadToken?: number,
): OpenFileTarget {
  return {
    kind: "fs",
    path,
    rootPath,
    ...(reloadToken !== undefined ? { reloadToken } : {}),
  };
}

/** Builder for the artifact variant. */
export function artifactOpenFileTarget(input: {
  id: string;
  path: string;
  mimeType: string;
  roomId?: string;
  sizeBytes?: number;
  reloadToken?: number;
}): OpenFileTarget {
  if (input.roomId !== undefined) {
    return {
      kind: "artifact",
      id: input.id,
      path: input.path,
      mimeType: input.mimeType,
      roomId: input.roomId,
      ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
      ...(input.reloadToken !== undefined ? { reloadToken: input.reloadToken } : {}),
    };
  }
  return {
    kind: "artifact",
    id: input.id,
    path: input.path,
    mimeType: input.mimeType,
    ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
    ...(input.reloadToken !== undefined ? { reloadToken: input.reloadToken } : {}),
  };
}

/**
 * Re-open a live artifact after the server reports that its bytes changed.
 * `sizeBytes` belongs to the previous revision and must not be carried into
 * the next bounded read: doing so makes a valid replacement with a different
 * length look like a torn/mutated response.
 */
export function reloadArtifactOpenFileTarget(
  target: Extract<OpenFileTarget, { kind: "artifact" }>,
  path = target.path,
): Extract<OpenFileTarget, { kind: "artifact" }> {
  const { sizeBytes: _staleSize, ...stableTarget } = target;
  return {
    ...stableTarget,
    path,
    reloadToken: (target.reloadToken ?? 0) + 1,
  };
}

/**
 * D322 — map a known-file reference (an auto-linkified mention in a genie's
 * prose) to the reader target that opens it. FS refs open by path+root;
 * artifact refs open by internal id + mime, room-scoped to the active room.
 * Pure so the link-click behavior is unit-testable without the DOM.
 */
export function openTargetForKnownRef(
  ref:
    | { kind: "fs"; path: string; rootPath: string }
    | { kind: "artifact"; path: string; artifactId: string; mimeType: string },
  activeRoomId: string | null | undefined,
): OpenFileTarget {
  if (ref.kind === "artifact") {
    return artifactOpenFileTarget({
      id: ref.artifactId,
      path: ref.path,
      mimeType: ref.mimeType,
      ...(activeRoomId ? { roomId: activeRoomId } : {}),
    });
  }
  return fsOpenFileTarget(ref.path, ref.rootPath);
}

/**
 * Runtime validator for `OpenFileTarget`. Used by `requestOpenFile`
 * (M088C item 4) to reject shape-invalid payloads before dispatch
 * rather than letting them propagate to the viewer drawer where the
 * artifact branch would 404 against the API.
 */
export function isOpenFileTarget(x: unknown): x is OpenFileTarget {
  if (x == null || typeof x !== "object") return false;
  const obj = x as Record<string, unknown>;
  if (obj["kind"] === "fs") {
    return typeof obj["path"] === "string" && typeof obj["rootPath"] === "string";
  }
  if (obj["kind"] === "artifact") {
    return (
      typeof obj["id"] === "string" &&
      typeof obj["path"] === "string" &&
      typeof obj["mimeType"] === "string"
    );
  }
  return false;
}
