import {expect, test} from "bun:test";
import type {PostgresJsBridgeExecutor, PostgresJsBridgeRow} from "@nautilo/db";
import {readableNamespacePolicyAllows} from "../../src/server/delivery/namespace-readable-policy.ts";

const SOURCE = "10000000-0000-4000-8000-000000000001";
const HUMAN = "10000000-0000-4000-8000-000000000002";
const ACCESS_NAMESPACE = "10000000-0000-4000-8000-000000000003";

test("Record access targets use the audience predicate without requiring the target to be the source Room", async () => {
  const transaction: PostgresJsBridgeExecutor = {
    async query<Row extends PostgresJsBridgeRow>(statement: string, parameters: readonly unknown[] = []) {
      const kindPredicate = /"rooms"\."kind" in \(([^)]+)\)/u.exec(statement);
      expect(kindPredicate).not.toBeNull();
      const kinds = [...kindPredicate![1]!.matchAll(/\$(\d+)/gu)]
        .map(match => parameters[Number(match[1]) - 1]);
      expect(kinds).not.toContain("access");
      const accessPredicate = /\("rooms"\."kind" = \$(\d+) and "public_boundary_room"\."id" is null\)/u.exec(statement);
      expect(accessPredicate).not.toBeNull();
      expect(parameters[Number(accessPredicate![1]) - 1]).toBe("access");
      // An access target remains subject to the same audience containment,
      // top-level, archive, and public-boundary constraints as other targets.
      expect(statement).toContain('public.moderation_effective_humans("rooms"."human_actor_ids", "rooms"."id") @>');
      expect(statement).toContain('"rooms"."parent_room_id" is null');
      expect(statement).toContain('"rooms"."archived_at" is null');
      expect(parameters).toContain("open");
      expect(parameters.filter(value => value === SOURCE)).toHaveLength(1);
      return [{namespace_id: ACCESS_NAMESPACE}] as unknown as readonly Row[];
    },
  };
  expect(await readableNamespacePolicyAllows(transaction, {
    sourceRoomId: SOURCE, sourceHumanIds: [HUMAN], namespaceIds: [ACCESS_NAMESPACE],
  })).toBe(true);
});
