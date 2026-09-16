import { resolve } from "node:path";

import {
  CONVERSATION_ENCRYPTION_SURFACES,
  validateConversationEncryptionInventory,
} from "../../src/node/conversation-encryption-inventory";
import { describe, expect, it } from "bun:test";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

describe("Wave 9 conversation encryption inventory", () => {
  it("locks every Phase-0 plaintext conversation chokepoint", () => {
    expect(CONVERSATION_ENCRYPTION_SURFACES).toHaveLength(48);
    expect(
      CONVERSATION_ENCRYPTION_SURFACES.map((entry) => entry.id),
    ).toEqual([
      "write.session_store",
      "write.runtime_persist",
      "write.human_peer",
      "write.foreground",
      "write.fork",
      "write.processor",
      "write.subagent",
      "write.protected_agent_crypto",
      "write.protected_agent_coordinator",
      "write.membership_system",
      "write.silence_system",
      "mutation.edit",
      "mutation.delete",
      "read.session",
      "read.session_latest",
      "read.room_before",
      "read.room_members",
      "read.foreground_history",
      "read.history_all",
      "read.history_recent",
      "read.history_parent",
      "read.history_subthread",
      "read.subthread_detail",
      "read.http_history",
      "read.http_around",
      "read.protected_agent_content",
      "repository.protected_active",
      "search.session",
      "search.room",
      "search.room_index",
      "search.conductor",
      "search.http",
      "projection.notification_classification",
      "projection.notification_state",
      "projection.reply_count",
      "projection.root_affinity",
      "projection.routing_packet",
      "realtime.types",
      "realtime.publisher",
      "realtime.protected_job_runner",
      "client.workbench_hydration",
      "client.workbench_reconciliation",
      "client.disconnect_cache",
      "background.stenographer",
      "background.review",
      "autonomous.task_report",
      "client.mobile",
      "legacy.membership_dedupe",
    ]);
  });

  it("keeps active and later-wave consumers explicitly separated", () => {
    expect(
      CONVERSATION_ENCRYPTION_SURFACES.filter(
        (entry) => entry.ownership === "wave9_active",
      ),
    ).toHaveLength(43);
    expect(
      CONVERSATION_ENCRYPTION_SURFACES.filter(
        (entry) => entry.ownership === "wave10_background",
      ).map((entry) => entry.id),
    ).toEqual(["background.stenographer", "background.review"]);
    expect(
      CONVERSATION_ENCRYPTION_SURFACES.filter(
        (entry) => entry.ownership === "wave12_autonomous",
      ).map((entry) => entry.id),
    ).toEqual(["autonomous.task_report"]);
  });

  it("keeps every registered chokepoint anchored to current source", () => {
    expect(validateConversationEncryptionInventory(repositoryRoot)).toEqual([]);
  });

  it("fails closed on source drift", () => {
    expect(validateConversationEncryptionInventory(repositoryRoot, [{
      id: "write.session_store",
      sourcePath: "packages/agent/src/store/session-store.ts",
      anchor: "missing M237 conversation anchor",
      ownership: "wave9_active",
      requiredDuties: ["canonical_write"],
    }])).toEqual([
      "missing conversation source anchor: packages/agent/src/store/session-store.ts#missing M237 conversation anchor",
    ]);
  });
});
