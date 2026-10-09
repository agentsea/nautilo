import { describe, expect, test } from "bun:test";
import {
  persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSet,
  prepareTaskRuntimeAgentObjectAccessManifestGenesisSet,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
  encodeAgentRuntimeSignerPublicationV1,
  encodeEncryptedPayloadV2,
  type AgentRuntimeSignerPublicationV1,
} from "@nautilo/lattice-crypto/wire";
import {
  PostgresLatticeStorage,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "@nautilo/lattice-bridge/server";

import {
  NOW,
  taskRuntimeAgentObjectSetFixture,
} from "../../../lattice-crypto/tests/helpers/task-runtime-agent-object-set-fixture.ts";

type AuthorizedWrite = Parameters<
  PostgresLatticeStorage["compareAndSwapObjectAccessState"]
>[0];

type MutableDomainRow = {
  domain_key_generation: number;
  authorization_revision: number;
  head_digest: Uint8Array;
  participant_digest: Uint8Array;
  participant_count: number;
};

type MutableRuntimeRow = {
  agent_id: string;
  authorization_revision: number;
  runtime_generation: number;
  config_object_count: number;
  config_inventory_digest: Uint8Array;
};

type MutableNamespaceRow = {
  domain_id: string;
  domain_key_generation: number;
  domain_authorization_revision: number;
  domain_head_digest: Uint8Array;
  namespace_current_generation: number;
  namespace_access_revision: number;
  retained_authority_set_digest: Uint8Array;
  state: string;
};

function signerRow(publication: AgentRuntimeSignerPublicationV1) {
  return {
    agent_id: publication.agentId,
    runtime_generation: publication.runtimeGeneration,
    authorization_revision: publication.authorizationRevision,
    transition_kind: publication.transitionKind,
    operation_id: publication.operationId,
    signer_key_id: publication.signerKeyId,
    signer_public_key: publication.signerPublicKey.slice(),
    publication_bytes: encodeAgentRuntimeSignerPublicationV1(publication),
  };
}

async function fixture(seed: number) {
  const native = await taskRuntimeAgentObjectSetFixture(seed);
  const controller = new AbortController();
  const captured: AuthorizedWrite[] = [];
  const selectedIndexes = [0, 2] as const;
  const payloadBytes = encodeEncryptedPayloadV2({
    formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
    context: {
      objectId: native.objectId,
      keyClass: "ai",
      objectType: "memory",
      createdAt: unixTimestamp(100),
    },
    ciphertext: new Uint8Array(64).fill(0x41),
  });

  await native.withEvidence(controller.signal, () => NOW, async (evidence) => {
    const input = native.prepareInput(evidence, selectedIndexes);
    // The current V2 Namespace bundle exposes its retained-set commitment as
    // all four legacy foreground coordinates. Preserve that production
    // adapter contract while generating the genuine Task capability.
    const prepared = prepareTaskRuntimeAgentObjectAccessManifestGenesisSet(
      native.crypto,
      {
        ...input,
        payloadHash: native.crypto.hash(payloadBytes),
        namespaces: input.namespaces.map((namespace) => ({
          ...namespace,
          headDigest: namespace.headDigest.slice(),
          publicationDigest: namespace.headDigest.slice(),
          publicationSetDigest: namespace.headDigest.slice(),
          audienceFingerprint: namespace.headDigest.slice(),
        })),
      },
    );
    const captureStorage = {
      getObject: async (objectId: string) =>
        objectId === native.objectId
          ? {
            objectId,
            payloadBytes: payloadBytes.slice(),
          }
          : null,
      compareAndSwapObjectAccessState: async (authorized: AuthorizedWrite) => {
        captured.push(authorized);
        return "applied" as const;
      },
    };
    expect(await persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSet({
      crypto: native.crypto,
      prepared,
      evidence,
      withCurrentAuthorization: async (_context, use) =>
        use(native.currentAuthorization(captureStorage)),
    })).toBe("applied");
  });

  expect(captured).toHaveLength(1);
  const intended = native.initialized.intended;
  const domainRows = new Map<string, MutableDomainRow>(
    native.domainFacts.map((domain) => [domain.domainId, {
      domain_key_generation: domain.domainKeyGeneration,
      authorization_revision: domain.authorizationRevision,
      head_digest: domain.headDigest.slice(),
      participant_digest: domain.participantDigest.slice(),
      participant_count: domain.participantCount,
    }]),
  );
  const runtimeRow: MutableRuntimeRow = {
    agent_id: intended.runtime.agentId,
    authorization_revision: intended.runtime.authorizationRevision,
    runtime_generation: intended.runtime.runtimeGeneration,
    config_object_count: intended.configInventory.objectCount,
    config_inventory_digest: intended.configInventory.digest.slice(),
  };
  const configRows = intended.configObjects.map((object) => ({
    agent_id: object.agentId,
    object_id: object.objectId,
    config_revision: object.configRevision,
    runtime_generation: object.runtimeGeneration,
    wrapped_dek_hash: object.wrappedDekHash.slice(),
    wrapped_dek_bytes: object.wrappedDek.ciphertext.slice(),
  }));
  const namespaceRows = new Map<string, MutableNamespaceRow>(
    selectedIndexes.map((index) => {
      const namespace = native.namespaceFacts[index]!;
      return [namespace.namespaceId, {
        domain_id: namespace.domain.domainId,
        domain_key_generation: namespace.domain.domainKeyGeneration,
        domain_authorization_revision: namespace.domain.authorizationRevision,
        domain_head_digest: namespace.domain.headDigest.slice(),
        namespace_current_generation: namespace.keyGeneration,
        namespace_access_revision: namespace.accessRevision,
        retained_authority_set_digest: namespace.headDigest.slice(),
        state: "active",
      }];
    }),
  );
  let currentSigner: AgentRuntimeSignerPublicationV1 | null = structuredClone(
    native.initialized.signerPublication,
  );
  const queries: string[] = [];
  const connection: CryptoPostgresConnection = {
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      queries.push(statement);
      const normalized = statement.replaceAll('"', "").toLowerCase();
      let rows: unknown[];
      if (normalized.includes("current_user")) {
        rows = [{
          current_user: "nautilo_crypto",
          session_user: "nautilo_crypto",
        }];
      } else if (normalized.includes("pg_advisory_xact_lock")) {
        rows = [];
      } else if (normalized.includes("from crypto_objects")) {
        rows = [{
          object_id: native.objectId,
          payload_hash: native.crypto.hash(payloadBytes),
          payload_bytes: payloadBytes.slice(),
        }];
      } else if (normalized.includes("from object_crypto_access_heads")) {
        rows = [];
      } else if (normalized.includes("from domain_key_heads")) {
        const row = domainRows.get(String(parameters[0]));
        rows = row === undefined ? [] : [row];
      } else if (normalized.includes("from agent_crypto_runtime_states")) {
        rows = [runtimeRow];
      } else if (
        normalized.includes("from agent_crypto_runtime_config_objects")
      ) {
        rows = configRows;
      } else if (
        normalized.includes("from agent_crypto_runtime_domain_envelopes")
        || normalized.includes("from agent_crypto_runtime_challenges")
      ) {
        rows = [];
      } else if (normalized.includes("from agent_crypto_runtime_signers")) {
        rows = currentSigner === null ? [] : [signerRow(currentSigner)];
      } else if (normalized.includes("from namespace_domain_key_heads")) {
        const row = namespaceRows.get(String(parameters[0]));
        rows = row === undefined ? [] : [row];
      } else if (normalized.startsWith("insert into object_crypto_")) {
        rows = [];
      } else {
        throw new Error(`Unexpected Task object storage query: ${statement}`);
      }
      return rows as Row[];
    },
    async transaction<Result>(
      callback: (transaction: CryptoPostgresConnection) => Promise<Result>,
    ) {
      return callback(connection);
    },
  };
  const storage = new PostgresLatticeStorage(
    await verifyCryptoPostgresHandle(connection),
  );
  return {
    authorized: captured[0]!,
    domainRows,
    namespaceRows,
    queries,
    runtimeRow,
    removeCurrentSigner() {
      currentSigner = null;
    },
    storage,
  };
}

describe("Task Runtime Agent object PostgreSQL CAS", () => {
  test("accepts the exact current Task Domain, Runtime, signer, and Namespace state", async () => {
    const state = await fixture(93_001);

    expect(await state.storage.compareAndSwapObjectAccessState(
      state.authorized,
    )).toBe("applied");
    expect(state.queries.filter((query) =>
      query.includes('from "domain_key_heads"')
    )).toHaveLength(2);
    expect(state.queries.some((query) =>
      query.includes('from "agent_crypto_runtime_states"')
      && query.includes("for update")
    )).toBe(true);
    expect(state.queries.filter((query) =>
      query.includes('from "namespace_domain_key_heads"')
    )).toHaveLength(2);
  });

  test("rejects a Domain changed after the Task capability was issued", async () => {
    const state = await fixture(93_002);
    const first = state.domainRows.values().next().value;
    if (first === undefined) throw new Error("Domain fixture is empty");
    first.authorization_revision += 1;

    expect(await state.storage.compareAndSwapObjectAccessState(
      state.authorized,
    )).toBe("stale");
    expect(state.queries.some((query) => query.startsWith("insert"))).toBe(false);
  });

  test("rejects a Runtime changed after the Task capability was issued", async () => {
    const state = await fixture(93_003);
    state.runtimeRow.authorization_revision += 1;

    expect(await state.storage.compareAndSwapObjectAccessState(
      state.authorized,
    )).toBe("stale");
    expect(state.queries.some((query) => query.startsWith("insert"))).toBe(false);
  });

  test("rejects when the exact signer is absent after the Task capability was issued", async () => {
    const state = await fixture(93_004);
    state.removeCurrentSigner();

    expect(await state.storage.compareAndSwapObjectAccessState(
      state.authorized,
    )).toBe("stale");
    expect(state.queries.some((query) => query.startsWith("insert"))).toBe(false);
  });
});
