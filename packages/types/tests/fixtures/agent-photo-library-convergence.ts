import {
  agentPhotoLibraryCurrentResponseSchema,
  agentPhotoLibraryListResponseSchema,
  agentPhotoLibraryPresetsResponseSchema,
  type AgentPhotoLibraryCurrentResponse,
  type AgentPhotoLibraryEntryDto,
  type AgentPhotoLibraryListResponse,
  type AgentPhotoLibraryPresetsResponse,
  type AgentPhotoSelectionTargetDto,
} from "../../src/agent-photo-library";

type AgentPhotoAvatarRef = NonNullable<AgentPhotoLibraryCurrentResponse["current"]["avatarRef"]>;

export const convergenceIds = {
  serverInstanceId: "11111111-1111-4111-8111-111111111111",
  viewerUserId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  currentEntryId: "44444444-4444-4444-8444-444444444444",
  desktopEntryId: "55555555-5555-4555-8555-555555555555",
  mobileEntryId: "66666666-6666-4666-8666-666666666666",
  deletedEntryId: "77777777-7777-4777-8777-777777777777",
  missingEntryId: "88888888-8888-4888-8888-888888888888",
  undoRevisionId: "99999999-9999-4999-8999-999999999999",
} as const;

type OwnedEntry = Omit<AgentPhotoLibraryEntryDto, "isCurrent"> & {
  avatarRef: Exclude<AgentPhotoAvatarRef, { kind: "preset" }>;
};

export type ConvergenceClientState = {
  current: AgentPhotoLibraryCurrentResponse;
  recent: AgentPhotoLibraryEntryDto[];
  recentPages: AgentPhotoLibraryListResponse[];
  deleted: AgentPhotoLibraryEntryDto[];
  presets: AgentPhotoLibraryPresetsResponse;
};

/**
 * A deterministic canonical-server model shared by desktop and mobile tests.
 * Every response is parsed through the public DTO schemas, so a client cannot
 * pass this fixture by relying on a private or legacy avatar shape.
 */
export class AgentPhotoLibraryConvergenceFixture {
  #selectionRevision = 1;
  #libraryRevision = 1;
  #currentEntryId: string | null = convergenceIds.currentEntryId;
  #currentAvatarRef: AgentPhotoAvatarRef | null = { kind: "uploaded", blobId: "blob-current" };
  readonly #entries: OwnedEntry[] = [
    ownedEntry(convergenceIds.currentEntryId, "upload", "workbench", "2026-08-04T10:00:00.000Z", "blob-current"),
    ownedEntry(convergenceIds.desktopEntryId, "generation", "workbench", "2026-08-04T11:00:00.000Z", "blob-desktop"),
    ownedEntry(convergenceIds.mobileEntryId, "upload", "mobile", "2026-08-04T12:00:00.000Z", "blob-mobile"),
    {
      ...ownedEntry(convergenceIds.deletedEntryId, "generation", "mobile", "2026-08-04T09:00:00.000Z", "blob-deleted"),
      deletedAt: "2026-08-04T13:00:00.000Z",
      purgeAfter: "2026-09-03T13:00:00.000Z",
    },
  ];

  current(): AgentPhotoLibraryCurrentResponse {
    const scope = this.#scope();
    return agentPhotoLibraryCurrentResponseSchema.parse({
      current: {
        avatarRef: this.#currentAvatarRef,
        entryId: this.#currentEntryId,
        lastUndoableRevisionId: convergenceIds.undoRevisionId,
        scope,
      },
      scope,
    });
  }

  presets(): AgentPhotoLibraryPresetsResponse {
    return agentPhotoLibraryPresetsResponseSchema.parse({
      presets: [
        { id: "avatar-01", thumbnailUrl: "/api/onboarding/images/avatars/avatar-01.webp" },
        { id: "avatar-02", thumbnailUrl: "/api/onboarding/images/avatars/avatar-02.webp" },
      ],
      scope: this.#scope(),
    });
  }

  list(input: { projection: "recent" | "deleted"; limit: number; cursor?: string }): AgentPhotoLibraryListResponse {
    const candidates = this.#entries
      .filter((entry) => input.projection === "deleted" ? entry.deletedAt !== null : entry.deletedAt === null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const offset = input.cursor ? this.#parseCursor(input.cursor, input.projection) : 0;
    const entries = candidates.slice(offset, offset + input.limit).map((entry) => this.#project(entry));
    const nextOffset = offset + entries.length;
    return agentPhotoLibraryListResponseSchema.parse({
      entries,
      nextCursor: nextOffset < candidates.length
        ? `${input.projection}:${nextOffset}:${this.#libraryRevision}`
        : null,
      scope: this.#scope(),
    });
  }

  entry(entryId: string): AgentPhotoLibraryEntryDto | null {
    const entry = this.#entries.find((candidate) => candidate.id === entryId);
    return entry ? this.#project(entry) : null;
  }

  select(_client: "desktop" | "mobile", target: AgentPhotoSelectionTargetDto): void {
    if (target.kind === "preset") {
      this.#currentEntryId = null;
      this.#currentAvatarRef = { kind: "preset", id: target.presetId };
    } else if (target.kind === "clear") {
      this.#currentEntryId = null;
      this.#currentAvatarRef = null;
    } else {
      const entry = this.#entries.find((candidate) => candidate.id === target.entryId && candidate.deletedAt === null);
      if (!entry) throw new Error("photo_not_found");
      this.#currentEntryId = entry.id;
      this.#currentAvatarRef = entry.avatarRef;
    }
    this.#selectionRevision += 1;
  }

  createClient(name: "desktop" | "mobile"): AgentPhotoConvergenceClient {
    return new AgentPhotoConvergenceClient(name, this);
  }

  #project(entry: OwnedEntry): AgentPhotoLibraryEntryDto {
    const { avatarRef: _avatarRef, ...metadata } = entry;
    return { ...metadata, isCurrent: entry.id === this.#currentEntryId };
  }

  #scope() {
    return {
      serverInstanceId: convergenceIds.serverInstanceId,
      viewerUserId: convergenceIds.viewerUserId,
      agentId: convergenceIds.agentId,
      selectionRevision: String(this.#selectionRevision),
      libraryRevision: String(this.#libraryRevision),
    };
  }

  #parseCursor(cursor: string, projection: "recent" | "deleted"): number {
    const [cursorProjection, rawOffset, rawRevision] = cursor.split(":");
    if (cursorProjection !== projection || rawRevision !== String(this.#libraryRevision)) throw new Error("invalid_cursor");
    const offset = Number(rawOffset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid_cursor");
    return offset;
  }
}

export class AgentPhotoConvergenceClient {
  #generation = 0;
  state: ConvergenceClientState | null = null;

  constructor(
    readonly name: "desktop" | "mobile",
    private readonly fixture: AgentPhotoLibraryConvergenceFixture,
  ) {}

  beginRefresh(): { snapshot: ConvergenceClientState; commit: () => boolean } {
    const requestGeneration = ++this.#generation;
    const snapshot = this.#snapshot();
    return {
      snapshot,
      commit: () => {
        if (requestGeneration !== this.#generation) return false;
        this.state = snapshot;
        return true;
      },
    };
  }

  refresh(): ConvergenceClientState {
    const refresh = this.beginRefresh();
    if (!refresh.commit()) throw new Error("stale_refresh");
    return refresh.snapshot;
  }

  #snapshot(): ConvergenceClientState {
    const current = this.fixture.current();
    const recentPages: AgentPhotoLibraryListResponse[] = [];
    let cursor: string | undefined;
    do {
      const page = this.fixture.list({ projection: "recent", limit: 2, ...(cursor ? { cursor } : {}) });
      recentPages.push(page);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return {
      current,
      recentPages,
      recent: recentPages.flatMap((page) => page.entries),
      deleted: this.fixture.list({ projection: "deleted", limit: 2 }).entries,
      presets: this.fixture.presets(),
    };
  }
}

function ownedEntry(
  id: string,
  source: "upload" | "generation",
  origin: "workbench" | "mobile",
  createdAt: string,
  blobId: string,
): OwnedEntry {
  return {
    id,
    source,
    origin,
    createdAt,
    deletedAt: null,
    purgeAfter: null,
    avatarRef: { kind: source === "generation" ? "generated" : "uploaded", blobId },
    media: {
      thumbnailUrl: `/api/profile/agent-photo-library/entries/${id}/media?size=thumb`,
      fullUrl: `/api/profile/agent-photo-library/entries/${id}/media?size=full`,
    },
  };
}
