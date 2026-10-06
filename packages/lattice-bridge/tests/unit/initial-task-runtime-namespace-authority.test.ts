import { describe, expect, spyOn, test } from "bun:test";
import type { PostgresJsBridgeConnection, PostgresJsBridgeExecutor, PostgresJsBridgeRow, PostgresJsBridgeScalar } from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { inspectInitialTaskRuntimeNamespaceAuthority, withInitialTaskRuntimeRecipientAuthority } from "../../src/server/task/initial-task-runtime-namespace-authority.ts";

import { PostgresDeviceAdmissionRepository, type CurrentDeviceAdmissionAuthority } from "../../src/server/device/postgres-device-admission-repository.ts";

const DEVICE = "initial-task-device";
const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "10000000-0000-4000-8000-000000000002";
const AGENT_ACTOR = "10000000-0000-4000-8000-000000000003";
const AGENT = "10000000-0000-4000-8000-000000000004";
const TASK = "10000000-0000-4000-8000-000000000005";
const ROOMS = ["20000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002"] as const;
const NAMESPACES = ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002"] as const;
const DOMAINS = ["40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000002"] as const;

type Input = Parameters<typeof inspectInitialTaskRuntimeNamespaceAuthority>[0];
type Rows = readonly PostgresJsBridgeRow[];
type Adjust = (stage: string, rows: Rows) => Rows;

function fixture(adjust: Adjust = (_stage, rows) => rows) {
  const events: string[] = [];
  let productLocked = false;
  let restrictedLocked = false;
  const productMembers = [{ actor_id: HUMAN, kind: "user" }, { actor_id: AGENT_ACTOR, kind: "agent" }];
  const targetRows = NAMESPACES.map((namespace, index) => ({
    namespace_id: namespace, room_id: ROOMS[index]!, parent_room_id: null,
    namespace_access_revision: 9 + index, human_actor_ids: [HUMAN],
    effective_human_actor_ids: [HUMAN],
  }));
  const executor: PostgresJsBridgeExecutor = {
    query: async <Row extends PostgresJsBridgeRow>(statement: string) => {
      expect(productLocked).toBe(true);
      expect(restrictedLocked).toBe(false);
      let stage: string;
      let rows: Rows;
      if (statement.includes('from "tasks"')) {
        stage = "task";
        rows = [{ id: TASK, requestor_id: USER, agent_id: AGENT,
          content_namespace_id: NAMESPACES[0], content_representation: "protected" }];
      } else if (statement.includes("m291_namespace_key_readable_set_target_candidates")) {
        stage = "candidates";
        rows = targetRows;
      } else if (statement.includes('order by "rooms"."parent_room_id" nulls first')) {
        stage = "room-locks";
        rows = ROOMS.map((id) => ({ id }));
      } else if (statement.includes("m291_namespace_key_readable_set_source_members")) {
        stage = "source-members";
        rows = productMembers;
      } else if (statement.includes("m291_namespace_key_readable_set_source")) {
        stage = "readable-source";
        rows = [{ source_room_id: ROOMS[0], kind: "private", parent_room_id: null,
          archived_at: null, human_actor_ids: [HUMAN], effective_human_actor_ids: [HUMAN] }];
      } else if (statement.includes("m291_namespace_key_readable_set_actor")) {
        stage = "subject";
        rows = [{ subject_user_id: USER }];
      } else if (statement.includes("m291_namespace_key_readable_set_targets")) {
        stage = "targets";
        rows = targetRows;
      } else if (statement.includes("m291_namespace_key_readable_set_target_members")) {
        stage = "target-members";
        rows = ROOMS.flatMap((roomId) => productMembers.map((member) => ({ ...member, room_id: roomId })));
      } else if (statement.includes('inner join "rooms" "namespace_source_room"')) {
        stage = "readable-policy";
        rows = NAMESPACES.map((namespace_id) => ({ namespace_id }));
      } else if (statement.includes('from "room_members"')) {
        stage = "exact-members";
        rows = [{ id: HUMAN, kind: "user", owner_id: USER, agent_id: null },
          { id: AGENT_ACTOR, kind: "agent", owner_id: USER, agent_id: AGENT }];
      } else if (statement.includes('from "rooms"')) {
        stage = "exact-source";
        rows = [{ id: ROOMS[0], namespace_id: NAMESPACES[0], type: "private", kind: "private",
          parent_room_id: null, archived_at: null, human_actor_ids: [HUMAN] }];
      } else throw new Error(`Unexpected product query: ${statement}`);
      events.push(stage);
      return adjust(stage, rows) as readonly Row[];
    },
  };
  const tx = {
    execute: async () => { events.push("policy-lock"); return []; },
    select: () => {
      const query: Record<string, unknown> = {};
      for (const name of ["from", "where"]) query[name] = () => query;
      query["then"] = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        events.push("policy");
        return Promise.resolve(adjust("policy", [{ mode: "encrypted_only", shadowBehavior: "strict", revision: 7 }])).then(resolve, reject);
      };
      return query;
    },
  };
  const runner = {
    transaction: async (use: (transaction: unknown, product: PostgresJsBridgeExecutor) => Promise<unknown>) => {
      productLocked = true;
      try { return await use(tx, executor); }
      finally { productLocked = false; events.push("product-released"); }
    },
  };
  const restricted: PostgresJsBridgeConnection = {
    query: async <Row extends PostgresJsBridgeRow>(statement: string, parameters: readonly unknown[] = []) => {
      expect(productLocked).toBe(true);
      expect(restrictedLocked).toBe(true);
      let rows: Rows;
      let stage: string;
      if (statement.includes("SELECT current_user::text")) {
        stage = "role";
        rows = [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }];
      } else if (statement.includes('from "human_crypto_devices"')) {
        stage = "device-lock";
        rows = [{ device_id: DEVICE, device_generation: 2, revision: 4 }];
      } else if (statement.includes('from "domain_key_recipient_envelopes"')) {
        stage = "recipient";
        rows = DOMAINS.map((domain_id) => ({ domain_id }));
      } else if (statement.includes('from "namespace_domain_key_heads"') && statement.includes('order by')) {
        stage = "namespace-locks";
        rows = NAMESPACES.map((namespace_id, index) => ({ namespace_id, domain_id: DOMAINS[index]!,
          domain_key_generation: 2, domain_authorization_revision: 3,
          domain_head_digest: new Uint8Array(32).fill(4), binding_digest: new Uint8Array(32).fill(6) }));
      } else if (statement.includes('from "domain_key_heads"') && statement.includes('order by')) {
        stage = "domain-locks";
        rows = DOMAINS.map((domain_id) => ({ domain_id, domain_key_generation: 2,
          authorization_revision: 3, head_digest: new Uint8Array(32).fill(4),
          participant_count: 1, participant_digest: new Uint8Array(32).fill(5) }));
      } else if (statement.includes('from "namespace_domain_key_heads"')) {
        stage = "namespace";
        const index = (NAMESPACES as readonly string[]).indexOf(String(parameters[0]));
        expect(index).toBeGreaterThanOrEqual(0);
        expect(parameters[1]).toBe("ai");
        rows = [{ namespace_id: NAMESPACES[index]!, namespace_access_revision: 9 + index,
          namespace_current_generation: 1, domain_id: DOMAINS[index]!, domain_key_generation: 2,
          domain_authorization_revision: 3, domain_head_digest: new Uint8Array(32).fill(4),
          bundle_revision: 1, retained_generation_count: 2,
          retained_authority_set_digest: new Uint8Array(32).fill(5), binding_digest: new Uint8Array(32).fill(6) }];
      } else if (statement.includes('from "domain_key_heads"')) {
        stage = "domain";
        expect(parameters[1]).toBe("ai");
        rows = [{ domain_id: String(parameters[0]), domain_key_generation: 2,
          authorization_revision: 3, head_digest: new Uint8Array(32).fill(4) }];
      } else throw new Error(`Unexpected restricted query: ${statement}`);
      events.push(stage);
      return adjust(stage, rows) as readonly Row[];
    },
    transaction: async () => { throw new Error("Must not retry restricted transaction"); },
    transactionOnce: async (use) => {
      restrictedLocked = true;
      events.push("restricted");
      try { return await use(restricted); }
      finally { restrictedLocked = false; events.push("restricted-released"); }
    },
  };
  const input = { runner, restricted, crypto: new LatticeCrypto(), serverScope: "https://nautilo.example",
    taskId: TASK, requesterUserId: USER, requesterHumanId: HUMAN, agentId: AGENT,
    contentNamespaceId: NAMESPACES[0], sourceRoomId: ROOMS[0], namespaceIds: NAMESPACES,
    expectedPolicyRevision: 7 } as unknown as Input;
  return { input, events };
}

function substitute(stage: string, field: string, value: PostgresJsBridgeScalar): Adjust {
  return (current, rows) => current === stage ? rows.map((row) => ({ ...row, [field]: value })) : rows;
}

describe("initial Task Runtime Namespace authority", () => {
  test("returns only detached scalar facts for multiple AI Domains after releasing locks", async () => {
    const { input, events } = fixture();
    const result = await inspectInitialTaskRuntimeNamespaceAuthority(input);
    expect(result).toEqual({ sourceRoomId: ROOMS[0], sourceNamespaceId: NAMESPACES[0],
      facts: NAMESPACES.map((namespaceId, index) => ({ namespaceId, domainId: DOMAINS[index]!,
        expectedAccessRevision: 9 + index, expectedPolicyRevision: 7,
        expectedDomainEpoch: 2, expectedAuthorizationRevision: 3 })) });
    expect(events.slice(0, 2)).toEqual(["policy-lock", "policy"]);
    expect(events.indexOf("restricted")).toBeGreaterThan(events.indexOf("exact-members"));
    expect(events.lastIndexOf("namespace")).toBeLessThan(events.indexOf("domain"));
    expect(events.slice(-2)).toEqual(["restricted-released", "product-released"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.facts)).toBe(true);
  });

  test("checks a shared Domain once and binds both Namespace revisions", async () => {
    const { input, events } = fixture(substitute("namespace", "domain_id", DOMAINS[0]));
    const result = await inspectInitialTaskRuntimeNamespaceAuthority(input);
    expect(result?.facts.map((fact) => fact.domainId)).toEqual([DOMAINS[0], DOMAINS[0]]);
    expect(events.filter((event) => event === "domain")).toHaveLength(1);
  });

  test("rejects an additional Agent in the purported private pair", async () => {
    const { input, events } = fixture((stage, rows) => stage === "exact-members"
      ? [...rows, { id: TASK, kind: "agent", agent_id: TASK, owner_id: USER }] : rows);
    expect(await inspectInitialTaskRuntimeNamespaceAuthority(input)).toBeNull();
    expect(events).not.toContain("restricted");
  });

  test("accepts a dual Task under Shadow consumption authority", async () => {
    const { input } = fixture((stage, rows) => stage === "policy"
      ? [{ mode: "shadow_encryption", shadowBehavior: "fallback", revision: 7 }]
      : stage === "task" ? rows.map((row) => ({ ...row, content_representation: "dual" })) : rows);
    expect(await inspectInitialTaskRuntimeNamespaceAuthority(input)).not.toBeNull();
  });

  for (const [stage, field, value] of [
    ["policy", "mode", "plaintext_only"], ["policy", "revision", 8],
    ["task", "id", AGENT], ["task", "requestor_id", HUMAN], ["task", "agent_id", HUMAN],
    ["task", "content_namespace_id", NAMESPACES[1]], ["task", "content_representation", "ordinary"],
    ["subject", "subject_user_id", HUMAN],
    ["exact-source", "id", ROOMS[1]], ["exact-source", "namespace_id", NAMESPACES[1]],
    ["exact-source", "type", "shared"], ["exact-source", "kind", "group"],
    ["exact-source", "parent_room_id", ROOMS[1]], ["exact-source", "archived_at", new Date()],
    ["exact-source", "human_actor_ids", [HUMAN, AGENT]],
    ["exact-members", "agent_id", TASK], ["exact-members", "owner_id", AGENT],
    ["exact-members", "id", TASK],
    ["targets", "effective_human_actor_ids", []],
    ["namespace", "namespace_access_revision", 88], ["namespace", "namespace_id", TASK],
    ["domain", "domain_key_generation", 4], ["domain", "authorization_revision", 4],
    ["domain", "head_digest", new Uint8Array(32).fill(8)], ["domain", "domain_id", TASK],
  ] as const) {
    test(`rejects substituted ${stage}.${field}`, async () => {
      const { input } = fixture(substitute(stage, field, value));
      expect(await inspectInitialTaskRuntimeNamespaceAuthority(input)).toBeNull();
    });
  }

  for (const stage of ["readable-policy", "exact-members", "namespace", "domain"]) {
    test(`rejects missing ${stage} evidence`, async () => {
      const { input } = fixture((current, rows) => current === stage ? [] : rows);
      expect(await inspectInitialTaskRuntimeNamespaceAuthority(input)).toBeNull();
    });
  }

  test("rejects noncanonical Namespace sets before taking locks", async () => {
    for (const namespaceIds of [[], [NAMESPACES[1]], [...NAMESPACES].reverse(), [NAMESPACES[0], NAMESPACES[0]]]) {
      const { input, events } = fixture();
      const error = await inspectInitialTaskRuntimeNamespaceAuthority({ ...input, namespaceIds }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TypeError);
      expect(events).toEqual([]);
    }
  });
});

function device(): CurrentDeviceAdmissionAuthority {
  return { userId: USER, humanActorId: HUMAN, deviceId: DEVICE, deviceGeneration: 2,
    signingPublicKey: new Uint8Array(32).fill(6), serverInstanceId: "initial-server", lineageGeneration: 1,
    epoch: 2, securityRevision: 4, headDigest: new Uint8Array(32).fill(7) };
}
function recipientInput(input: Input) {
  return { ...input, deviceId: DEVICE,
    validateCurrentTaskRun: async () => true,
    namespaceRequirements: NAMESPACES.map((namespaceId, ordinal) => ({ ordinal, namespaceId,
      domainId: DOMAINS[ordinal]!, operations: ["decrypt", "encrypt"] as const,
      expectedAccessRevision: 9 + ordinal, expectedPolicyRevision: 7 })),
    domainRequirements: DOMAINS.map((domainId, ordinal) => ({ ordinal, domainId, expectedEpoch: 2, expectedAuthorizationRevision: 3 })),
  };
}

describe("initial Task Runtime recipient authority", () => {
  test("keeps exact awaiting TaskRun validation inside product locks before recipient construction", async () => {
    const { input, events } = fixture();
    const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
      .mockImplementation(async () => device());
    let used = false;
    try {
      const result = await withInitialTaskRuntimeRecipientAuthority({
        ...recipientInput(input),
        validateCurrentTaskRun: async () => {
          events.push("run-lock");
          expect(events).toContain("task");
          expect(events).not.toContain("restricted");
          return false;
        },
        use: () => { used = true; return true; },
      });
      expect(result).toBeNull();
      expect(used).toBe(false);
      expect(events.indexOf("task")).toBeLessThan(events.indexOf("run-lock"));
      expect(events).not.toContain("restricted");
    } finally { admission.mockRestore(); }
  });

  test("lends exact public authority inside product/device/Namespace/Domain locks", async () => {
    const { input, events } = fixture();
    const devices: CurrentDeviceAdmissionAuthority[] = [];
    const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
      .mockImplementation(async (subject) => {
        expect(subject).toEqual({ userId: USER, humanActorId: HUMAN, deviceId: DEVICE });
        expect(events).toContain("restricted"); expect(events).not.toContain("restricted-released");
        events.push("admission"); const current = device(); devices.push(current); return current;
      });
    let borrowed: Uint8Array[] = [];
    try {
      const result = await withInitialTaskRuntimeRecipientAuthority({ ...recipientInput(input), use: async (current) => {
        events.push("callback");
        expect(current.sourceRoomId).toBe(ROOMS[0]); expect(current.policyRevision).toBe(7);
        expect(current.namespaceRequirements).toEqual(recipientInput(input).namespaceRequirements);
        expect(current.domains.map((entry) => entry.domainId)).toEqual([...DOMAINS]);
        expect(current.domains.every((entry) => entry.activeNamespaceBindingCount === 1)).toBe(true);
        expect(Object.keys(current).sort()).toEqual(["device", "domains", "namespaceRequirements", "policyRevision", "sourceNamespaceId", "sourceRoomId"]);
        borrowed = current.domains.flatMap((entry) => [entry.headDigest, entry.participantDigest, entry.activeNamespaceBindingSetDigest]);
        expect(events).not.toContain("restricted-released");
        await Promise.resolve(); return current.device.deviceId;
      } });
      expect(result).toBe(DEVICE);
      expect(events.indexOf("device-lock")).toBeLessThan(events.indexOf("namespace-locks"));
      expect(events.indexOf("namespace-locks")).toBeLessThan(events.indexOf("domain-locks"));
      expect(events.lastIndexOf("admission")).toBeLessThan(events.indexOf("callback"));
      expect(events.slice(-2)).toEqual(["restricted-released", "product-released"]);
      for (const bytes of [...borrowed, ...devices.flatMap((entry) => [entry.signingPublicKey, entry.headDigest])]) {
        expect(bytes.every((byte) => byte === 0)).toBe(true);
      }
    } finally { admission.mockRestore(); }
  });

  test("accepts an independent locked device projection revision", async () => {
    const { input } = fixture(substitute("device-lock", "revision", 9));
    const admission = spyOn(
      PostgresDeviceAdmissionRepository.prototype,
      "currentAuthorityForDelegation",
    ).mockImplementation(async () => device());
    try {
      expect(await withInitialTaskRuntimeRecipientAuthority({
        ...recipientInput(input),
        use: (current) => current.device.securityRevision,
      })).toBe(4);
    } finally {
      admission.mockRestore();
    }
  });

  for (const [stage, field, value] of [
    ["task", "agent_id", HUMAN], ["exact-source", "namespace_id", NAMESPACES[1]],
    ["targets", "namespace_access_revision", 40], ["policy", "revision", 8], ["policy", "mode", "plaintext_only"],
    ["namespace", "namespace_access_revision", 80], ["namespace", "domain_id", DOMAINS[1]],
    ["namespace-locks", "domain_authorization_revision", 90], ["domain-locks", "authorization_revision", 90],
    ["domain-locks", "head_digest", new Uint8Array(32).fill(9)],
    ["device-lock", "device_generation", 8],
  ] as const) {
    test(`does not invoke callback for stale ${stage}.${field}`, async () => {
      const { input } = fixture(substitute(stage, field, value)); let used = false;
      const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
        .mockImplementation(async () => device());
      try {
        expect(await withInitialTaskRuntimeRecipientAuthority({ ...recipientInput(input), use: () => { used = true; } })).toBeNull();
        expect(used).toBe(false);
      } finally { admission.mockRestore(); }
    });
  }

  test("rejects revoked device, missing native recipient and device drift before callback", async () => {
    for (const denied of ["admission", "device-lock", "recipient", "changed"]) {
      const { input } = fixture((stage, rows) => stage === denied ? [] : rows); let used = false; let reads = 0;
      const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
        .mockImplementation(async () => denied === "admission" ? null
          : { ...device(), epoch: denied === "changed" && ++reads === 2 ? 3 : 2 });
      try {
        expect(await withInitialTaskRuntimeRecipientAuthority({ ...recipientInput(input), use: () => { used = true; } })).toBeNull();
        expect(used).toBe(false);
      } finally { admission.mockRestore(); }
    }
  });

  test("supports Shadow and wipes borrowed public bytes when its callback fails", async () => {
    const { input, events } = fixture((stage, rows) => stage === "policy"
      ? [{ mode: "shadow_encryption", shadowBehavior: "fallback", revision: 7 }]
      : stage === "task" ? rows.map((row) => ({ ...row, content_representation: "dual" })) : rows);
    const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
      .mockImplementation(async () => device());
    let borrowed: Uint8Array[] = [];
    try {
      const failure = new Error("request builder failed");
      expect(await withInitialTaskRuntimeRecipientAuthority({ ...recipientInput(input), use: (current) => {
        borrowed = [current.device.signingPublicKey, current.device.headDigest,
          ...current.domains.flatMap((entry) => [entry.headDigest, entry.participantDigest, entry.activeNamespaceBindingSetDigest])];
        throw failure;
      } }).catch((error: unknown) => error)).toBe(failure);
      expect(borrowed.length).toBeGreaterThan(0);
      expect(borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
      expect(events.slice(-2)).toEqual(["restricted-released", "product-released"]);
    } finally { admission.mockRestore(); }
  });

  test("rejects forged requirement inventory and aborts without invoking callback", async () => {
    const { input, events } = fixture(); const exact = recipientInput(input);
    expect(await withInitialTaskRuntimeRecipientAuthority({ ...exact,
      namespaceRequirements: [...exact.namespaceRequirements].reverse(), use: () => true }).catch((error: unknown) => error)).toBeInstanceOf(Error);
    const controller = new AbortController(); controller.abort();
    expect(await withInitialTaskRuntimeRecipientAuthority({ ...exact, signal: controller.signal, use: () => true }).catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect(events).toEqual([]);
  });
});
