import { describe, expect, test } from "bun:test";
import type { PostgresJsBridgeConnection, PostgresJsBridgeRow } from "@nautilo/db";
import { PostgresNamespaceProductAuthority, inspectNamespaceProductAuthoritySnapshot,
  type NamespaceProductAuthoritySnapshot } from "../../src/server/delivery/postgres-namespace-product-authority.ts";

const HUMAN = "11000000-0000-4000-8000-000000000001";
const USER = "11000000-0000-4000-8000-000000000002";
const OTHER = "11000000-0000-4000-8000-000000000003";
const id = (prefix: string, index: number) => `${prefix}-0000-4000-8000-${index.toString().padStart(12, "0")}`;

function fixture(count = 2) {
  const coordinates = Array.from({length: count}, (_, index) => ({
    roomId: id("22000000", index), namespaceId: id("33000000", index),
  }));
  const rows = coordinates.map(entry => ({room_id: entry.roomId,
    namespace_id: entry.namespaceId, kind: "access", parent_room_id: null,
    archived_at: null, namespace_access_revision: 3, human_actor_ids: [HUMAN, OTHER], effective_human_actor_ids: [HUMAN, OTHER]}));
  const members = coordinates.flatMap(entry => [HUMAN, OTHER].map(actor_id => ({
    room_id: entry.roomId, actor_id, kind: "user",
  })));
  const queries: string[] = [];
  const connection: PostgresJsBridgeConnection = {
    async query<Row extends PostgresJsBridgeRow>(statement: string) {
      queries.push(statement);
      if (statement.includes('from "room_members"')) return members as unknown as readonly Row[];
      if (statement.includes('from "rooms"')) return rows as unknown as readonly Row[];
      if (statement.includes('from "actors"')) return [{owner_id: USER}] as unknown as readonly Row[];
      throw new Error(`Unexpected query ${statement}`);
    },
    transaction: use => use(connection), transactionOnce: use => use(connection),
  };
  return {coordinates, rows, members, queries,
    authority: new PostgresNamespaceProductAuthority(connection)};
}

describe("complete background Human Namespace authority", () => {
  test("one Human covers every own Namespace without an Agent; handles expire", async () => {
    const f = fixture();
    let retained: NamespaceProductAuthoritySnapshot | undefined;
    const result = await f.authority.withCurrentHumanNamespaceSet({
      subjectUserId: USER, subjectHumanId: HUMAN, coordinates: f.coordinates,
      use: async entries => {
        expect(entries).toHaveLength(2);
        retained = entries[0]!.authority;
        expect(entries.map(entry => {
          const snapshot = inspectNamespaceProductAuthoritySnapshot(entry.authority);
          try { return {namespaceId: String(snapshot.namespaceId), roomId: snapshot.roomId}; }
          finally { snapshot.audienceFingerprint.fill(0); }
        })).toEqual(f.coordinates.map(({namespaceId, roomId}) => ({namespaceId, roomId})));
        return "authorized";
      },
    });
    expect(result).toBe("authorized");
    expect(f.queries).toHaveLength(3);
    expect(() => inspectNamespaceProductAuthoritySnapshot(retained!)).toThrow();
  });

  test("partial Human eligibility and stale stored roster never invoke custody", async () => {
    for (const staleRoster of [false, true]) {
      const f = fixture();
      f.members.splice(2, 1);
      if (!staleRoster) f.rows[1]!.human_actor_ids = [OTHER];
      let invoked = false;
      expect(await f.authority.withCurrentHumanNamespaceSet({
        subjectUserId: USER, subjectHumanId: HUMAN, coordinates: f.coordinates,
        use: async () => { invoked = true; },
      })).toBeNull();
      expect(invoked).toBe(false);
    }
  });

  test("rejects substituted Room, archived boundary and subthread coordinates", async () => {
    for (const mutation of ["room", "archive", "parent"]) {
      const f = fixture();
      const row = f.rows[1]! as Record<string, unknown>;
      if (mutation === "room") row["room_id"] = id("44000000", 1);
      if (mutation === "archive") row["archived_at"] = new Date();
      if (mutation === "parent") row["parent_room_id"] = f.coordinates[0]!.roomId;
      expect(await f.authority.withCurrentHumanNamespaceSet({
        subjectUserId: USER, subjectHumanId: HUMAN, coordinates: f.coordinates,
        use: async () => { throw new Error("Must not enter custody"); },
      })).toBeNull();
    }
  });

  test.each([1, 256, 257, 16_384])("complete %i Namespace set uses three batched queries", async count => {
    const f = fixture(count);
    expect(await f.authority.withCurrentHumanNamespaceSet({
      subjectUserId: USER, subjectHumanId: HUMAN, coordinates: f.coordinates,
      use: async entries => entries.length,
    })).toBe(count);
    expect(f.queries).toHaveLength(3);
  });

  test.each([0, 16_385])("rejects %i Namespace set before querying", async count => {
    const f = fixture(count);
    expect(await f.authority.withCurrentHumanNamespaceSet({
      subjectUserId: USER, subjectHumanId: HUMAN, coordinates: f.coordinates,
      use: async () => undefined,
    }).then(() => false, error => error instanceof TypeError)).toBe(true);
    expect(f.queries).toHaveLength(0);
  });
});
