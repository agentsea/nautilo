import { createHash } from "node:crypto";

import type { ConnectionRef } from "@nautilo/types";

/**
 * Stable id for `{namespace_id, agent_id, service, field}` without collisions across tuples.
 */
function connectionIdentityKey(input: {
  readonly namespace_id: string | null;
  readonly agent_id: string | null;
  readonly service: string;
  readonly field: string;
}): string {
  const canonical = JSON.stringify({
    agent_id: input.agent_id,
    field: input.field,
    namespace_id: input.namespace_id,
    service: input.service,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Short alias when only `service`/`field` are known (use scoped key for full rows). */
export function connectionIdentityKeyFromRef(
  ref: ConnectionRef,
  namespace_id: string | null,
  agent_id: string | null,
): string {
  return connectionIdentityKey({
    namespace_id,
    agent_id,
    field: ref.field,
    service: ref.service,
  });
}
