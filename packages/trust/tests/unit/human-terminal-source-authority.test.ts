import { expect, test } from "bun:test";
import { compileOfflineDirectQuery, createOfflineDirectDb } from "@nautilo/db";
import { readHumanTerminalSourceAuthority } from "../../src/human-terminal-source-authority";

function compilingDatabase(results: readonly unknown[][]) {
  const offline = createOfflineDirectDb();
  const compiled: string[] = [];
  let index = 0;
  const wrap = (query: object, rows: unknown[]): object => new Proxy(query, {
    get(target, property, receiver) {
      if (property === "then") return (resolve: (value: unknown[]) => unknown) => {
        compiled.push(compileOfflineDirectQuery(target as Parameters<typeof compileOfflineDirectQuery>[0]).sql);
        return Promise.resolve(rows).then(resolve);
      };
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      const method = value as (this: object, ...args: unknown[]) => object;
      return (...args: unknown[]) => wrap(method.apply(target, args), rows);
    },
  });
  const database = {
    select(fields?: unknown) {
      const rows = [...(results[index++] ?? [])];
      return wrap(offline.select(fields as never), rows);
    },
  };
  return { database, compiled, selections: () => index };
}

test("transaction source authority builds every canonical fact query on the supplied handle", async () => {
  const f = compilingDatabase([
    [{ slug: "invoke_agents" }, { slug: "use_workstation" }],
    [{ id: "human" }],
    [{ userId: "human" }],
    [{ id: "human-actor" }],
    [{ id: "room", graphThreadId: "room-thread" }],
    [{ actorId: "agent-actor" }],
  ]);
  expect(await readHumanTerminalSourceAuthority(f.database as never, {
    humanUserId: "human", agentId: "agent", roomId: "room", graphThreadId: "room-thread",
  })).toEqual({ roomId: "room", graphThreadId: "room-thread", agentActorId: "agent-actor" });
  expect(f.selections()).toBe(6);
  expect(f.compiled[0]).toContain("group_members");
  expect(f.compiled[0]).toContain("role_capabilities");
  expect(f.compiled[1]).toContain("moderation_access_allowed");
  expect(f.compiled[2]).toContain("actors");
  expect(f.compiled[4]).toContain("room_members");
  expect(f.compiled[5]).toContain("room_members");
});

test("empty Human is denied by canonical invocation policy before starting a source-fact query", async () => {
  const f = compilingDatabase([]);
  await Promise.resolve(expect(readHumanTerminalSourceAuthority(f.database as never, {
    humanUserId: "", agentId: "agent", roomId: "room", graphThreadId: "thread",
  })).rejects.toMatchObject({ code: "invoke_agents_required" }));
  expect(f.selections()).toBe(0);
});

test("ambiguous Agent ownership keeps canonical target-unavailable semantics", async () => {
  const f = compilingDatabase([
    [{ slug: "invoke_agents" }, { slug: "use_workstation" }],
    [{ id: "human" }],
    [{ userId: "human" }, { userId: "other" }],
  ]);
  await Promise.resolve(expect(readHumanTerminalSourceAuthority(f.database as never, {
    humanUserId: "human", agentId: "agent", roomId: "room", graphThreadId: "thread",
  })).rejects.toMatchObject({ code: "agent_target_unavailable" }));
});

test("moderation, cross-owner, workstation, and membership facts cannot be skipped", async () => {
  const input = { humanUserId: "human", agentId: "agent", roomId: "room", graphThreadId: "thread" };
  const moderated = compilingDatabase([
    [{ slug: "invoke_agents" }, { slug: "use_workstation" }], [],
  ]);
  await Promise.resolve(expect(readHumanTerminalSourceAuthority(moderated.database as never, input))
    .rejects.toMatchObject({ code: "invocation_access_withdrawn" }));

  const foreign = compilingDatabase([
    [{ slug: "invoke_agents" }, { slug: "use_workstation" }], [{ id: "human" }], [{ userId: "other" }],
  ]);
  await Promise.resolve(expect(readHumanTerminalSourceAuthority(foreign.database as never, input))
    .rejects.toMatchObject({ code: "invoke_other_agents_required" }));

  const noWorkstation = compilingDatabase([
    [{ slug: "invoke_agents" }], [{ id: "human" }], [{ userId: "human" }],
  ]);
  expect(await readHumanTerminalSourceAuthority(noWorkstation.database as never, input)).toBeNull();

  const noMembership = compilingDatabase([
    [{ slug: "invoke_agents" }, { slug: "use_workstation" }], [{ id: "human" }], [{ userId: "human" }], [],
  ]);
  expect(await readHumanTerminalSourceAuthority(noMembership.database as never, input)).toBeNull();
});
