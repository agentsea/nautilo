import { expect, test } from "bun:test";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import {
  LatticeCrypto, authorizationRevision,
  createDomainForegroundAuthorizationPlan, cryptoDeviceId,
  humanId,
} from "@nautilo/lattice-crypto";
import { destroyDomainForegroundAuthorizationPlanV2 } from
  "@nautilo/lattice-crypto/wire";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import type {
  AcceptedTaskRuntimeAuthorizationV3,
  CurrentTaskRuntimeAuthority,
  InitialTaskRuntimeRecipientAuthority,
} from "@nautilo/lattice-bridge/server";
import {
  createProtectedTaskTerminalMessageAuthorityPort,
  type ProtectedTaskTerminalMessageAuthorityDependencies,
} from "../../src/routes/protected-task-terminal-message-authority";
import type { ProtectedTaskTerminalMessageIntent } from
  "../../src/routes/protected-task-terminal-message-product";

const USER = "10000000-0000-4000-8000-000000000101";
const HUMAN = "10000000-0000-4000-8000-000000000102";
const TASK = "10000000-0000-4000-8000-000000000103";
const RUN = "10000000-0000-4000-8000-000000000104";
const AGENT = "10000000-0000-4000-8000-000000000105";
const PRIVATE_NS = "private-task-namespace";
const PRIVATE_ROOM = "10000000-0000-4000-8000-000000000106";
const DESTINATION_NS = "destination-namespace";
const DESTINATION_ROOM = "10000000-0000-4000-8000-000000000107";
const DOMAIN = "destination-domain";
const DEVICE = "device";
const POLICY = 9;
const bytes = (value: number, length = 32) =>
  new Uint8Array(length).fill(value);

const intent: ProtectedTaskTerminalMessageIntent = Object.freeze({
  taskId: TASK,
  taskRunId: RUN,
  requesterUserId: USER,
  agentId: AGENT,
  contentNamespaceId: PRIVATE_NS,
  representation: "protected",
  bindingId: `task-run-output:${RUN}`,
  resultObjectId: `task-run-result:v1:${"a".repeat(64)}`,
  resultRevision: 2,
  acceptedPolicyRevision: 7,
  terminalAt: new Date("2026-10-12T10:00:00Z"),
  attachedAt: new Date("2026-10-12T10:00:01Z"),
  destinationRoomId: DESTINATION_ROOM,
  destinationNamespaceId: DESTINATION_NS,
  messageOperationId: `task-run-delivery-message:${RUN}`,
});
const subject = Object.freeze({
  userId: USER,
  humanActorId: HUMAN,
  deviceId: DEVICE,
});
const namespaceRequirements = Object.freeze([Object.freeze({
  ordinal: 0,
  namespaceId: DESTINATION_NS,
  domainId: DOMAIN,
  operations: Object.freeze(["encrypt"] as const),
  expectedAccessRevision: 4,
  expectedPolicyRevision: POLICY,
})]);
const domainRequirements = Object.freeze([Object.freeze({
  ordinal: 0,
  domainId: DOMAIN,
  expectedEpoch: 3,
  expectedAuthorizationRevision: 5,
})]);

function request(
  patch: Partial<TaskRuntimeBackgroundAuthorizationRequestV1> = {},
): TaskRuntimeBackgroundAuthorizationRequestV1 {
  const crypto = new LatticeCrypto();
  const sourceRoomId = patch.sourceRoomId ?? DESTINATION_ROOM;
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: `task-run-delivery-message-authorization:${RUN}`,
    policyRevision: POLICY,
    sessionId: `task-run:${RUN}`,
    roomId: sourceRoomId,
    subjectHumanId: humanId(HUMAN),
    committerDeviceId: cryptoDeviceId(DEVICE),
    committerDeviceSigningGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(4),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 1,
    recipientKeyId: "recipient:task-terminal-message",
    operations: ["encrypt"],
    issuedAt: 2_000_000_000_000,
    deadlineAt: 2_000_000_100_000,
    maximumSecretBytes: 1024,
    domains: [{
      domainId: DOMAIN,
      sourceNamespaceId: DESTINATION_NS,
      participantDigest: bytes(8),
      participantCount: 2,
      keyClass: "ai",
      domainKeyGeneration: 3,
      authorizationRevision: authorizationRevision(5),
      headDigest: bytes(9),
      activeNamespaceBindingSetDigest: bytes(10),
      activeNamespaceBindingCount: 1,
    }],
  });
  const result = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: `task-run-delivery-message-authorization:${RUN}`,
    workId: RUN,
    workKind: "task.deliver_message",
    workPurpose: "task.deliver_message",
    recipientGeneration: 1,
    episodeId: `task-run:${RUN}`,
    sourceRoomId,
    recipientKeyId: "recipient:task-terminal-message",
    recipientPublicKey: bytes(6, 65),
    authorizationPlan: plan,
    issuedAt: 2_000_000_000_000,
    deadlineAt: 2_000_000_100_000,
    ...patch,
  });
  destroyDomainForegroundAuthorizationPlanV2(plan);
  return result;
}

function accepted(
  patch: Partial<AcceptedTaskRuntimeAuthorizationV3> = {},
): AcceptedTaskRuntimeAuthorizationV3 {
  return Object.freeze({
    descriptorBytes: new Uint8Array([1]),
    descriptorDigest: "descriptor-digest",
    requestId: `task-run-delivery-message-authorization:${RUN}`,
    workId: RUN,
    workKind: "task.deliver_message",
    workPurpose: "task.deliver_message",
    recipientGeneration: 1,
    recipientKeyId: "recipient:task-terminal-message",
    recipientPublicKeyBase64url: "key",
    expectedPolicyRevision: POLICY,
    namespaceRequirements,
    domainRequirements,
    authorizationId: "authorization",
    authorizationBytes: new Uint8Array([2]),
    authorizationDigest: "authorization-digest",
    authorizationExpiresAt: 2_000_000_100_000,
    issuingHumanId: HUMAN,
    issuingDeviceId: DEVICE,
    issuingDeviceAuthorizationRevision: 4,
    issuerSigningPublicKeyHash: bytes(3),
    ...patch,
  });
}

function fixture(options: Readonly<{
  destinationOtherMemberCount?: number;
  duplicateDestinationTarget?: boolean;
  removeDestinationTarget?: boolean;
  sourceAgentId?: string;
}> = {}) {
  const calls: string[] = [];
  const connection: PostgresJsBridgeConnection = {
    query: async <Row extends PostgresJsBridgeRow>(
      sql: string,
      parameters?: readonly unknown[],
    ) => {
      if (sql.includes('from "rooms"')) {
        return [{
          id: PRIVATE_ROOM,
          namespace_id: PRIVATE_NS,
          type: "private",
          kind: "private",
          parent_room_id: null,
          archived_at: null,
          human_actor_ids: [HUMAN],
        }] as unknown as readonly Row[];
      }
      if (sql.includes('from "room_members"')) {
        const destination = parameters?.includes(DESTINATION_ROOM) === true;
        if (destination) {
          const otherMembers = Array.from(
            { length: options.destinationOtherMemberCount ?? 1 },
            (_, index) => ({
              actor_id: `other-agent-actor-${index}`,
              agent_id: `other-agent-${index}`,
            }),
          );
          const targetMembers = options.removeDestinationTarget
            ? []
            : Array.from(
                { length: options.duplicateDestinationTarget ? 2 : 1 },
                (_, index) => ({
                  actor_id: `target-agent-actor-${index}`,
                  agent_id: AGENT,
                }),
              );
          const matches = parameters?.includes(AGENT) === true
            ? targetMembers
            : [...otherMembers, ...targetMembers];
          const limit = parameters?.includes(2) === true
            ? 2
            : parameters?.includes(64) === true ? 64 : matches.length;
          return matches.slice(0, limit) as unknown as readonly Row[];
        }
        return [
          { id: HUMAN, kind: "user", owner_id: USER, agent_id: null },
          { id: "agent-actor", kind: "agent", owner_id: USER,
            agent_id: options.sourceAgentId ?? AGENT },
        ] as unknown as readonly Row[];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    transaction: use => use(connection),
    transactionOnce: use => use(connection),
  };
  const dependencies: Partial<ProtectedTaskTerminalMessageAuthorityDependencies> = {
    db: {} as ProtectedTaskTerminalMessageAuthorityDependencies["db"],
    crypto: new LatticeCrypto(),
    restricted: () => connection,
    resolveRequesterHuman: async () => ({ id: HUMAN }),
    resolveRequesterPrivateRoom: async () => ({
      roomId: PRIVATE_ROOM,
      namespaceId: PRIVATE_NS,
    }),
    createProductContext: async () => ({
      canonicalRunner: {},
      handle: {},
    }) as Awaited<ReturnType<ProtectedTaskTerminalMessageAuthorityDependencies["createProductContext"]>>,
    validateCurrentIntent: async () => {
      calls.push("intent");
      return true;
    },
    inspectDeliveryAuthority: async input => {
      calls.push("inspect");
      expect(input.sourceRoomId).toBe(PRIVATE_ROOM);
      expect(input.destinationRoomId).toBe(DESTINATION_ROOM);
      expect(input.destinationNamespaceId).toBe(DESTINATION_NS);
      expect(input.expectedPolicyRevision).toBe(POLICY);
      return {
        sourceRoomId: PRIVATE_ROOM,
        sourceNamespaceId: PRIVATE_NS,
        facts: [{
          namespaceId: DESTINATION_NS,
          domainId: DOMAIN,
          expectedAccessRevision: 4,
          expectedPolicyRevision: POLICY,
          expectedDomainEpoch: 3,
          expectedAuthorizationRevision: 5,
        }],
      };
    },
    withRecipientAuthority: async input => {
      calls.push("recipient");
      expect(input.namespaceRequirements).toEqual(namespaceRequirements);
      expect(await input.validateCurrentTaskRun(
        connection, {} as never, {} as never)).toBe(true);
      const result = await input.use({
        sourceRoomId: DESTINATION_ROOM,
        sourceNamespaceId: PRIVATE_NS,
        namespaceRequirements,
        domains: [],
        policyRevision: POLICY,
        device: subject,
      } as unknown as InitialTaskRuntimeRecipientAuthority,
      connection, connection, {} as never);
      await input.validateBeforeCommit?.();
      return result;
    },
    withBoundAuthority: async input => {
      calls.push("bound");
      if (!await input.validateCurrentProduct?.(connection, {} as never)) {
        return null;
      }
      return input.use({
        plan: { roomId: DESTINATION_ROOM },
      } as CurrentTaskRuntimeAuthority, connection, connection);
    },
    withAcceptedAuthority: async input => {
      calls.push("accepted");
      if (!await input.validateCurrentProduct(connection, {} as never)) {
        return null;
      }
      const result = await input.use({
        plan: { roomId: DESTINATION_ROOM },
      } as CurrentTaskRuntimeAuthority, connection, connection, {} as never);
      await input.validateBeforeCommit();
      return result;
    },
  };
  return {
    calls,
    connection,
    port: createProtectedTaskTerminalMessageAuthorityPort(dependencies),
  };
}

test("discovery binds one destination encrypt grant while private source stays internal", async () => {
  const value = fixture();
  const events: string[] = [];
  const result = await value.port.withDiscovery({
    intent,
    publicationPolicyRevision: POLICY,
    subject,
    use: (current, product) => {
      events.push("use");
      expect(current.sourceRoomId).toBe(DESTINATION_ROOM);
      expect(current.sourceNamespaceId).toBe(PRIVATE_NS);
      expect(current.restricted).toBe(value.connection);
      expect(product).toBe(value.connection);
      return "bound";
    },
    validateBeforeCommit: () => { events.push("commit"); },
  });
  expect(result).toBe("bound");
  expect(events).toEqual(["use", "commit"]);
  expect(value.calls).toEqual([
    "inspect", "recipient", "intent",
  ]);
});

test("bound and accepted authority require the actual destination Room", async () => {
  const value = fixture();
  expect(await value.port.withBound({
    intent,
    publicationPolicyRevision: POLICY,
    subject,
    request: request(),
    admission: { headDigest: bytes(4) } as never,
    namespaceRequirements,
    domainRequirements,
    use: current => current.plan.roomId,
  })).toBe(DESTINATION_ROOM);

  const events: string[] = [];
  const record = accepted();
  expect(await value.port.withAccepted({
    intent,
    publicationPolicyRevision: POLICY,
    subject,
    accepted: record,
    validateBeforeCommit: () => { events.push("lease"); },
    use: current => {
      events.push("use");
      return current.plan.roomId;
    },
  })).toBe(DESTINATION_ROOM);
  expect(events).toEqual(["lease", "use", "lease"]);
  expect(record.authorizationBytes[0]).toBe(2);
});

test("accepts a Human-owned private source whose Agent differs from the Task Agent", async () => {
  const value = fixture({ sourceAgentId: "other-private-room-agent" });
  expect(await value.port.withDiscovery({
    intent,
    publicationPolicyRevision: POLICY,
    subject,
    use: () => "bound",
  })).toBe("bound");
});

test("bound and accepted reject a removed target Agent even when another Agent remains", async () => {
  for (const phase of ["bound", "accepted"] as const) {
    const value = fixture({ removeDestinationTarget: true });
    let used = false;
    const result = phase === "bound"
      ? await value.port.withBound({
        intent, publicationPolicyRevision: POLICY, subject, request: request(),
        admission: { headDigest: bytes(4) } as never,
        namespaceRequirements, domainRequirements,
        use: () => { used = true; },
      })
      : await value.port.withAccepted({
        intent, publicationPolicyRevision: POLICY, subject,
        accepted: accepted(), validateBeforeCommit: () => {},
        use: () => { used = true; },
      });
    expect(result).toBeNull();
    expect(used).toBe(false);
  }
});

test("bound and accepted find the exact target Agent beyond unrelated Room members", async () => {
  for (const phase of ["bound", "accepted"] as const) {
    const value = fixture({ destinationOtherMemberCount: 65 });
    const result = phase === "bound"
      ? await value.port.withBound({
        intent, publicationPolicyRevision: POLICY, subject, request: request(),
        admission: { headDigest: bytes(4) } as never,
        namespaceRequirements, domainRequirements,
        use: () => "used",
      })
      : await value.port.withAccepted({
        intent, publicationPolicyRevision: POLICY, subject,
        accepted: accepted(), validateBeforeCommit: () => {},
        use: () => "used",
      });
    expect(result).toBe("used");
  }
});

test("bound and accepted reject duplicate exact target Agent memberships", async () => {
  for (const phase of ["bound", "accepted"] as const) {
    const value = fixture({ duplicateDestinationTarget: true });
    let used = false;
    const result = phase === "bound"
      ? await value.port.withBound({
        intent, publicationPolicyRevision: POLICY, subject, request: request(),
        admission: { headDigest: bytes(4) } as never,
        namespaceRequirements, domainRequirements,
        use: () => { used = true; },
      })
      : await value.port.withAccepted({
        intent, publicationPolicyRevision: POLICY, subject,
        accepted: accepted(), validateBeforeCommit: () => {},
        use: () => { used = true; },
      });
    expect(result).toBeNull();
    expect(used).toBe(false);
  }
});

test("rejects policy rollback, execution grants, expanded access and source substitution", async () => {
  for (const operation of [
    () => fixture().port.withAccepted({
      intent,
      publicationPolicyRevision: 6,
      subject,
      accepted: accepted({ expectedPolicyRevision: 6 }),
      validateBeforeCommit: () => {},
      use: () => { throw new Error("must not execute"); },
    }),
    () => fixture().port.withAccepted({
      intent,
      publicationPolicyRevision: POLICY,
      subject,
      accepted: accepted({ workKind: "task.execute" }),
      validateBeforeCommit: () => {},
      use: () => { throw new Error("must not execute"); },
    }),
    () => fixture().port.withAccepted({
      intent,
      publicationPolicyRevision: POLICY,
      subject,
      accepted: accepted({ namespaceRequirements: [{
        ...namespaceRequirements[0]!,
        operations: ["decrypt", "encrypt"],
      }] }),
      validateBeforeCommit: () => {},
      use: () => { throw new Error("must not execute"); },
    }),
    () => fixture().port.withBound({
      intent,
      publicationPolicyRevision: POLICY,
      subject,
      request: request({ sourceRoomId: PRIVATE_ROOM }),
      admission: { headDigest: bytes(4) } as never,
      namespaceRequirements,
      domainRequirements,
      use: () => { throw new Error("must not execute"); },
    }),
  ]) expect(await operation()).toBeNull();
});
