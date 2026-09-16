import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  accountDeletionOwnedMediaDeleteSql,
  accountDeletionSharedRoomLocksSql,
} from "../../src/lib/account-deletion-sql";

const dialect = new PgDialect();
const targetUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("account deletion UUID array SQL", () => {
  test("binds one owned Room as an ARRAY element instead of a scalar uuid[] cast", () => {
    const roomId = "11111111-1111-4111-8111-111111111111";
    const sharedRooms = dialect.sqlToQuery(
      accountDeletionSharedRoomLocksSql([roomId], targetUserId),
    );
    const ownedMedia = dialect.sqlToQuery(
      accountDeletionOwnedMediaDeleteSql([roomId], targetUserId),
    );

    expect(sharedRooms.sql).toContain("rm.room_id = ANY(ARRAY[$1]::uuid[])");
    expect(sharedRooms.sql).toContain("FOR UPDATE OF rm, a");
    expect(sharedRooms.sql).not.toContain("rm.room_id = ANY($1::uuid[])");
    expect(sharedRooms.params).toEqual([roomId, targetUserId]);
    expect(ownedMedia.sql).toContain("room_id = ANY(ARRAY[$2]::uuid[])");
    expect(ownedMedia.params).toEqual([targetUserId, roomId]);
  });

  test("binds every owned Room independently for populated accounts", () => {
    const roomIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    const sharedRooms = dialect.sqlToQuery(
      accountDeletionSharedRoomLocksSql(roomIds, targetUserId),
    );
    const ownedMedia = dialect.sqlToQuery(
      accountDeletionOwnedMediaDeleteSql(roomIds, targetUserId),
    );

    expect(sharedRooms.sql).toContain("rm.room_id = ANY(ARRAY[$1, $2, $3]::uuid[])");
    expect(sharedRooms.params).toEqual([...roomIds, targetUserId]);
    expect(ownedMedia.sql).toContain("room_id = ANY(ARRAY[$2, $3, $4]::uuid[])");
    expect(ownedMedia.params).toEqual([targetUserId, ...roomIds]);
  });
});
