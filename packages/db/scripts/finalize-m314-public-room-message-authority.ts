import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { protectedRoomMessageAuthoritySql } from "../src/schema/protected-room-message-authority";

import { cryptoParticipantSetAuthoritySql } from "../src/schema/crypto-participant-set-authority";

export const M314_PUBLIC_ROOM_MESSAGE_AUTHORITY_MARKER = "-- M314_PUBLIC_ROOM_MESSAGE_AUTHORITY";
export function finalizeM314PublicRoomMessageAuthorityMigration(migration: string): string {
  if (migration.includes(M314_PUBLIC_ROOM_MESSAGE_AUTHORITY_MARKER)) return migration;
  if (migration.trim() !== "-- Custom SQL migration file, put your code below! --") {
    throw new Error("M314 finalizer requires the fresh Drizzle-generated custom migration");
  }
  return `${M314_PUBLIC_ROOM_MESSAGE_AUTHORITY_MARKER}\n${protectedRoomMessageAuthoritySql()}`;
}

export const M314_PARTICIPANT_SET_MARKER = "-- M314_PARTICIPANT_SET_AUTHORITY";
export function finalizeM314ParticipantSetMigration(migration: string): string {
  if (migration.includes(M314_PARTICIPANT_SET_MARKER)) return migration;
  if (migration.trim() !== "-- Custom SQL migration file, put your code below! --") {
    throw new Error("M314 finalizer requires the fresh Drizzle-generated custom migration");
  }
  return `${M314_PARTICIPANT_SET_MARKER}\n${cryptoParticipantSetAuthoritySql()}`;
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const last = journal.entries.at(-1);
  const finalize = last?.tag.endsWith("_m314_participant_set_authority")
    ? finalizeM314ParticipantSetMigration
    : last?.tag.endsWith("_m314_public_room_message_authority")
      ? finalizeM314PublicRoomMessageAuthorityMigration
      : null;
  if (last !== undefined && finalize !== null) {
    const path = resolve(directory, `${last.tag}.sql`);
    const original = readFileSync(path, "utf8");
    const finalized = finalize(original);
    if (finalized !== original) writeFileSync(path, finalized);
  }
}
