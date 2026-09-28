import { describe, expect, test } from "bun:test";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeExecutor,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import {
  LatticeCrypto,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  domainForegroundNamespaceBindingSetDigest,
  humanId,
  type DomainForegroundAuthorityEntry,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  matchesCurrentTaskRuntimeAuthority,
  withCurrentTaskRuntimeAuthority,
  type TaskRuntimeDomainAuthorityRequirement,
  type TaskRuntimeNamespaceAuthorityRequirement,
} from "../../src/server/task/current-task-runtime-authority.ts";

const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "10000000-0000-4000-8000-000000000002";
const DEVICE = "10000000-0000-4000-8000-000000000003";
const ROOM = "10000000-0000-4000-8000-000000000004";
const NAMESPACE = "10000000-0000-4000-8000-000000000005";
const DOMAIN = "10000000-0000-4000-8000-000000000006";
const AGENT = "10000000-0000-4000-8000-000000000007";
const NOW = 1_800_000_000_000;

async function fixture() {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const domain: DomainForegroundAuthorityEntry = {
    domainId: DOMAIN,
    sourceNamespaceId: NAMESPACE,
    participantDigest: new Uint8Array(32).fill(1),
    participantCount: 1,
    keyClass: "ai",
    domainKeyGeneration: 2,
    authorizationRevision: authorizationRevision(3),
    headDigest: new Uint8Array(32).fill(4),
    activeNamespaceBindingSetDigest:
      domainForegroundNamespaceBindingSetDigest(crypto, [{
        namespaceId: NAMESPACE,
        bindingDigest: new Uint8Array(32).fill(5),
      }]),
    activeNamespaceBindingCount: 1,
  };
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: "task-request",
    policyRevision: 7,
    sessionId: "task-episode",
    roomId: ROOM,
    subjectHumanId: humanId(HUMAN),
    committerDeviceId: cryptoDeviceId(DEVICE),
    committerDeviceSigningGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(6),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 1,
    recipientKeyId: "task-recipient",
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
    maximumSecretBytes: 4_096,
    domains: [domain],
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: plan.authorizationId,
    workId: "task-run",
    workKind: "task.dispatch",
    workPurpose: "task.dispatch",
    recipientGeneration: plan.recipientRuntimeGeneration,
    episodeId: plan.sessionId,
    sourceRoomId: plan.roomId,
    recipientKeyId: plan.recipientKeyId,
    recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan,
    issuedAt: plan.issuedAt,
    deadlineAt: plan.deadlineAt,
  });
  const device = {
    userId: USER,
    humanActorId: HUMAN,
    deviceId: DEVICE,
    deviceGeneration: 2,
    signingPublicKey: signing.publicKey,
    serverInstanceId: "d8c858cc-f359-48ad-8de6-341f61fb92a1",
    lineageGeneration: 3,
    epoch: 4,
    securityRevision: 6,
    headDigest: new Uint8Array(32).fill(8),
  };
  const admission = { ...device, expiresAt: NOW + 60_000 };
  const namespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[] = [{
    ordinal: 0,
    namespaceId: NAMESPACE,
    domainId: DOMAIN,
    operations: ["decrypt", "encrypt"],
    expectedAccessRevision: 9,
    expectedPolicyRevision: plan.policyRevision,
  }];
  const domainRequirements: readonly TaskRuntimeDomainAuthorityRequirement[] = [{
    ordinal: 0,
    domainId: DOMAIN,
    expectedEpoch: domain.domainKeyGeneration,
    expectedAuthorizationRevision: domain.authorizationRevision,
  }];
  recipient.privateKey.fill(0);
  signing.privateKey.fill(0);
  return {
    crypto,
    plan,
    request,
    domain,
    device,
    admission,
    namespaceRequirements,
    domainRequirements,
  };
}

describe("current Task Runtime authority", () => {
  test("matches only the exact live device, policy and Domain authority", async () => {
    const value = await fixture();
    const input = {
      request: value.request,
      plan: value.plan,
      subject: { userId: USER, humanActorId: HUMAN, deviceId: DEVICE },
      admission: value.admission,
      device: value.device,
      namespaces: value.namespaceRequirements,
      domainRequirements: value.domainRequirements,
      domains: [value.domain],
      policyRevision: value.plan.policyRevision,
      now: NOW + 1,
    };
    expect(matchesCurrentTaskRuntimeAuthority(input)).toBe(true);
    expect(matchesCurrentTaskRuntimeAuthority({
      ...input,
      now: value.request.deadlineAt,
    })).toBe(false);
    expect(matchesCurrentTaskRuntimeAuthority({
      ...input,
      device: { ...value.device, securityRevision: 7 },
    })).toBe(false);
    expect(matchesCurrentTaskRuntimeAuthority({
      ...input,
      domains: [{ ...value.domain, domainKeyGeneration: 3 }],
    })).toBe(false);
  });

  test("admits an open source through shared product authority before restricted locks", async () => {
    const value = await fixture();
    const events: string[] = [];
    const member = { actor_id: HUMAN, kind: "user" };
    const agentMember = { actor_id: AGENT, kind: "agent" };
    const target = {
      room_id: ROOM,
      namespace_id: NAMESPACE,
      parent_room_id: null,
      namespace_access_revision: 9,
      human_actor_ids: [HUMAN],
      effective_human_actor_ids: [HUMAN],
    };
    let selected = false;
    const tx = {
      execute: async () => {
        events.push("policy lock");
        return [];
      },
      select: () => {
        const query: Record<string, unknown> = {};
        for (const method of ["from", "where"]) query[method] = () => query;
        query["then"] = (
          resolve: (value: unknown) => unknown,
          reject: (reason: unknown) => unknown,
        ) => {
          events.push("policy");
          selected = true;
          return Promise.resolve([{
            mode: "shadow_encryption",
            shadowBehavior: "fallback",
            revision: value.plan.policyRevision,
          }]).then(resolve, reject);
        };
        return query;
      },
    };
    const executor: PostgresJsBridgeExecutor = {
      query: async <Row extends PostgresJsBridgeRow>(
        statement: string,
        parameters: readonly unknown[] = [],
      ) => {
        expect(selected).toBe(true);
        events.push("product");
        let rows: readonly PostgresJsBridgeRow[];
        if (statement.includes("m291_namespace_key_readable_set_target_candidates")) {
          rows = [{ room_id: ROOM, namespace_id: NAMESPACE }];
        } else if (statement.includes(
          'order by "rooms"."parent_room_id" nulls first',
        )) {
          rows = [{ room_id: ROOM }];
        } else if (statement.includes("m291_namespace_key_readable_set_source_members")) {
          rows = [member, agentMember];
        } else if (statement.includes("m291_namespace_key_readable_set_source")) {
          rows = [{
            source_room_id: ROOM,
            kind: "open",
            parent_room_id: null,
            archived_at: null,
            human_actor_ids: [HUMAN],
            effective_human_actor_ids: [HUMAN],
          }];
        } else if (statement.includes("m291_namespace_key_readable_set_actor")) {
          rows = [{ subject_user_id: USER }];
        } else if (statement.includes("m291_namespace_key_readable_set_targets")) {
          rows = [target];
        } else if (statement.includes("m291_namespace_key_readable_set_target_members")) {
          rows = [
            { ...member, room_id: ROOM },
            { ...agentMember, room_id: ROOM },
          ];
        } else if (statement.startsWith(
          'select "rooms"."namespace_id" from "rooms" inner join "rooms" "namespace_source_room"',
        )) {
          rows = [{ namespace_id: NAMESPACE }];
        } else {
          const requested = parameters.find(Array.isArray);
          if (requested !== undefined) rows = [{ room_id: ROOM }];
          else throw new Error(`Unexpected product authority query: ${statement}`);
        }
        return rows as readonly Row[];
      },
    };
    const restrictedReached = new Error("restricted authority reached");
    const restricted: PostgresJsBridgeConnection = {
      query: async () => [],
      transaction: async () => {
        throw new Error("Task authority must use a non-retrying transaction");
      },
      transactionOnce: async () => {
        events.push("restricted");
        throw restrictedReached;
      },
    };
    const runner = {
      transaction: async (use: (
        transaction: unknown,
        product: PostgresJsBridgeExecutor,
      ) => Promise<unknown>) => use(tx, executor),
    };
    const error = await withCurrentTaskRuntimeAuthority({
      runner,
      restricted,
      crypto: value.crypto,
      serverScope: "https://nautilo.example",
      subject: { userId: USER, humanActorId: HUMAN, deviceId: DEVICE },
      admission: value.admission,
      request: value.request,
      namespaceRequirements: value.namespaceRequirements,
      domainRequirements: value.domainRequirements,
      now: () => NOW + 1,
      use: async () => "accepted",
    } as unknown as Parameters<typeof withCurrentTaskRuntimeAuthority>[0]).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBe(restrictedReached);
    expect(events.slice(0, 2)).toEqual(["policy lock", "policy"]);
    expect(events.at(-1)).toBe("restricted");
    expect(events.filter((event) => event === "product").length).toBeGreaterThan(0);
  });
});
