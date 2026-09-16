import { expect, test } from "bun:test";
import type { PostgresJsBridgeConnection, PostgresJsBridgeExecutor, PostgresJsBridgeRow } from "@nautilo/db";
import { authorizationRevision, LatticeCrypto } from "@nautilo/lattice-crypto";
import { PostgresDomainKeyAuthorityRepository } from "../../src/server/delivery/postgres-domain-key-authority";
import { PostgresNamespaceProductAuthority } from "../../src/server/delivery/postgres-namespace-product-authority";
import { inspectDomainKeyV2CryptoAuthority } from "../../src/server/message/postgres-live-shadow-turn-plan";

test("foreground checkpoint signing evidence binds the current user, Human, device generation and membership", async () => {
  const queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const key = new Uint8Array(32).fill(7);
  let rows: readonly PostgresJsBridgeRow[] = [{ signing_public_key: key }];
  const executor: PostgresJsBridgeExecutor = {
    query: async <Row extends PostgresJsBridgeRow>(sql: string, parameters: readonly unknown[] = []) => {
      queries.push({ sql, parameters });
      return rows as readonly Row[];
    },
  };
  const connection: PostgresJsBridgeConnection = {
    query: executor.query,
    transaction: async (use) => use(executor),
    transactionOnce: async (use) => use(executor),
  };
  const repository = new PostgresDomainKeyAuthorityRepository(connection, new LatticeCrypto(), "test-server");
  const input = { userId: "user-1", subjectHumanId: "human-1", deviceId: "device-1", generation: 3, revision: 4 };
  const result = await repository.inspectForegroundDeviceSigningAuthority(input);
  expect(result).toEqual(key);
  expect(result).not.toBe(key);
  const query = queries[0]!;
  for (const table of ["human_crypto_devices", "human_crypto_custodies", "human_crypto_device_group_heads"]) {
    expect(query.sql).toContain(`"${table}"`);
  }
  for (const column of ["user_id", "human_id", "device_id", "device_generation", "revision", "membership_head_digest"]) {
    expect(query.sql).toContain(`"${column}"`);
  }
  expect(query.sql).toContain("for share");
  expect(query.parameters).toContain("user-1");
  expect(query.parameters).toContain("human-1");
  expect(query.parameters).toContain("device-1");
  expect(query.parameters).toContain(3);
  expect(query.parameters).toContain(4);
  expect(query.parameters.filter((value) => value === "active")).toHaveLength(2);
  rows = [];
  expect(await repository.inspectForegroundDeviceSigningAuthority(input)).toBeNull();
  rows = [{ signing_public_key: key }, { signing_public_key: key }];
  expect(await repository.inspectForegroundDeviceSigningAuthority(input)).toBeNull();
  result?.fill(0);
  expect(key.every((byte) => byte === 7)).toBe(true);
});

test("checkpoint authority verifies current readability but requests only the exact Namespace Domain", async () => {
  const observed: string[][] = [];
  const digest = () => new Uint8Array(32).fill(1);
  const domain = {
    domainId: "domain-1", sourceNamespaceId: "namespace-1", participantDigest: digest(),
    participantCount: 1, keyClass: "ai" as const, domainKeyGeneration: 1,
    authorizationRevision: authorizationRevision(1), headDigest: digest(),
    activeNamespaceBindingSetDigest: digest(), activeNamespaceBindingCount: 1,
  };
  const repository = {
    inspectForegroundAuthority: async (input: { namespaceIds: readonly string[] }) => {
      observed.push([...input.namespaceIds]);
      return { status: "ready", committerDeviceId: "device-1", committerDeviceSigningGeneration: 1,
        hostAuthorizationRevision: 1, domains: [structuredClone(domain)] };
    },
    inspectForegroundNamespaceAuthority: async () => ({
      status: "ready", namespaceId: "namespace-1", namespaceAccessRevision: 1,
      namespaceKeyGeneration: 1, namespaceHeadDigest: digest(), namespacePublicationDigest: digest(),
      namespacePublicationSetDigest: digest(), namespaceAudienceFingerprint: digest(),
      domainId: "domain-1", domainKeyGeneration: 1, domainAuthorizationRevision: 1,
      domainHeadDigest: digest(), bundleRevision: 1, bundleDigest: digest(),
    }),
  } as unknown as PostgresDomainKeyAuthorityRepository;
  const productAuthority = {
    withCurrentReadableNamespaceSet: async (input: {
      namespaceIds: readonly string[];
      use(entries: readonly { namespaceId: string }[]): Promise<unknown>;
    }) => {
      observed.push([...input.namespaceIds]);
      return input.use([{ namespaceId: "namespace-1" }]);
    },
  } as unknown as PostgresNamespaceProductAuthority;
  const request = {
    repository, productAuthority,
    planInput: { authority: { userId: "user-1", humanActorId: "human-1" }, clientDeviceId: "device-1" },
    product: { roomId: "room-1", agentId: "agent-1", namespaceId: "namespace-1" },
    exactNamespaceOnly: true,
    resolveReadableNamespaces: async () => ["namespace-1", "unrelated-unavailable-namespace"],
  };
  const result = await inspectDomainKeyV2CryptoAuthority(request);
  expect(result.status).toBe("ready");
  expect(observed).toEqual([["namespace-1"], ["namespace-1"]]);
  expect(await inspectDomainKeyV2CryptoAuthority({ ...request,
    resolveReadableNamespaces: async () => ["other-namespace"],
  })).toEqual({ status: "agent_authority_unavailable" });
  expect(observed).toHaveLength(2);
});
