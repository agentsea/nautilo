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
  mintDomainForegroundAuthorization,
  type DomainForegroundAuthorityEntry,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  destroyDomainForegroundAuthorizationV2,
  serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import {
  matchesCurrentTaskRuntimeAuthority,
  withCurrentAcceptedTaskRuntimeAuthority,
  withCurrentTaskRuntimeAuthority,
  type AcceptedTaskRuntimeAuthorizationV3,
  type CurrentTaskRuntimeAuthority,
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

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function frame(value: Uint8Array): Uint8Array {
  return concat([u32(value.length), value]);
}

function text(value: string): Uint8Array {
  return frame(new TextEncoder().encode(value));
}

function concat(values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    values.reduce((length, value) => length + value.length, 0),
  );
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function deviceRoster(input: Readonly<{
  serverInstanceId: string;
  lineageGeneration: number;
  installationLineageDigest: Uint8Array;
  deviceGeneration: number;
}>): Uint8Array {
  const credential = concat([
    text("nautilo/lattice-crypto/human-device-credential/v1"),
    u32(1),
    text(input.serverInstanceId),
    text(HUMAN),
    u64(input.lineageGeneration),
    text(DEVICE),
    frame(input.installationLineageDigest),
    u64(input.deviceGeneration),
  ]);
  return concat([
    text("nautilo/lattice-crypto/human-device-roster/v1"),
    u32(1),
    text(input.serverInstanceId),
    text(HUMAN),
    u64(input.lineageGeneration),
    u32(1),
    u32(0),
    frame(credential),
  ]);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

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
  const domainKey = new Uint8Array(32).fill(10);
  const authorization = await mintDomainForegroundAuthorization(crypto, {
    plan,
    domains: [{ ...domain, domainKey }],
    committerDeviceSigningPrivateKey: signing.privateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(
    authorization,
  );
  destroyDomainForegroundAuthorizationV2(authorization);
  domainKey.fill(0);
  const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
    request,
  );
  const accepted: AcceptedTaskRuntimeAuthorizationV3 = {
    descriptorBytes,
    descriptorDigest: hex(crypto.hash(descriptorBytes)),
    requestId: request.requestId,
    workId: request.workId,
    workKind: request.workKind,
    workPurpose: request.workPurpose,
    recipientGeneration: request.recipientGeneration,
    recipientKeyId: request.recipientKeyId,
    recipientPublicKeyBase64url:
      Buffer.from(request.recipientPublicKey).toString("base64url"),
    expectedPolicyRevision: plan.policyRevision,
    namespaceRequirements,
    domainRequirements,
    authorizationId: plan.authorizationId,
    authorizationBytes,
    authorizationDigest: hex(crypto.hash(authorizationBytes)),
    authorizationExpiresAt: request.deadlineAt,
    issuingHumanId: HUMAN,
    issuingDeviceId: DEVICE,
    issuingDeviceAuthorizationRevision: device.securityRevision,
    issuerSigningPublicKeyHash: crypto.hash(signing.publicKey),
  };
  recipient.privateKey.fill(0);
  signing.privateKey.fill(0);
  return {
    crypto,
    plan,
    request,
    domain,
    device,
    admission,
    accepted,
    signingPublicKey: signing.publicKey,
    namespaceRequirements,
    domainRequirements,
  };
}

function productAuthority(
  value: Awaited<ReturnType<typeof fixture>>,
  events: string[],
) {
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
        resolve: (current: unknown) => unknown,
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
      } else if (statement.includes(
        "m291_namespace_key_readable_set_target_members",
      )) {
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
  return {
    runner: {
      transaction: async (use: (
        transaction: unknown,
        product: PostgresJsBridgeExecutor,
      ) => Promise<unknown>) => use(tx, executor),
    },
  };
}

function restrictedAuthority(
  value: Awaited<ReturnType<typeof fixture>>,
  options: Readonly<{
    revoked?: boolean;
    securityRevision?: number;
    deviceProjectionRevision?: number;
    signingPublicKey?: Uint8Array;
    events?: string[];
  }> = {},
): PostgresJsBridgeConnection {
  const installationLineageDigest = new Uint8Array(32).fill(11);
  const headDigest = new Uint8Array(32).fill(8);
  const securityRevision = options.securityRevision ?? 6;
  const deviceProjectionRevision = options.deviceProjectionRevision
    ?? securityRevision;
  const signingPublicKey = options.signingPublicKey ?? value.signingPublicKey;
  const connection: PostgresJsBridgeConnection = {
    query: async <Row extends PostgresJsBridgeRow>(statement: string) => {
      let rows: readonly PostgresJsBridgeRow[];
      if (statement.includes("SELECT current_user::text")) {
        rows = [{
          current_user: "nautilo_crypto",
          session_user: "nautilo_crypto",
        }];
      } else if (statement.includes("roster_bytes")) {
        options.events?.push("device-authority");
        rows = options.revoked ? [] : [{
          user_id: USER,
          human_actor_id: HUMAN,
          device_id: DEVICE,
          device_generation: 2,
          signing_public_key: signingPublicKey.slice(),
          installation_lineage_digest: installationLineageDigest,
          membership_server_instance_id: value.device.serverInstanceId,
          membership_lineage_generation: value.device.lineageGeneration,
          membership_epoch: value.device.epoch,
          membership_security_revision: securityRevision,
          membership_head_digest: headDigest,
          server_instance_id: value.device.serverInstanceId,
          lineage_generation: value.device.lineageGeneration,
          epoch: value.device.epoch,
          security_revision: securityRevision,
          head_digest: headDigest,
          roster_bytes: deviceRoster({
            serverInstanceId: value.device.serverInstanceId,
            lineageGeneration: value.device.lineageGeneration,
            installationLineageDigest,
            deviceGeneration: value.device.deviceGeneration,
          }),
        }];
      } else if (statement.includes("human_crypto_custodies")) {
        options.events?.push("device-projection-lock");
        rows = [{
          device_id: DEVICE,
          device_generation: 2,
          revision: deviceProjectionRevision,
        }];
      } else if (statement.includes("namespace_domain_key_heads")) {
        options.events?.push("namespace-lock");
        rows = [{
          namespace_id: NAMESPACE,
          domain_id: DOMAIN,
          domain_key_generation: value.domain.domainKeyGeneration,
          domain_authorization_revision: value.domain.authorizationRevision,
          domain_head_digest: value.domain.headDigest.slice(),
          binding_digest: new Uint8Array(32).fill(5),
        }];
      } else if (statement.includes("domain_key_recipient_envelopes")) {
        rows = [{ domain_id: DOMAIN }];
      } else if (statement.includes("domain_key_heads")) {
        options.events?.push("domain-lock");
        rows = [{
          domain_id: DOMAIN,
          participant_digest: value.domain.participantDigest.slice(),
          participant_count: value.domain.participantCount,
          domain_key_generation: value.domain.domainKeyGeneration,
          authorization_revision: value.domain.authorizationRevision,
          head_digest: value.domain.headDigest.slice(),
        }];
      } else {
        throw new Error(`Unexpected restricted authority query: ${statement}`);
      }
      return rows as readonly Row[];
    },
    transaction: async () => {
      throw new Error("Task authority must use a non-retrying transaction");
    },
    transactionOnce: async (use) => use(connection),
  };
  return connection;
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
    const additionalNamespace = {
      ...value.namespaceRequirements[0]!,
      ordinal: 1,
      namespaceId: "20000000-0000-4000-8000-000000000005",
      operations: ["decrypt"] as const,
    };
    expect(matchesCurrentTaskRuntimeAuthority({
      ...input,
      namespaces: [...value.namespaceRequirements, additionalNamespace],
    })).toBe(true);
    expect(matchesCurrentTaskRuntimeAuthority({
      ...input,
      namespaces: [
        ...value.namespaceRequirements,
        { ...additionalNamespace, operations: ["encrypt"] },
      ],
    })).toBe(true);
    for (const operations of [[], ["encrypt", "decrypt"], ["decrypt", "decrypt"]] as const) {
      expect(matchesCurrentTaskRuntimeAuthority({
        ...input,
        namespaces: [
          ...value.namespaceRequirements,
          { ...additionalNamespace, operations },
        ],
      })).toBe(false);
    }
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
    expect(matchesCurrentTaskRuntimeAuthority({
      ...input,
      namespaces: value.namespaceRequirements.map((requirement) => ({
        ...requirement,
        expectedPolicyRevision: value.plan.policyRevision + 1,
      })),
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

    let substitutedUseCalled = false;
    const restrictedEvents = events.filter((event) => event === "restricted").length;
    const substituted = await withCurrentTaskRuntimeAuthority({
      runner,
      restricted,
      crypto: value.crypto,
      serverScope: "https://nautilo.example",
      subject: { userId: USER, humanActorId: HUMAN, deviceId: DEVICE },
      admission: value.admission,
      request: value.request,
      namespaceRequirements: value.namespaceRequirements.map((requirement) => ({
        ...requirement,
        expectedAccessRevision: requirement.expectedAccessRevision + 1,
      })),
      domainRequirements: value.domainRequirements,
      now: () => NOW + 1,
      use: async () => {
        substitutedUseCalled = true;
        return "substituted";
      },
    } as unknown as Parameters<typeof withCurrentTaskRuntimeAuthority>[0]);
    expect(substituted).toBeNull();
    expect(substitutedUseCalled).toBe(false);
    expect(events.filter((event) => event === "restricted").length)
      .toBe(restrictedEvents);
  });

  test("rechecks a signed accepted authorization without foreground admission", async () => {
    const value = await fixture();
    const events: string[] = [];
    const { runner } = productAuthority(value, events);
    let useCalled = false;
    const result = await withCurrentAcceptedTaskRuntimeAuthority({
      runner,
      restricted: restrictedAuthority(value),
      crypto: value.crypto,
      serverScope: "https://nautilo.example",
      subject: { userId: USER, humanActorId: HUMAN, deviceId: DEVICE },
      accepted: value.accepted,
      now: () => NOW + 1,
      use: async (authority: CurrentTaskRuntimeAuthority) => {
        useCalled = true;
        expect(authority.device.securityRevision).toBe(6);
        expect(authority.plan.authorizationId).toBe(value.request.requestId);
        expect(authority.domains).toHaveLength(1);
        return "accepted";
      },
    } as unknown as Parameters<
      typeof withCurrentAcceptedTaskRuntimeAuthority
    >[0]);
    expect(result).toBe("accepted");
    expect(useCalled).toBe(true);
    expect(events.slice(0, 2)).toEqual(["policy lock", "policy"]);
    expect(events.filter((event) => event === "product").length)
      .toBeGreaterThan(0);
  });

  test("keeps Task security authority distinct from the locked device projection revision", async () => {
    const value = await fixture();
    const currentEvents: string[] = [];
    const current = await withCurrentTaskRuntimeAuthority({
      ...productAuthority(value, currentEvents),
      restricted: restrictedAuthority(value, {
        deviceProjectionRevision: 9,
        events: currentEvents,
      }),
      crypto: value.crypto,
      serverScope: "https://nautilo.example",
      subject: { userId: USER, humanActorId: HUMAN, deviceId: DEVICE },
      admission: value.admission,
      request: value.request,
      namespaceRequirements: value.namespaceRequirements,
      domainRequirements: value.domainRequirements,
      now: () => NOW + 1,
      use: async (authority: CurrentTaskRuntimeAuthority) => {
        expect(authority.device.securityRevision).toBe(6);
        return "current";
      },
    } as unknown as Parameters<typeof withCurrentTaskRuntimeAuthority>[0]);
    expect(current).toBe("current");
    expect(currentEvents.indexOf("domain-lock"))
      .toBeLessThan(currentEvents.indexOf("device-authority"));

    const acceptedEvents: string[] = [];
    const accepted = await withCurrentAcceptedTaskRuntimeAuthority({
      ...productAuthority(value, acceptedEvents),
      restricted: restrictedAuthority(value, {
        deviceProjectionRevision: 9,
        events: acceptedEvents,
      }),
      crypto: value.crypto,
      serverScope: "https://nautilo.example",
      subject: { userId: USER, humanActorId: HUMAN, deviceId: DEVICE },
      accepted: value.accepted,
      now: () => NOW + 1,
      use: async (authority: CurrentTaskRuntimeAuthority) => {
        expect(authority.device.securityRevision).toBe(6);
        return "accepted";
      },
    } as unknown as Parameters<
      typeof withCurrentAcceptedTaskRuntimeAuthority
    >[0]);
    expect(accepted).toBe("accepted");
    expect(acceptedEvents.indexOf("domain-lock"))
      .toBeLessThan(acceptedEvents.indexOf("device-authority"));
  });

  test("fails closed for revoked, revised, rekeyed, or invalidly signed issuers", async () => {
    const cases = ["revoked", "revised", "rekeyed", "invalid_signature"] as const;
    for (const scenario of cases) {
      const value = await fixture();
      const events: string[] = [];
      const { runner } = productAuthority(value, events);
      const replacement = value.crypto.generateSigningKeyPair();
      const tamperedAuthorization = Uint8Array.from(
        value.accepted.authorizationBytes,
      );
      tamperedAuthorization[tamperedAuthorization.length - 1] =
        tamperedAuthorization[tamperedAuthorization.length - 1]! ^ 1;
      const accepted = scenario === "invalid_signature"
        ? {
          ...value.accepted,
          authorizationBytes: tamperedAuthorization,
          authorizationDigest: hex(value.crypto.hash(tamperedAuthorization)),
        }
        : value.accepted;
      let useCalled = false;
      const result = await withCurrentAcceptedTaskRuntimeAuthority({
        runner,
        restricted: restrictedAuthority(value, {
          revoked: scenario === "revoked",
          securityRevision: scenario === "revised" ? 7 : 6,
          signingPublicKey: scenario === "rekeyed"
            ? replacement.publicKey
            : value.signingPublicKey,
        }),
        crypto: value.crypto,
        serverScope: "https://nautilo.example",
        subject: { userId: USER, humanActorId: HUMAN, deviceId: DEVICE },
        accepted,
        now: () => NOW + 1,
        use: async () => {
          useCalled = true;
          return "unsafe";
        },
      } as unknown as Parameters<
        typeof withCurrentAcceptedTaskRuntimeAuthority
      >[0]);
      replacement.privateKey.fill(0);
      expect(result, scenario).toBeNull();
      expect(useCalled, scenario).toBe(false);
    }
  });

});
