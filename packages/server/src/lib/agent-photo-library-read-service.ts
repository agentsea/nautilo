import {
  agentPhotoSelectionRevisions,
  and,
  eq,
  findOwnedAgentPhotoEntry,
  listOwnedAgentPhotoEntries,
  ownedPhotoEntries,
  type DirectDatabase,
  type OwnedPhotoEntry,
} from "@nautilo/db";
import type { AvatarRef } from "@nautilo/types";
import {
  AgentPhotoLibraryError,
  validateAgentPhotoLibraryAuthority,
  type AgentPhotoLibraryAuthority,
  type AgentPhotoLibraryProfileSnapshot,
  type AgentPhotoLibraryScope,
  type PhotoBlobPresenceInput,
} from "./agent-photo-library-service";
import type { PhotoLibraryProjection } from "../photo-library/photo-library-cursor";

export interface AgentPhotoLibraryEntry {
  readonly id: string;
  readonly source: string;
  readonly origin: string;
  readonly createdAt: string;
  readonly deletedAt: string | null;
  readonly purgeAfter: string | null;
  readonly isCurrent: boolean;
  readonly media: {
    readonly thumbnailUrl: string;
    /** Only entry detail exposes the explicit full-media capability. */
    readonly fullUrl?: string;
  };
}

export interface AgentPhotoLibraryCurrent {
  readonly avatarRef: AvatarRef | null;
  readonly entryId: string | null;
  readonly lastUndoableRevisionId: string | null;
  readonly scope: AgentPhotoLibraryScope;
}

export interface AgentPhotoLibraryList {
  readonly entries: readonly AgentPhotoLibraryEntry[];
  readonly next: { readonly createdAtMicros: string; readonly id: string } | null;
  readonly scope: AgentPhotoLibraryScope;
}

export interface AgentPhotoLibraryReadDependencies {
  readonly db: DirectDatabase;
  readonly blobExists: (input: PhotoBlobPresenceInput) => boolean | Promise<boolean>;
  readonly now?: () => Date;
}

type ReadTransaction = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function libraryError(
  code: ConstructorParameters<typeof AgentPhotoLibraryError>[0]["code"],
  message: string,
  retryable = false,
): AgentPhotoLibraryError {
  return new AgentPhotoLibraryError({ code, message, retryable });
}

function isCustomAvatarRef(
  avatarRef: AvatarRef | null,
): avatarRef is Extract<AvatarRef, { kind: "generated" | "uploaded" }> {
  return avatarRef !== null && avatarRef.kind !== "preset";
}

function scopeFor(
  authority: AgentPhotoLibraryAuthority,
  profile: AgentPhotoLibraryProfileSnapshot,
): AgentPhotoLibraryScope {
  return {
    serverInstanceId: authority.serverInstanceId,
    viewerUserId: authority.viewerUserId,
    agentId: authority.agentId,
    selectionRevision: String(profile.avatarSelectionRevision),
    libraryRevision: String(profile.avatarLibraryRevision),
  };
}

function mediaUrls(entryId: string, detail: boolean): AgentPhotoLibraryEntry["media"] {
  const base = `/api/profile/agent-photo-library/entries/${encodeURIComponent(entryId)}/media`;
  return {
    thumbnailUrl: `${base}?size=thumb&v=${encodeURIComponent(entryId)}`,
    ...(detail ? { fullUrl: `${base}?size=full&v=${encodeURIComponent(entryId)}` } : {}),
  };
}

function projectEntry(
  entry: OwnedPhotoEntry,
  currentEntryId: string | null,
  detail = false,
): AgentPhotoLibraryEntry {
  return {
    id: entry.id,
    source: entry.source,
    origin: entry.origin,
    createdAt: entry.createdAt.toISOString(),
    deletedAt: entry.deletedAt?.toISOString() ?? null,
    purgeAfter: entry.purgeAfter?.toISOString() ?? null,
    isCurrent: entry.id === currentEntryId,
    media: mediaUrls(entry.id, detail),
  };
}

/**
 * Read half of the D487 service boundary. Routes provide only a session-bound
 * authority tuple; this service rechecks durable server identity, profile
 * ownership, and the agents mirror before every projection.
 */
export class AgentPhotoLibraryReadService {
  readonly #dependencies: AgentPhotoLibraryReadDependencies;

  constructor(dependencies: AgentPhotoLibraryReadDependencies) {
    this.#dependencies = dependencies;
  }

  async current(authority: AgentPhotoLibraryAuthority): Promise<AgentPhotoLibraryCurrent> {
    return this.#readSnapshot(async (tx) => {
      const profile = await validateAgentPhotoLibraryAuthority(tx, authority, "read");
      const current = await this.#currentEntry(tx, authority, profile.avatarRef);
      const [revision] = profile.avatarSelectionRevision === 0
        ? []
        : await tx
          .select({ id: agentPhotoSelectionRevisions.id })
          .from(agentPhotoSelectionRevisions)
          .where(and(
            eq(agentPhotoSelectionRevisions.serverInstanceId, authority.serverInstanceId),
            eq(agentPhotoSelectionRevisions.ownerUserId, authority.ownerUserId),
            eq(agentPhotoSelectionRevisions.agentId, authority.agentId),
            eq(agentPhotoSelectionRevisions.revision, profile.avatarSelectionRevision),
          ))
            .limit(1);
      return {
        avatarRef: profile.avatarRef,
        entryId: current?.id ?? null,
        lastUndoableRevisionId: revision?.id ?? null,
        scope: scopeFor(authority, profile),
      };
    });
  }

  async list(
    authority: AgentPhotoLibraryAuthority,
    input: {
      readonly projection: PhotoLibraryProjection;
      readonly limit: number;
      readonly cursor?: { readonly createdAtMicros: string; readonly id: string };
      readonly expectedLibraryRevision?: string;
    },
  ): Promise<AgentPhotoLibraryList> {
    return this.#readSnapshot(async (tx) => {
      const profile = await validateAgentPhotoLibraryAuthority(tx, authority, "read");
      const actualLibraryRevision = String(profile.avatarLibraryRevision);
      if (input.expectedLibraryRevision && input.expectedLibraryRevision !== actualLibraryRevision) {
        throw new AgentPhotoLibraryError({
          code: "stale_library_revision",
          message: "The photo library changed; refresh and try again",
          retryable: false,
          scope: scopeFor(authority, profile),
        });
      }
      const page = await listOwnedAgentPhotoEntries(tx, {
        scope: authority,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        deleted: input.projection === "deleted",
        now: this.#now(),
      });
      const current = await this.#catalogueCurrentEntry(tx, authority, profile.avatarRef);
      return {
        entries: page.entries.map((entry) => projectEntry(entry, current?.id ?? null)),
        next: page.nextCursor,
        scope: scopeFor(authority, profile),
      };
    });
  }

  async presets(authority: AgentPhotoLibraryAuthority): Promise<{ readonly scope: AgentPhotoLibraryScope }> {
    return this.#readSnapshot(async (tx) => {
      const profile = await validateAgentPhotoLibraryAuthority(tx, authority, "read");
      return { scope: scopeFor(authority, profile) };
    });
  }

  async entry(authority: AgentPhotoLibraryAuthority, entryId: string): Promise<{
    readonly entry: AgentPhotoLibraryEntry;
    readonly scope: AgentPhotoLibraryScope;
  }> {
    if (!UUID_PATTERN.test(entryId)) throw libraryError("invalid_photo_request", "Photo entry id must be a UUID");
    return this.#readSnapshot(async (tx) => {
      const profile = await validateAgentPhotoLibraryAuthority(tx, authority, "read");
      const entry = await findOwnedAgentPhotoEntry(tx, authority, entryId);
      if (!entry) throw libraryError("photo_not_found", "The requested Agent photo is unavailable");
      const current = await this.#catalogueCurrentEntry(tx, authority, profile.avatarRef);
      return { entry: projectEntry(entry, current?.id ?? null, true), scope: scopeFor(authority, profile) };
    });
  }

  /** Internal media resolution; the route reads only this exact known entry. */
  async media<T>(
    authority: AgentPhotoLibraryAuthority,
    entryId: string,
    size: "thumb" | "full",
    readAuthorizedMedia: (entry: OwnedPhotoEntry) => Promise<T | null>,
  ): Promise<{
    readonly media: T;
    readonly scope: AgentPhotoLibraryScope;
  }> {
    if (!UUID_PATTERN.test(entryId)) throw libraryError("invalid_photo_request", "Photo entry id must be a UUID");
    return this.#mediaSnapshot(async (tx) => {
      const profile = await validateAgentPhotoLibraryAuthority(tx, authority, "read");
      const [entry] = await tx
        .select()
        .from(ownedPhotoEntries)
        .where(and(
          eq(ownedPhotoEntries.serverInstanceId, authority.serverInstanceId),
          eq(ownedPhotoEntries.ownerUserId, authority.ownerUserId),
          eq(ownedPhotoEntries.subjectKind, "agent"),
          eq(ownedPhotoEntries.agentId, authority.agentId),
          eq(ownedPhotoEntries.id, entryId),
        ))
        .limit(1)
        .for("share");
      if (!entry) throw libraryError("photo_not_found", "The requested Agent photo is unavailable");
      const recoverableDeletedThumbnail = size === "thumb"
        && entry.deletedAt !== null
        && entry.purgeAfter !== null
        && entry.purgeAfter > this.#now()
        && entry.gcClaimedAt === null
        && entry.gcClaimToken === null;
      if (
        (entry.deletedAt !== null && !recoverableDeletedThumbnail)
        || entry.gcClaimedAt !== null
        || entry.gcClaimToken !== null
      ) {
        throw libraryError("photo_deleted", "The requested Agent photo is deleted");
      }
      if (entry.avatarKind !== "generated" && entry.avatarKind !== "uploaded") {
        throw libraryError("photo_library_unavailable", "The requested Agent photo has an invalid media kind", true);
      }
      const exists = await this.#dependencies.blobExists({
        entryId: entry.id,
        kind: entry.avatarKind,
        blobId: entry.blobId,
        mediaMimeType: entry.mediaMimeType,
        mediaByteSize: entry.mediaByteSize,
        mediaSha256: entry.mediaSha256,
      });
      if (!exists) throw libraryError("photo_blob_missing", "The requested Agent photo bytes are missing");
      const media = await readAuthorizedMedia(entry);
      if (media === null) throw libraryError("photo_blob_missing", "The requested Agent photo bytes are missing");
      return { media, scope: scopeFor(authority, profile) };
    });
  }

  async #currentEntry(
    tx: ReadTransaction,
    authority: AgentPhotoLibraryAuthority,
    avatarRef: AvatarRef | null,
  ): Promise<OwnedPhotoEntry | null> {
    if (!isCustomAvatarRef(avatarRef)) return null;
    const [entry] = await tx
      .select()
      .from(ownedPhotoEntries)
      .where(and(
        eq(ownedPhotoEntries.serverInstanceId, authority.serverInstanceId),
        eq(ownedPhotoEntries.ownerUserId, authority.ownerUserId),
        eq(ownedPhotoEntries.subjectKind, "agent"),
        eq(ownedPhotoEntries.agentId, authority.agentId),
        eq(ownedPhotoEntries.avatarKind, avatarRef.kind),
        eq(ownedPhotoEntries.blobId, avatarRef.blobId),
      ))
      .limit(1);
    if (!entry) throw libraryError("photo_not_found", "The current custom Agent photo is unavailable");
    if (entry.deletedAt !== null || entry.gcClaimedAt !== null || entry.gcClaimToken !== null) {
      throw libraryError("photo_library_unavailable", "The current Agent photo is no longer active", true);
    }
    return entry;
  }

  async #catalogueCurrentEntry(
    tx: ReadTransaction,
    authority: AgentPhotoLibraryAuthority,
    avatarRef: AvatarRef | null,
  ): Promise<OwnedPhotoEntry | null> {
    try {
      return await this.#currentEntry(tx, authority, avatarRef);
    } catch (error) {
      // A legacy profile can reference photo bytes that predate or no longer
      // have an owned-library row. Keep /current strict so clients can warn
      // about that broken selection, but do not let it hide otherwise healthy
      // Recent/Deleted catalogue entries that can repair the selection.
      if (error instanceof AgentPhotoLibraryError && error.code === "photo_not_found") return null;
      throw error;
    }
  }

  #readSnapshot<T>(work: (tx: ReadTransaction) => Promise<T>): Promise<T> {
    return this.#dependencies.db.transaction(work, {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  }

  #mediaSnapshot<T>(work: (tx: ReadTransaction) => Promise<T>): Promise<T> {
    return this.#dependencies.db.transaction(work, {
      isolationLevel: "repeatable read",
      accessMode: "read write",
    });
  }

  #now(): Date {
    return (this.#dependencies.now ?? (() => new Date()))();
  }
}
