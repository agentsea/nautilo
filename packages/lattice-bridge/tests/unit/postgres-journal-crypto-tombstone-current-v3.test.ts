import { describe, expect, test } from "bun:test";
import { objectId } from "@nautilo/lattice-crypto";

import { PostgresJournalCryptoTombstoneRepository } from
  "../../src/server/journal/postgres-journal-crypto-tombstone.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import { currentProcessorCertificateFixtureV2 } from
  "../helpers/current-processor-certificate-v2.ts";

function sql(value: string): string {
  return value.replaceAll('"', "").replaceAll(/\s+/gu, " ").trim()
    .toLowerCase();
}

type CurrentObject = {
  objectId: string;
  payloadHash: Uint8Array;
  envelopeHash: Uint8Array;
  genesisBytes: Uint8Array;
  genesisHash: Uint8Array;
  tombstoneBytes: Uint8Array;
  tombstoneHash: Uint8Array;
  headRevision: number;
  headHash: Uint8Array;
};

type CurrentFixture = Awaited<ReturnType<
  typeof currentProcessorCertificateFixtureV2
>>;

class CurrentTombstoneConnection implements CryptoPostgresConnection {
  readonly statements: string[] = [];

  constructor(
    readonly current: CurrentFixture,
    readonly object: CurrentObject,
  ) {}

  query<Row>(statement: string): Promise<readonly Row[]> {
    this.statements.push(statement);
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }] as Row[]);
    }
    throw new Error("Current V3 tombstone SQL must use a transaction");
  }

  async transaction<Result>(
    callback: (transaction: CryptoPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    const transaction: CryptoPostgresExecutor = {
      query: async <Row>(
        statement: string,
        parameters: readonly unknown[] = [],
      ): Promise<readonly Row[]> => {
        this.statements.push(statement);
        const normalized = sql(statement);
        if (statement.includes(
          "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
        )) return [];
        if (normalized.includes("from crypto_objects as object")
          && normalized.includes("for update of head")) {
          return [{
            object_id: this.object.objectId,
            object_payload_hash: this.object.payloadHash,
            head_access_revision: this.object.headRevision,
            head_manifest_hash: this.object.headHash,
            genesis_manifest_hash: this.object.genesisHash,
            genesis_payload_hash: this.object.payloadHash,
            genesis_manifest_bytes: this.object.genesisBytes,
            tombstone_manifest_hash: this.object.tombstoneHash,
            tombstone_previous_hash: this.object.genesisHash,
            tombstone_payload_hash: this.object.payloadHash,
            tombstone_manifest_bytes: this.object.tombstoneBytes,
          }] as Row[];
        }
        if (normalized.includes(
          "select authorization_bytes from processor_crypto_signer_authorizations",
        )) {
          return [{authorization_bytes:
            this.current.authorizationRow.authorization_bytes}] as Row[];
        }
        if (normalized.includes(
          "from processor_crypto_signer_authorizations",
        )) return [{...this.current.authorizationRow}] as Row[];
        if (normalized.includes("from human_crypto_devices")) {
          return [{...this.current.deviceRow}] as Row[];
        }
        if (normalized.includes("from object_crypto_namespace_envelopes")
          && parameters.includes(0)) {
          return [{
            namespace_id: this.current.descriptor.authority.namespaceId,
            ordinal: 0,
            envelope_hash: this.object.envelopeHash,
          }] as Row[];
        }
        if (normalized.includes("from object_crypto_namespace_envelopes")
          && parameters.includes(1)) return [];
        if (normalized.includes("update object_crypto_access_heads")) {
          this.object.headRevision = 1;
          this.object.headHash = (parameters[1] as Uint8Array).slice();
          return [{object_id: this.object.objectId}] as Row[];
        }
        throw new Error(`Unexpected current V2 tombstone SQL: ${statement}`);
      },
    };
    return callback(transaction);
  }
}

async function setup(version: 4 | 5 = 4) {
  const targetObjectId = objectId("current-v3-tombstone-object");
  const payloadHash = new Uint8Array(32).fill(0x71);
  const envelopeHash = new Uint8Array(32).fill(0x72);
  const current = await currentProcessorCertificateFixtureV2({
    objects: [{objectId: targetObjectId, payloadHash, envelopeHash}],
    seed: 317_501,
  });
  const manifest = current.manifests[0]!;
  const object: CurrentObject = {
    objectId: targetObjectId,
    payloadHash,
    envelopeHash,
    genesisBytes: version === 4 ? manifest.v4Bytes : manifest.v5Bytes,
    genesisHash: version === 4 ? manifest.v4Hash : manifest.v5Hash,
    tombstoneBytes: version === 4 ? manifest.tombstoneBytes : manifest.v5TombstoneBytes,
    tombstoneHash: version === 4 ? manifest.tombstoneHash : manifest.v5TombstoneHash,
    headRevision: 0,
    headHash: (version === 4 ? manifest.v4Hash : manifest.v5Hash).slice(),
  };
  const connection = new CurrentTombstoneConnection(current, object);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    current,
    connection,
    object,
    repository: new PostgresJournalCryptoTombstoneRepository({
      handle,
      crypto: current.crypto,
    }),
  };
}

describe("journal tombstone current processor certificate", () => {
  test.each([4, 5] as const)("V%s survives request deletion and issuing-device revocation", async version => {
    const value = await setup(version);
    expect(value.repository.tombstoneObjects({
      objectIds: [value.object.objectId],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      status: "tombstoned",
      advancedCount: 1,
      alreadyTombstonedCount: 0,
    });
    expect(value.current.deviceRow.state).toBe("revoked");
    expect(value.connection.statements.some((statement) => sql(statement)
      .includes("background_crypto_authorization_requests"))).toBe(false);
  });

  test.each(["certificate", "object", "scope"] as const)(
    "rejects %s substitution before advancing the head",
    async (substitution) => {
      const value = await setup();
      if (substitution === "certificate") {
        const changed = Uint8Array.from(
          value.current.authorizationRow.authorization_bytes,
        );
        changed[changed.length - 1]! ^= 1;
        value.current.authorizationRow.authorization_bytes = changed;
        value.current.authorizationRow.authorization_hash =
          value.current.crypto.hash(changed);
      } else if (substitution === "object") {
        value.object.tombstoneBytes = Uint8Array.from(
          value.object.tombstoneBytes,
        );
        value.object.tombstoneBytes[value.object.tombstoneBytes.length - 1]! ^= 1;
        value.object.tombstoneHash = value.current.crypto.hash(
          value.object.tombstoneBytes,
        );
      } else {
        value.current.authorizationRow.namespace_id = "other-namespace";
      }
      expect(value.repository.tombstoneObjects({
        objectIds: [value.object.objectId],
        signal: new AbortController().signal,
      })).rejects.toThrow();
      expect(value.object.headRevision).toBe(0);
    },
  );
});
