import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  deriveAgentRuntimeObjectSignerPublic,
  namespaceGeneration,
  namespaceId,
  objectId,
  persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSet,
  persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis,
  prepareDeviceWrappedAgentObjectAccessManifestGenesisSet,
  prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis,
  unixTimestamp,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import {
  ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  PostgresLatticeStorage,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "@nautilo/lattice-bridge/server";

type HeadRow = {
  domain_id: string;
  domain_key_generation: number;
  domain_authorization_revision: number;
  domain_head_digest: Uint8Array;
  namespace_current_generation: number;
  namespace_access_revision: number;
  retained_authority_set_digest: Uint8Array;
  state: string;
};

async function fixture(kind: "single" | "set") {
  const crypto = new LatticeCrypto();
  const runtime = {
    agentId: agentId("agent-foreground-storage"),
    keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(4),
    key: new Uint8Array(32).fill(0x31),
  };
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  const targetObjectId = objectId("object-foreground-storage");
  const payloadBytes = encodeEncryptedPayloadV2({
    formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
    context: {
      objectId: targetObjectId,
      keyClass: "ai",
      objectType: kind === "set" ? "memory" : "message",
      createdAt: unixTimestamp(100),
    },
    ciphertext: new Uint8Array(64).fill(0x32),
  });
  const namespaces = (kind === "set" ? ["namespace-a", "namespace-b"] : ["namespace-a"])
    .map((id, index) => ({
      namespaceId: id,
      accessRevision: index + 5,
      keyGeneration: index + 2,
      domainId: `domain-${index + 1}`,
      domainKeyGeneration: index + 7,
      domainAuthorizationRevision: 9,
      domainHeadDigest: new Uint8Array(32).fill(0x58 + index),
      headDigest: new Uint8Array(32).fill(0x60 + index),
      publicationDigest: new Uint8Array(32).fill(0x60 + index),
      publicationSetDigest: new Uint8Array(32).fill(0x60 + index),
      audienceFingerprint: new Uint8Array(32).fill(0x60 + index),
    }));
  const heads = new Map<string, HeadRow>(namespaces.map((namespace) => [namespace.namespaceId, {
    domain_id: namespace.domainId,
    domain_key_generation: namespace.domainKeyGeneration,
    domain_authorization_revision: namespace.domainAuthorizationRevision,
    domain_head_digest: namespace.domainHeadDigest.slice(),
    namespace_current_generation: namespace.keyGeneration,
    namespace_access_revision: namespace.accessRevision,
    retained_authority_set_digest: namespace.headDigest.slice(),
    state: "active",
  }]));
  const queries: string[] = [];
  const connection: CryptoPostgresConnection = {
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      queries.push(statement);
      let rows: unknown[];
      if (statement.includes("current_user")) {
        rows = [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }];
      } else if (statement.includes("pg_advisory_xact_lock")) {
        rows = [];
      } else if (/^select .* from "crypto_objects"/is.test(statement)) {
        rows = [{ object_id: targetObjectId, payload_hash: crypto.hash(payloadBytes), payload_bytes: payloadBytes }];
      } else if (/^select .* from "object_crypto_access_heads"/is.test(statement)) {
        rows = [];
      } else if (/^select .* from "namespace_domain_key_heads"/is.test(statement)) {
        const row = heads.get(String(parameters[0]));
        rows = row === undefined ? [] : [row];
      } else if (/^insert into "object_crypto_(access_manifests|namespace_envelopes|access_heads)"/i.test(statement)) {
        rows = [];
      } else {
        throw new Error(`Unexpected foreground storage query: ${statement}`);
      }
      return rows as Row[];
    },
    async transaction<Result>(callback: (transaction: CryptoPostgresConnection) => Promise<Result>) {
      return callback(connection);
    },
  };
  const storage = new PostgresLatticeStorage(await verifyCryptoPostgresHandle(connection));
  const common = {
    objectId: targetObjectId,
    payloadHash: crypto.hash(payloadBytes),
    envelopeBytes: namespaces.map((namespace, index) => encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespace(crypto, new Uint8Array(32).fill(0x40 + index), {
        objectId: targetObjectId,
        namespaceId: namespaceId(namespace.namespaceId),
        keyClass: "ai",
        keyGeneration: namespaceGeneration(namespace.keyGeneration),
        bindingRevisionAtWrap: accessRevision(namespace.accessRevision),
      }, new Uint8Array(32).fill(0x50)),
    )),
    operationId: "operation-foreground-storage",
    // The live resolver owns the ephemeral Grant. There is no legacy row.
    grant: {
      grantId: "foreground-grant",
      grantHash: new Uint8Array(32).fill(0x33),
      recipientKeyId: "foreground-recipient",
    },
    agentAuthorizationRevision: 9,
    runtime,
    signerKeyId: signer.principal.signerKeyId,
    signerPublicKey: signer.publicKey,
  };
  const decision = {
    grantAuthorized: true,
    namespacesAuthorized: true,
    namespaceAuthorized: true,
    agentAuthorized: true,
    hostAllowsOperation: true,
    currentRuntime: {
      agentId: runtime.agentId,
      authorizationRevision: authorizationRevision(9),
      runtimeGeneration: runtime.generation,
    },
    signerPublicKey: signer.publicKey,
  };
  async function persist(afterAdmission: () => void = () => {}) {
    if (kind === "set") {
      const prepared = prepareDeviceWrappedAgentObjectAccessManifestGenesisSet(crypto, { ...common, namespaces });
      return persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSet({
        crypto, storage, prepared,
        resolveCurrentAuthorization: (context) => {
          afterAdmission();
          const { namespaceAuthorized: _single, ...setDecision } = decision;
          return { ...setDecision, context };
        },
      });
    }
    const prepared = prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis(crypto, {
      ...common, namespace: namespaces[0]!, envelopeBytes: [common.envelopeBytes[0]!],
    });
    return persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis({
      crypto, storage, prepared,
      resolveCurrentAuthorization: (context) => {
        afterAdmission();
        const { namespacesAuthorized: _set, ...singleDecision } = decision;
        return { ...singleDecision, context };
      },
    });
  }
  return { heads, queries, persist, storage };
}

describe("foreground object access PostgreSQL CAS", () => {
  for (const kind of ["single", "set"] as const) {
    test(`${kind}: accepts branded live admission without legacy Grant/runtime rows`, async () => {
      const state = await fixture(kind);
      expect(await state.persist()).toBe("applied");
      const headQueries = state.queries.filter((query) => query.includes('from "namespace_domain_key_heads"'));
      expect(headQueries).toHaveLength(kind === "set" ? 2 : 1);
      for (const query of headQueries) {
        expect(query).toContain('for share of "namespace_domain_key_heads", "namespace_domain_key_bindings"');
      }
      expect(state.queries.some((query) => /crypto_grants|agent_runtime/.test(query))).toBe(false);
    });

    const races: [string, (head: HeadRow) => void][] = [
      ["generation", (head) => { head.namespace_current_generation += 1; }],
      ["access revision", (head) => { head.namespace_access_revision += 1; }],
      ["retained authority", (head) => { head.retained_authority_set_digest.fill(0xff); }],
      ["binding state", (head) => { head.state = "retired"; }],
      ...(kind === "set" ? [
        ["Domain identity", (head: HeadRow) => { head.domain_id = "other-domain"; }],
        ["Domain generation", (head: HeadRow) => { head.domain_key_generation += 1; }],
        ["Domain authorization", (head: HeadRow) => { head.domain_authorization_revision += 1; }],
        ["Domain digest", (head: HeadRow) => { head.domain_head_digest.fill(0xff); }],
      ] satisfies [string, (head: HeadRow) => void][] : []),
    ];
    for (const namespace of kind === "set" ? ["namespace-a", "namespace-b"] : ["namespace-a"]) {
      for (const [name, mutate] of races) {
        test(`${kind}: rejects ${namespace} ${name} changed after admission`, async () => {
          const state = await fixture(kind);
          expect(await state.persist(() => mutate(state.heads.get(namespace)!))).toBe("stale");
          expect(state.queries.some((query) => /^insert /i.test(query))).toBe(false);
        });
      }
      test(`${kind}: rejects ${namespace} removed after admission`, async () => {
        const state = await fixture(kind);
        expect(await state.persist(() => { state.heads.delete(namespace); })).toBe("stale");
        expect(state.queries.some((query) => /^insert /i.test(query))).toBe(false);
      });
    }
  }
});
