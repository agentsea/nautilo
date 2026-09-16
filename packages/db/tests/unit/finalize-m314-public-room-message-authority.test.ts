import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  finalizeM314PublicRoomMessageAuthorityMigration,
  M314_PUBLIC_ROOM_MESSAGE_AUTHORITY_MARKER,
  finalizeM314ParticipantSetMigration,
} from "../../scripts/finalize-m314-public-room-message-authority";

describe("M314 forward public Message authority migration", () => {
  test("participant-set forward migration preserves canonical checks without the V1 product ceiling", () => {
    const generated = finalizeM314ParticipantSetMigration("-- Custom SQL migration file, put your code below! --");
    expect(finalizeM314ParticipantSetMigration(generated)).toBe(generated);
    expect(() => finalizeM314ParticipantSetMigration("CREATE TABLE unrelated(id int);")).toThrow("fresh Drizzle-generated custom migration");
    expect(readFileSync(new URL("../../src/migrations/0272_m314_participant_set_authority.sql", import.meta.url), "utf8")).toBe(generated);
    expect(generated).toContain('cardinality("participants") < 1');
    expect(generated).not.toContain('cardinality("participants") >');
    expect(generated).toContain('"previous_bytes" >= "participant_bytes"');
    expect(generated).toContain('octet_length("participant") NOT BETWEEN 1 AND 128');
    expect(generated).toContain('SET search_path = pg_catalog');
    expect(generated).not.toContain('GRANT');
    expect(generated).not.toContain('DROP');
  });

  test("finalizes only the generator's empty custom artifact and is idempotent", () => {
    const generated = finalizeM314PublicRoomMessageAuthorityMigration(
      "-- Custom SQL migration file, put your code below! --\n",
    );
    expect(generated.startsWith(M314_PUBLIC_ROOM_MESSAGE_AUTHORITY_MARKER)).toBe(true);
    expect(finalizeM314PublicRoomMessageAuthorityMigration(generated)).toBe(generated);
    expect(() => finalizeM314PublicRoomMessageAuthorityMigration("CREATE TABLE unrelated(id int);")).toThrow(
      "fresh Drizzle-generated custom migration",
    );
    expect(generated).not.toContain("CREATE TABLE");
    expect(generated).not.toContain("DROP TRIGGER");
    expect(generated).toContain("SECURITY INVOKER");
    expect(generated).toContain("SET search_path = pg_catalog");
  });

  test("checked-in forward SQL is the current schema function contract", () => {
    const generated = finalizeM314PublicRoomMessageAuthorityMigration(
      "-- Custom SQL migration file, put your code below! --",
    );
    expect(readFileSync(new URL("../../src/migrations/0271_m314_public_room_message_authority.sql", import.meta.url), "utf8")).toBe(generated);
    expect(generated).toContain("source_room.kind IN ('private', 'group', 'open')");
    expect(generated).toContain("authority_room.kind IN ('private', 'group', 'open')");
    expect(generated).toContain("authority_room.namespace_id = source_room.namespace_id");
    expect(generated).toContain("invocation.authorization_device_id = NEW.authorization_device_id");
    expect(generated).toContain("invocation.input_set_digest = NEW.input_set_digest");
  });
});
