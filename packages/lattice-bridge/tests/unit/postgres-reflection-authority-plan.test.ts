import { describe, expect, test } from "bun:test";

import type {
  DirectDatabase,
  PostgresJsBridgeConnection,
  PostgresJsBridgeRow,
  PostgresJsBridgeScalar,
} from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import type {
  BackgroundNamespaceAuthorityV2,
  BackgroundReflectionWorkDescriptorV2,
} from "@nautilo/lattice-crypto/background";

import {
  readPostgresReflectionAuthoritySourcePlan,
  validatePostgresReflectionAuthorityReprojection,
  withPostgresReflectionAuthoritySourcePlan,
  type ReflectionAuthoritySourcePlan,
} from "../../src/server/reflection/postgres-authority-plan.ts";

const RECORD = "record:authority-plan";
const OBJECT = "crypto-object:authority-source";
const LEAF_A = "33000000-0000-4000-8000-000000000001";
const LEAF_B = "33000000-0000-4000-8000-000000000002";
const SOURCE_NAMESPACE = "33000000-0000-4000-8000-000000000003";
const OUTPUT_NAMESPACE = "33000000-0000-4000-8000-000000000004";
const HUMAN_A = "11000000-0000-4000-8000-000000000001";
const HUMAN_B = "11000000-0000-4000-8000-000000000002";
const HUMAN_C = "11000000-0000-4000-8000-000000000003";

function digest(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

type RoomRow = {
  id: string;
  namespace_id: string;
  kind: string;
  human_actor_ids: string[];
  archived_at: Date | null;
};

type State = {
  projectionGeneration: number;
  projectionState: string;
  sourceChangeGeneration: number;
  disposition: string;
  leaves: string[];
  blocked: boolean;
  representationObjectId: string;
  representationHead: number;
  targetRepresentationObjectId: string;
  sourceNamespaceId: string;
  sourceManifestHash: Uint8Array;
  rooms: RoomRow[];
  receipt: null | {
    state: string;
    expectedProjectionGeneration: number;
    targetRepresentationGeneration: number | null;
    targetCryptoObjectId: string | null;
    targetAccessNamespaceIds: string[] | null;
  };
};

function initialState(): State {
  return {
    projectionGeneration: 4,
    projectionState: "current",
    sourceChangeGeneration: 3,
    disposition: "available",
    leaves: [LEAF_A, LEAF_B],
    blocked: false,
    representationObjectId: OBJECT,
    representationHead: 7,
    targetRepresentationObjectId: "crypto-object:authority-output",
    sourceNamespaceId: SOURCE_NAMESPACE,
    sourceManifestHash: digest(9),
    rooms: [
      {
        id: "22000000-0000-4000-8000-000000000001",
        namespace_id: LEAF_A,
        kind: "access",
        human_actor_ids: [HUMAN_A, HUMAN_B],
        archived_at: null,
      },
      {
        id: "22000000-0000-4000-8000-000000000002",
        namespace_id: LEAF_B,
        kind: "access",
        human_actor_ids: [HUMAN_B, HUMAN_C],
        archived_at: null,
      },
      {
        id: "22000000-0000-4000-8000-000000000003",
        namespace_id: SOURCE_NAMESPACE,
        kind: "access",
        human_actor_ids: [HUMAN_B, HUMAN_C],
        archived_at: null,
      },
      {
        id: "22000000-0000-4000-8000-000000000004",
        namespace_id: OUTPUT_NAMESPACE,
        kind: "access",
        human_actor_ids: [HUMAN_B],
        archived_at: null,
      },
    ],
    receipt: null,
  };
}

type Query = {
  statement: string;
  parameters: readonly PostgresJsBridgeScalar[];
};

function databaseHarness(state = initialState()) {
  const productQueries: Query[] = [];
  const restrictedQueries: Query[] = [];
  const product: PostgresJsBridgeConnection = {
    async query<Row extends PostgresJsBridgeRow>(
      statement: string,
      parameters: readonly PostgresJsBridgeScalar[] = [],
    ): Promise<readonly Row[]> {
      productQueries.push({ statement, parameters });
      const sql = statement.replaceAll('"', "").replaceAll(/\s+/g, " ").toLowerCase();
      if (sql.includes("from reflection_record_authority_projections")) {
        return [{
          projection_generation: state.projectionGeneration,
          source_change_generation: state.sourceChangeGeneration,
          processing_state: state.projectionState,
          disposition: state.disposition,
        }] as unknown as readonly Row[];
      }
      if (sql.includes("from reflection_record_authority_closure")) {
        return state.leaves.map((terminal_leaf_handle) => ({
          terminal_leaf_handle,
        })) as unknown as readonly Row[];
      }
      if (sql.includes("from reflection_record_authority_blocks")) {
        return (state.blocked ? [{ block_id: "block:1" }] : []) as unknown as readonly Row[];
      }
      if (sql.includes("from reflection_record_payload_representations")) {
        if (!sql.includes("inner join reflection_record_payload_representation_heads")) {
          return [{
            crypto_object_id: state.targetRepresentationObjectId,
          }] as unknown as readonly Row[];
        }
        return [{
          crypto_object_id: state.representationObjectId,
          current_representation_generation: state.representationHead,
        }] as unknown as readonly Row[];
      }
      if (sql.includes("from reflection_record_authority_reconciliations")) {
        const receipt = state.receipt;
        return (receipt === null ? [] : [{
          state: receipt.state,
          expected_projection_generation: receipt.expectedProjectionGeneration,
          target_representation_generation: receipt.targetRepresentationGeneration,
          target_crypto_object_id: receipt.targetCryptoObjectId,
          target_access_namespace_ids: receipt.targetAccessNamespaceIds,
        }]) as unknown as readonly Row[];
      }
      if (sql.includes("from rooms")) {
        return [...state.rooms]
          .sort((left, right) => left.id.localeCompare(right.id)) as unknown as readonly Row[];
      }
      if (sql === "select callback_fence_probe") return [];
      throw new Error(`Unexpected product query: ${statement}`);
    },
    transaction: (use) => use(product),
    transactionOnce: (use) => use(product),
  };
  const restricted: PostgresJsBridgeConnection = {
    async query<Row extends PostgresJsBridgeRow>(
      statement: string,
      parameters: readonly PostgresJsBridgeScalar[] = [],
    ): Promise<readonly Row[]> {
      restrictedQueries.push({ statement, parameters });
      const sql = statement.replaceAll('"', "").replaceAll(/\s+/g, " ").toLowerCase();
      if (sql.includes("from object_crypto_access_heads")) {
        return [{
          namespace_id: state.sourceNamespaceId,
          manifest_hash: state.sourceManifestHash.slice(),
        }] as unknown as readonly Row[];
      }
      if (sql.includes("from namespace_domain_key_heads")) {
        const namespaceId = parameters[0] as string;
        return [{
          namespace_id: namespaceId,
          namespace_access_revision: 11,
          namespace_current_generation: 2,
          domain_id: `domain:${namespaceId}`,
          domain_key_generation: 3,
          domain_authorization_revision: 4,
          domain_head_digest: digest(31),
          bundle_revision: 5,
          retained_generation_count: 3,
          retained_authority_set_digest: digest(32),
          binding_digest: digest(33),
        }] as unknown as readonly Row[];
      }
      throw new Error(`Unexpected restricted query: ${statement}`);
    },
    transaction: (use) => use(restricted),
    transactionOnce: (use) => use(restricted),
  };
  return { product, productQueries, restricted, restrictedQueries, state };
}

const coordinates = {
  recordRef: RECORD,
  sourceChangeGeneration: 3,
  expectedProjectionGeneration: 4,
  expectedRepresentationGeneration: 7,
  targetRepresentationGeneration: 8,
  exactAccessNamespaceIds: [OUTPUT_NAMESPACE],
} as const;

function namespaceAuthority(
  namespaceId: string,
  roomId: string,
): BackgroundNamespaceAuthorityV2 {
  return {
    serverId: "https://m327.example",
    roomId,
    namespaceId,
    namespaceAccessRevision: 11,
    namespaceKeyGeneration: 2,
    namespaceHeadDigest: digest(32),
    domainId: `domain:${namespaceId}`,
    domainKeyGeneration: 3,
    domainAuthorizationRevision: 4,
    domainHeadDigest: digest(31),
    bundleRevision: 5,
    bundleDigest: digest(33),
  };
}

function descriptorFrom(plan: ReflectionAuthoritySourcePlan): BackgroundReflectionWorkDescriptorV2 {
  return {
    formatVersion: 2,
    requestId: "request:authority-plan",
    recipientGeneration: 1,
    workKind: "reflection.authority_reproject",
    workId: "work:authority-plan",
    anchorNamespaceId: OUTPUT_NAMESPACE,
    anchorDomainId: `domain:${OUTPUT_NAMESPACE}`,
    subject: { kind: "processor", processorKind: "reflection", processorVersion: 1 },
    operations: ["decrypt", "encrypt"],
    purpose: "record.reproject",
    source: {
      kind: "reflection_authority",
      recordRef: plan.recordRef,
      sourceChangeGeneration: plan.sourceChangeGeneration,
      projectionGeneration: plan.expectedProjectionGeneration,
      expectedRepresentationGeneration: plan.expectedRepresentationGeneration,
      targetRepresentationGeneration: plan.targetRepresentationGeneration,
      fingerprint: plan.fingerprint.slice(),
    },
    namespaceRequirements: plan.namespaceRooms.map(({ namespaceId, roomId }) => ({
      authority: namespaceAuthority(namespaceId, roomId),
      operations: namespaceId === plan.sourceNamespaceId
        ? ["decrypt"] as const
        : ["encrypt"] as const,
    })),
    policyRevision: 12,
    inputBindings: [{ objectId: plan.sourceObjectId, namespaceId: plan.sourceNamespaceId }],
    outputSlots: [{
      objectId: "crypto-object:authority-output",
      objectType: "nautilo.reflection.record.v1",
      createdAt: 1_000,
      namespaceIds: [...plan.exactAccessNamespaceIds],
    }],
    maximumPlaintextBytes: 1_024,
    maximumCiphertextBytes: 4_096,
    recipientKeyId: "recipient:authority-plan",
    recipientPublicKey: new Uint8Array(65).fill(1),
    issuedAt: 1_000,
    notBefore: 1_000,
    expiresAt: 2_000,
    idempotencyId: "attempt:authority-plan",
  };
}

describe("PostgreSQL Reflection authority source planning", () => {
  test("derives output authority from the canonical source closure, not origin or persona", async () => {
    const crypto = new LatticeCrypto();
    const harness = databaseHarness();
    const plan = await readPostgresReflectionAuthoritySourcePlan({
      product: harness.product,
      restricted: harness.restricted,
      crypto,
      coordinates,
      lock: true,
    });

    expect(plan).not.toBeNull();
    expect(plan).toMatchObject({
      sourceObjectId: OBJECT,
      sourceNamespaceId: SOURCE_NAMESPACE,
      exactAccessNamespaceIds: [OUTPUT_NAMESPACE],
      namespaceRooms: [
        {
          namespaceId: SOURCE_NAMESPACE,
          roomId: "22000000-0000-4000-8000-000000000003",
        },
        {
          namespaceId: OUTPUT_NAMESPACE,
          roomId: "22000000-0000-4000-8000-000000000004",
        },
      ],
    });
    expect(harness.productQueries.some(({ statement }) =>
      statement.includes("reflection_record_authority_closure"))).toBe(true);
    expect(harness.productQueries.some(({ statement }) =>
      /origin|persona|publication_binding/.test(statement))).toBe(false);
    const roomQuery = harness.productQueries.find(({ statement }) =>
      statement.includes('from "rooms"'))!;
    expect(roomQuery.statement.toLowerCase()).toContain("for update");
    expect(roomQuery.parameters).toContain(LEAF_A);
    expect(roomQuery.parameters).toContain(LEAF_B);
    const representationQuery = harness.productQueries.find(({ statement }) =>
      statement.includes("reflection_record_payload_representations"))!;
    expect(representationQuery.parameters).toContain(RECORD);
    expect(representationQuery.parameters).toContain(7);
    expect(harness.restrictedQueries[0]?.parameters).toContain(OBJECT);
    plan?.fingerprint.fill(0);
    plan?.sourceManifestHash.fill(0);
  });

  test("requires one exact access Room with the canonical common Human audience", async () => {
    const crypto = new LatticeCrypto();
    {
      const harness = databaseHarness();
      harness.state.rooms.find(({ namespace_id }) =>
        namespace_id === LEAF_A)!.human_actor_ids = [HUMAN_A];
      harness.state.rooms.find(({ namespace_id }) =>
        namespace_id === LEAF_B)!.human_actor_ids = [HUMAN_B];
      expect(await readPostgresReflectionAuthoritySourcePlan({
        product: harness.product,
        restricted: harness.restricted,
        crypto,
        coordinates,
      })).toBeNull();
    }
    for (const outputChange of [
      { kind: "persona" },
      { human_actor_ids: [HUMAN_A] },
    ]) {
      const harness = databaseHarness();
      Object.assign(harness.state.rooms.find(({ namespace_id }) =>
        namespace_id === OUTPUT_NAMESPACE)!, outputChange);
      expect(await readPostgresReflectionAuthoritySourcePlan({
        product: harness.product,
        restricted: harness.restricted,
        crypto,
        coordinates,
      })).toBeNull();
    }
  });

  test("allows ordinary logical completion to leave the protected head pending", async () => {
    const harness = databaseHarness();
    harness.state.projectionGeneration = 5;
    harness.state.receipt = {
      state: "complete",
      expectedProjectionGeneration: 4,
      targetRepresentationGeneration: null,
      targetCryptoObjectId: null,
      targetAccessNamespaceIds: null,
    };
    const plan = await readPostgresReflectionAuthoritySourcePlan({
      product: harness.product,
      restricted: harness.restricted,
      crypto: new LatticeCrypto(),
      coordinates,
    });
    expect(plan).not.toBeNull();
    expect(plan?.expectedRepresentationGeneration).toBe(7);
    plan?.fingerprint.fill(0);
    plan?.sourceManifestHash.fill(0);
  });

  test("accepts an applied protected head only with its matching receipt", async () => {
    for (const receipt of [
      {
        state: "complete",
        expectedProjectionGeneration: 4,
        targetRepresentationGeneration: 8,
        targetCryptoObjectId: "crypto-object:authority-output",
        targetAccessNamespaceIds: [OUTPUT_NAMESPACE],
        accepted: true,
      },
      {
        state: "complete",
        expectedProjectionGeneration: 4,
        targetRepresentationGeneration: 9,
        targetCryptoObjectId: "crypto-object:authority-output",
        targetAccessNamespaceIds: [OUTPUT_NAMESPACE],
        accepted: false,
      },
      {
        state: "complete",
        expectedProjectionGeneration: 4,
        targetRepresentationGeneration: 8,
        targetCryptoObjectId: "crypto-object:authority-output",
        targetAccessNamespaceIds: [SOURCE_NAMESPACE],
        accepted: false,
      },
      {
        state: "crypto_complete",
        expectedProjectionGeneration: 4,
        targetRepresentationGeneration: 8,
        targetCryptoObjectId: "crypto-object:authority-output",
        targetAccessNamespaceIds: [OUTPUT_NAMESPACE],
        accepted: false,
      },
      {
        state: "complete",
        expectedProjectionGeneration: 4,
        targetRepresentationGeneration: 8,
        targetCryptoObjectId: "crypto-object:substituted-output",
        targetAccessNamespaceIds: [OUTPUT_NAMESPACE],
        accepted: false,
      },
    ]) {
      const harness = databaseHarness();
      harness.state.projectionGeneration = 5;
      harness.state.representationHead = 8;
      harness.state.receipt = receipt;
      const plan = await readPostgresReflectionAuthoritySourcePlan({
        product: harness.product,
        restricted: harness.restricted,
        crypto: new LatticeCrypto(),
        coordinates,
      });
      expect(plan !== null).toBe(receipt.accepted);
      plan?.fingerprint.fill(0);
      plan?.sourceManifestHash.fill(0);
    }

    const incompleteProduct = databaseHarness();
    incompleteProduct.state.representationHead = 8;
    incompleteProduct.state.receipt = {
      state: "complete",
      expectedProjectionGeneration: 4,
      targetRepresentationGeneration: 8,
      targetCryptoObjectId: "crypto-object:authority-output",
      targetAccessNamespaceIds: [OUTPUT_NAMESPACE],
    };
    expect(await readPostgresReflectionAuthoritySourcePlan({
      product: incompleteProduct.product,
      restricted: incompleteProduct.restricted,
      crypto: new LatticeCrypto(),
      coordinates,
    })).toBeNull();
  });

  test("rejects descriptor substitution and changes to the current source or Room authority", async () => {
    const crypto = new LatticeCrypto();
    const harness = databaseHarness();
    const plan = await readPostgresReflectionAuthoritySourcePlan({
      product: harness.product,
      restricted: harness.restricted,
      crypto,
      coordinates,
    });
    expect(plan).not.toBeNull();
    const descriptor = descriptorFrom(plan!);
    expect(await validatePostgresReflectionAuthorityReprojection({
      product: harness.product,
      restricted: harness.restricted,
      crypto,
      descriptor,
    })).toBe(true);

    const fingerprintByte = descriptor.source.fingerprint[0]!;
    descriptor.source.fingerprint[0] = fingerprintByte ^ 1;
    expect(await validatePostgresReflectionAuthorityReprojection({
      product: harness.product,
      restricted: harness.restricted,
      crypto,
      descriptor,
    })).toBe(false);
    descriptor.source.fingerprint[0] = fingerprintByte;

    harness.state.sourceManifestHash = digest(45);
    expect(await validatePostgresReflectionAuthorityReprojection({
      product: harness.product,
      restricted: harness.restricted,
      crypto,
      descriptor,
    })).toBe(false);
    harness.state.sourceManifestHash = digest(9);

    harness.state.representationObjectId = "crypto-object:substituted";
    expect(await validatePostgresReflectionAuthorityReprojection({
      product: harness.product,
      restricted: harness.restricted,
      crypto,
      descriptor,
    })).toBe(false);
    harness.state.representationObjectId = OBJECT;

    harness.state.rooms.find(({ namespace_id }) =>
      namespace_id === SOURCE_NAMESPACE)!.human_actor_ids = [HUMAN_A, HUMAN_B, HUMAN_C];
    expect(await validatePostgresReflectionAuthorityReprojection({
      product: harness.product,
      restricted: harness.restricted,
      crypto,
      descriptor,
    })).toBe(false);
    plan?.fingerprint.fill(0);
    plan?.sourceManifestHash.fill(0);
  });

  test.each([false, true])("holds preparation fences and wakes missing bundles after release (missing=%s)", async missingBundle => {
    const crypto = new LatticeCrypto();
    const harness = databaseHarness();
    if (missingBundle) {
      const query = harness.restricted.query.bind(harness.restricted);
      harness.restricted.query = async (statement, parameters) =>
        statement.includes('"namespace_domain_key_heads"') && parameters?.[0] === OUTPUT_NAMESPACE
          ? [] : query(statement, parameters);
    }
    const events: string[] = [];
    let transactionOpen = false;
    const transactionClient = Object.assign(
      () => undefined,
      {
        unsafe: async (
          statement: string,
          parameters: readonly PostgresJsBridgeScalar[] = [],
        ) => {
          events.push("product-query");
          return harness.product.query(statement, parameters);
        },
        savepoint: async () => undefined,
      },
    );
    const poolClient = Object.assign(
      () => undefined,
      {
        unsafe: transactionClient.unsafe,
        begin: async () => undefined,
      },
    );
    const selection = {
      from: () => selection,
      where: () => Promise.resolve([{
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        revision: 12,
      }]),
    };
    const transaction = {
      session: { client: transactionClient },
      execute: async () => {
        events.push("policy-lock");
      },
      select: () => selection,
    };
    const db = {
      $client: poolClient,
      transaction: async <Value>(use: (tx: typeof transaction) => Promise<Value>) => {
        transactionOpen = true;
        try {
          return await use(transaction);
        } finally {
          transactionOpen = false;
          events.push("transaction-exit");
        }
      },
    } as unknown as DirectDatabase;

    const value = await withPostgresReflectionAuthoritySourcePlan({
      db,
      restricted: harness.restricted,
      crypto,
      serverScope: "https://m327.example",
      coordinates,
      namespaceReadinessRequested: async coordinate => {
        expect(transactionOpen).toBe(false);
        expect(coordinate).toEqual({roomId: "22000000-0000-4000-8000-000000000004", namespaceId: OUTPUT_NAMESPACE});
        events.push("namespace-wake");
      },
      use: async ({ plan, namespaces, policyRevision, product }) => {
        expect(missingBundle).toBe(false);
        expect(transactionOpen).toBe(true);
        expect(policyRevision).toBe(12);
        expect(namespaces.map(({ namespaceId }) => namespaceId)).toEqual([
          SOURCE_NAMESPACE,
          OUTPUT_NAMESPACE,
        ]);
        expect(await product.query("select callback_fence_probe")).toEqual([]);
        expect(plan.fingerprint).toHaveLength(32);
        return "prepared";
      },
    });
    expect(value).toBe(missingBundle ? null : "prepared");
    expect(events[0]).toBe("policy-lock");
    expect(events.at(-1)).toBe(missingBundle ? "namespace-wake" : "transaction-exit");
  });
});
