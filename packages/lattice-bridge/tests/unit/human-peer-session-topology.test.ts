import { expect, test } from "bun:test";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeExecutor,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import { PostgresHumanPeerLiveShadowPlanner } from
  "../../src/server/message/postgres-human-peer-live-shadow-plan.ts";

const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "10000000-0000-4000-8000-000000000002";
const PEER = "10000000-0000-4000-8000-000000000003";
const AGENT = "10000000-0000-4000-8000-000000000004";
const ROOM = "10000000-0000-4000-8000-000000000005";
const NAMESPACE = "10000000-0000-4000-8000-000000000006";
const SESSION = "10000000-0000-4000-8000-000000000007";

function connection(query: (statement: string) => readonly PostgresJsBridgeRow[]):
  PostgresJsBridgeConnection {
  const executor: PostgresJsBridgeExecutor = {
    query: async <Row extends PostgresJsBridgeRow>(statement: string) =>
      query(statement) as readonly Row[],
  };
  return {
    query: executor.query,
    transaction: async (use) => use(executor),
    transactionOnce: async (use) => use(executor),
  };
}

for (const [kind, humans] of [
  ["private", [HUMAN, PEER]],
  ["group", [HUMAN, PEER, "10000000-0000-4000-8000-000000000008", "10000000-0000-4000-8000-000000000009"]],
  ["open", [HUMAN]],
  ["open", [HUMAN, PEER]],
] as const) {
for (const sessionAgent of [null, AGENT]) {
  for (const rosterHasAgent of [false, true]) {
    test(`peer topology uses ${kind}/${humans.length} Humans (Session hint=${sessionAgent}, Agent member=${rosterHasAgent})`, async () => {
      let restrictedReads = 0;
      const product = connection((statement) => {
        if (statement.includes("m295_human_peer_policy")) {
          return [{ mode: "shadow_encryption", revision: 1 }];
        }
        if (statement.includes("m295_human_peer_session_room")) return [{
          graph_thread_id: "peer-thread", namespace_id: NAMESPACE,
          parent_room_id: null, archived_at: null, owner_id: USER,
        }];
        if (statement.includes("m295_human_peer_session_ensure")) return [];
        if (statement.includes('from "sessions"')) return [{
          id: SESSION, room_id: ROOM, agent_id: sessionAgent,
        }];
        if (statement.includes("m295_namespace_key_human_only_product_room")) {
          return [{
            room_id: ROOM, namespace_id: NAMESPACE, kind,
            parent_room_id: null, archived_at: null, namespace_access_revision: 1,
            human_actor_ids: [...humans], effective_human_actor_ids: [...humans], subject_user_id: USER,
          }];
        }
        if (statement.includes("m295_namespace_key_human_only_product_members")) {
          return [
            ...humans.map((actor_id) => ({ actor_id, kind: "user", agent_id: null })),
            ...(rosterHasAgent ? [{ actor_id: AGENT, kind: "agent", agent_id: AGENT }] : []),
          ];
        }
        throw new Error(`Unexpected product query: ${statement}`);
      });
      const restricted = connection((statement) => {
        restrictedReads += 1;
        expect(statement).toContain('"namespace_domain_key_heads"');
        return [];
      });
      const planner = new PostgresHumanPeerLiveShadowPlanner(
        product, restricted, undefined, "test-server",
      );
      const result = await planner.plan({
        authority: { userId: USER, humanActorId: HUMAN },
        roomId: ROOM, clientDeviceId: "peer-device", idempotencyKey: "peer-test",
        now: 1_800_000_000_000,
      });
      expect(result).toEqual(rosterHasAgent ? {
        status: "ineligible", reason: "room_topology_unsupported",
      } : {
        status: "unavailable", authorizationScheme: "human_peer_v1",
        reason: "namespace_unavailable", requiredNamespaceIds: [NAMESPACE],
      });
      expect(restrictedReads).toBe(rosterHasAgent ? 0 : 1);
    });
  }
}

}
