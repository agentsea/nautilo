import { expect, test } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { DirectDatabase } from "@nautilo/db";
import { canResearchPublicWebsite } from "../../src/connected-web-accounts/read-tool-runtime-composition";
const human = { actorId: "human-actor", kind: "user", ownerId: "human", agentId: null };
const genie = { actorId: "genie-actor", kind: "agent", ownerId: "another-owner", agentId: "genie" };
function db(rows: unknown[]): DirectDatabase {
  const query = { innerJoin: () => query, where: async () => rows };
  return { select: () => ({ from: () => query }) } as unknown as DirectDatabase;
}
const actor = { userId: "human", agentId: "genie", roomId: "shared-room", callingRoomId: null,
  memoryAccessEnvelope: { ownerId: "human", actorId: "human-actor", agentId: "genie", roomId: "shared-room", memoryMode: "namespace", readableNamespaces: [], mutableNamespaces: [], writableNamespaces: [], toolPolicy: { browse_web: "allow" } } as MemoryAccessEnvelope };
test("public browsing permits shared-room membership and a Genie owned by another Human", async () => {
  expect(await canResearchPublicWebsite(db([human, genie, { kind: "user", ownerId: "colleague" }]), actor)).toBe(true);
});

test("public action tasks use their own allow policy and cannot borrow read authority", async () => {
  expect(await canResearchPublicWebsite(db([human, genie]), actor, "run_website_task")).toBe(false);
  const taskActor = { ...actor, memoryAccessEnvelope: { ...actor.memoryAccessEnvelope, toolPolicy: { run_website_task: "allow" as const } } };
  expect(await canResearchPublicWebsite(db([human, genie]), taskActor, "run_website_task")).toBe(true);
  expect(await canResearchPublicWebsite(db([genie]), taskActor, "run_website_task")).toBe(false);
  expect(await canResearchPublicWebsite(db([human, genie]), { ...taskActor, memoryAccessEnvelope: { ...taskActor.memoryAccessEnvelope, toolPolicy: { run_website_task: "read_only" } } }, "run_website_task")).toBe(false);
});
test("room-anchored task calling authority does not acquire private profile restrictions", async () => {
  expect(await canResearchPublicWebsite(db([human, genie]), { ...actor, callingRoomId: "origin-room", laneKey: "task:example" })).toBe(true);
});
test("revoked member, missing Genie, policy denial, or substituted owner cannot browse", async () => {
  expect(await canResearchPublicWebsite(db([genie]), actor)).toBe(false);
  expect(await canResearchPublicWebsite(db([human]), actor)).toBe(false);
  expect(await canResearchPublicWebsite(db([human, genie]), { ...actor, userId: "someone-else" })).toBe(false);
  expect(await canResearchPublicWebsite(db([human, genie]), { ...actor, memoryAccessEnvelope: { ...actor.memoryAccessEnvelope, toolPolicy: { browse_web: "forbidden" } } })).toBe(false);
});
