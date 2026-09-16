import type { DirectDatabase } from "@nautilo/db";
import { and, eq, inArray, rooms } from "@nautilo/db";
import type { DurableRecordEnvelope } from "@nautilo/reflection/durable";
import type {
  CanonicalSourceAuthorityPort,
  CurrentRecordPublicationBindingPort,
  MaterializedAccessAudience,
  RecordAccessAudiencePort,
  RecordProductPostgresHandle,
  RecordRepositorySelection,
  RecordSearchBindingPort,
  RecordSearchCommitmentPort,
  ResolvedRecordSearchBinding,
  SameRoomSemanticBindingPort,
} from "@nautilo/reflection-bridge/server";
import { PostgresCurrentRecordPublicationBinding } from "@nautilo/reflection-bridge/server";
import {
  findOrCreateRecordAccessNamespace,
  findRoomByNamespaceId,
  getRoomWithAccess,
} from "@nautilo/trust";

type CurrentRoomAccess = Readonly<{
  namespaceId: string;
  humanActorIds: readonly string[];
  isPublicNamespaceBoundary: boolean;
}>;

export interface CanonicalRoomAuthorityQueries {
  getRoomWithAccess(roomId: string): Promise<CurrentRoomAccess | null>;
  findRoomByNamespaceId(namespaceId: string): Promise<Readonly<{
    roomId: string;
    humanActorIds: readonly string[];
  }> | null>;
}

export { PostgresCurrentRecordPublicationBinding } from "@nautilo/reflection-bridge/server";
export type { CurrentRecordPublicationBindingPort } from "@nautilo/reflection-bridge/server";

export interface CanonicalRoomEvidenceBindingPort {
  resolve(bindingRef: string): Promise<Readonly<{
    roomId: string;
    namespaceId: string;
  }> | null>;
  resolveRoom(roomId: string): Promise<Readonly<{
    roomId: string;
    namespaceId: string;
  }> | null>;
}

/** Metadata-only origin binding for a question whose content is already open. */
export interface CanonicalRoomInvocationBindingPort {
  resolve(recordRef: string): Promise<Readonly<{
    roomId: string;
  }> | null>;
}

type CanonicalPublicationBinding = Readonly<{
  namespaceId: string;
  representation: "ordinary" | "protected";
  bindingVersion: number;
}>;

const JOURNAL_BINDING =
  /^journal:namespace:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(ordinary|protected):v([1-9][0-9]*)$/iu;

function parsePublicationBinding(
  bindingRef: string,
): CanonicalPublicationBinding | null {
  const match = JOURNAL_BINDING.exec(bindingRef);
  if (match === null) return null;
  const representation = match[2] as "ordinary" | "protected";
  const bindingVersion = Number(match[3]);
  if (!Number.isSafeInteger(bindingVersion)) return null;
  return {
    namespaceId: match[1]!.toLowerCase(),
    representation,
    bindingVersion,
  };
}

function parseSelectedPublicationBinding(
  bindingRef: string,
  selection: RecordRepositorySelection,
): CanonicalPublicationBinding | null {
  const parsed = parsePublicationBinding(bindingRef);
  return parsed?.representation === selection.selectedRepresentation
    ? parsed
    : null;
}

function canonicalHumans(humanRefs: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(humanRefs)].sort());
}

function audience(access: CurrentRoomAccess) {
  return Object.freeze({
    humanRefs: canonicalHumans(access.humanActorIds),
    includesPublicBoundary: access.isPublicNamespaceBoundary,
  });
}

function executeRows<Row>(result: unknown): readonly Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (typeof result === "object" && result !== null && "rows" in result) {
    const rowsValue = (result as { rows: unknown }).rows;
    if (Array.isArray(rowsValue)) return rowsValue as Row[];
  }
  return [];
}

class CanonicalRoomBindingResolver {
  constructor(private readonly ports: Readonly<{
    selection: RecordRepositorySelection;
    publications: CurrentRecordPublicationBindingPort;
    rooms: CanonicalRoomAuthorityQueries;
  }>) {}

  async resolveBinding(bindingRef: string): Promise<Readonly<{
    bindingRef: string;
    roomId: string;
    namespaceId: string;
    access: CurrentRoomAccess;
  }> | null> {
    const parsed = parseSelectedPublicationBinding(bindingRef, this.ports.selection);
    if (parsed === null) return null;
    const room = await this.ports.rooms.findRoomByNamespaceId(parsed.namespaceId);
    if (room === null) return null;
    const access = await this.ports.rooms.getRoomWithAccess(room.roomId);
    if (access === null || access.namespaceId.toLowerCase() !== parsed.namespaceId) return null;
    return {
      bindingRef,
      roomId: room.roomId,
      namespaceId: parsed.namespaceId,
      access,
    };
  }

  async resolveRecord(recordRef: string) {
    const binding = await this.ports.publications.read(recordRef);
    if (binding === null || binding.currentAccessBindingRefs.length !== 1) return null;
    const origin = parsePublicationBinding(binding.originPublicationBindingRef);
    if (origin === null) return null;
    const access = await this.resolveBinding(binding.currentAccessBindingRefs[0]!);
    return access === null
      ? null
      : {
          ...access,
          originNamespaceId: origin.namespaceId,
          originPublicationBindingRef: binding.originPublicationBindingRef,
        };
  }
}

export function createCanonicalSameRoomBindingPorts(input: Readonly<{
  selection: RecordRepositorySelection;
  productHandle?: RecordProductPostgresHandle;
  publications?: CurrentRecordPublicationBindingPort;
  searchCommitments: RecordSearchCommitmentPort;
  roomQueries?: CanonicalRoomAuthorityQueries;
}>): Readonly<{
  semantic: SameRoomSemanticBindingPort;
  search: RecordSearchBindingPort;
  evidence: CanonicalRoomEvidenceBindingPort;
  invocation: CanonicalRoomInvocationBindingPort;
}> {
  const roomQueries = input.roomQueries ?? {
    getRoomWithAccess,
    findRoomByNamespaceId,
  };
  const publications = input.publications ?? (
    input.productHandle === undefined
      ? (() => { throw new TypeError("Record publication binding port is required"); })()
      : new PostgresCurrentRecordPublicationBinding(
          input.productHandle,
          input.selection,
        )
  );
  const resolver = new CanonicalRoomBindingResolver({
    selection: input.selection,
    publications,
    rooms: roomQueries,
  });
  const semantic: SameRoomSemanticBindingPort = {
    async resolve(record: DurableRecordEnvelope) {
      const resolved = await resolver.resolveRecord(record.recordRef);
      if (resolved === null) return { status: "unavailable" };
      const roomAnchors = record.semantic.anchors.filter(
        (anchor) => anchor.kind === "room" && anchor.role === "origin",
      );
      const matchingOrigins: Array<Readonly<{
        roomId: string;
      }>> = [];
      for (const anchor of roomAnchors) {
        const access = await roomQueries.getRoomWithAccess(anchor.anchorRef);
        if (access?.namespaceId.toLowerCase() === resolved.originNamespaceId) {
          matchingOrigins.push({ roomId: anchor.anchorRef });
        }
      }
      if (matchingOrigins.length !== 1) return { status: "unavailable" };
      const originRoomId = matchingOrigins[0]!.roomId;
      // Cross-Room parents retain immutable evidence origins. Current access
      // may move to a different exact access Room as source authority changes.
      if (record.semantic.terminalAuthorityLeafHandles.length < 1) {
        return { status: "unavailable" };
      }
      return {
        status: "available",
        binding: {
          roomAnchorRef: originRoomId,
          readBindingRef: resolved.bindingRef,
          searchBindingRef: resolved.bindingRef,
          // Organizer discovery cohorts use the immutable origin; current
          // access and output authority remain on their separate coordinates.
          publicationBindingRef: resolved.originPublicationBindingRef,
          invocationAudience: audience(resolved.access),
        },
      };
    },
    async resolveWork(recordRef: string) {
      const resolved = await resolver.resolveRecord(recordRef);
      return resolved === null
        ? null
        : {
            readBindingRef: resolved.bindingRef,
            invocationAudience: audience(resolved.access),
          };
    },
  };
  const search: RecordSearchBindingPort = {
    async resolve(bindingRef: string): Promise<ResolvedRecordSearchBinding | null> {
      const resolved = await resolver.resolveBinding(bindingRef);
      if (resolved === null) return null;
      const invocationAudience = audience(resolved.access);
      return {
        invocationAudience,
        readBindingRef: resolved.bindingRef,
        invocationAudienceCommitment: input.searchCommitments.commit(
          "audience",
          {
            humanRefs: [...invocationAudience.humanRefs],
            includesPublicBoundary: invocationAudience.includesPublicBoundary,
          },
        ),
      };
    },
  };
  const evidence: CanonicalRoomEvidenceBindingPort = {
    async resolve(bindingRef) {
      const resolved = await resolver.resolveBinding(bindingRef);
      return resolved === null
        ? null
        : { roomId: resolved.roomId, namespaceId: resolved.namespaceId };
    },
    async resolveRoom(roomId) {
      const access = await roomQueries.getRoomWithAccess(roomId);
      return access === null ? null : { roomId, namespaceId: access.namespaceId };
    },
  };
  const invocation: CanonicalRoomInvocationBindingPort = {
    async resolve(recordRef) {
      if (publications.readOrigin === undefined) return null;
      const originBindingRef = await publications.readOrigin(recordRef);
      const origin = originBindingRef === null
        ? null
        : parsePublicationBinding(originBindingRef);
      if (origin === null) return null;
      const originRoom = await roomQueries.findRoomByNamespaceId(
        origin.namespaceId,
      );
      return originRoom === null ? null : { roomId: originRoom.roomId };
    },
  };
  return Object.freeze({ semantic, search, evidence, invocation });
}

export interface RecordAccessAudienceTrustPort {
  findOrCreate(humanActorIds: readonly string[]): Promise<Readonly<{
    namespaceId: string;
    roomId: string;
  }>>;
}

export class CanonicalRecordAccessAudience implements RecordAccessAudiencePort {
  constructor(private readonly ports: Readonly<{
    trust?: RecordAccessAudienceTrustPort;
    readAccessRooms(namespaceIds: readonly string[]): Promise<readonly Readonly<{
      namespaceId: string;
      roomId: string;
      humanActorIds: readonly string[];
    }>[]>;
  }>) {}

  async resolveOrCreateExact(humanRefs: readonly string[]): Promise<MaterializedAccessAudience> {
    const exact = canonicalHumans(humanRefs);
    if (exact.length === 0) throw new TypeError("Record access audience requires Humans");
    const trust = this.ports.trust ?? {
      findOrCreate: (ids: readonly string[]) =>
        findOrCreateRecordAccessNamespace([...ids]),
    };
    const created = await trust.findOrCreate(exact);
    const rows = await this.ports.readAccessRooms([created.namespaceId]);
    const row = rows[0];
    if (
      rows.length !== 1
      || row === undefined
      || row.roomId !== created.roomId
      || canonicalHumans(row.humanActorIds).join("\0") !== exact.join("\0")
    ) throw new TypeError("Record access Room materialization mismatch");
    return {
      accessRoomId: created.roomId,
      accessNamespaceId: created.namespaceId,
      humanRefs: exact,
    };
  }

  async readExactSet(accessNamespaceIds: readonly string[]) {
    const ids = [...new Set(accessNamespaceIds)];
    if (ids.length !== accessNamespaceIds.length || ids.length === 0) {
      return { status: "unavailable" as const };
    }
    const rows = await this.ports.readAccessRooms(ids);
    const byNamespace = new Map(rows.map((row) => [row.namespaceId, row]));
    if (byNamespace.size !== ids.length) return { status: "unavailable" as const };
    return {
      status: "available" as const,
      audiences: ids.map((id) => canonicalHumans(byNamespace.get(id)!.humanActorIds)),
    };
  }
}

export function createCanonicalRecordAccessAudience(input: Readonly<{
  db: DirectDatabase;
  trust?: RecordAccessAudienceTrustPort;
}>): CanonicalRecordAccessAudience {
  return new CanonicalRecordAccessAudience({
    ...(input.trust === undefined ? {} : { trust: input.trust }),
    readAccessRooms: async (namespaceIds) => {
      const result = await input.db.select({
        namespaceId: rooms.namespaceId,
        roomId: rooms.id,
        humanActorIds: rooms.humanActorIds,
      })
        .from(rooms)
        .where(and(
          eq(rooms.kind, "access"),
          inArray(rooms.namespaceId, [...namespaceIds]),
        ))
        .orderBy(rooms.namespaceId);
      return executeRows<{
        namespaceId: string;
        roomId: string;
        humanActorIds: string[] | null;
      }>(result).map((row) => ({
        namespaceId: row.namespaceId,
        roomId: row.roomId,
        humanActorIds: row.humanActorIds ?? [],
      }));
    },
  });
}

/** Current Room-Namespace terminal authority, including the virtual public boundary. */
export class CanonicalRoomNamespaceSourceAuthority
implements CanonicalSourceAuthorityPort {
  constructor(private readonly rooms: CanonicalRoomAuthorityQueries = {
    getRoomWithAccess,
    findRoomByNamespaceId,
  }) {}

  async resolve(handle: string) {
    const room = await this.rooms.findRoomByNamespaceId(handle);
    if (room === null) return { status: "unavailable" as const };
    const access = await this.rooms.getRoomWithAccess(room.roomId);
    if (access === null || access.namespaceId !== handle) {
      return { status: "unavailable" as const };
    }
    return {
      status: "available" as const,
      leaf: {
        terminalAuthorityLeafHandle: handle,
        alternatives: [audience(access)],
      },
    };
  }
}
