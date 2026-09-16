import { describe, expect, test } from "bun:test";
import { objectId } from "@nautilo/lattice-crypto";

import { verifyStoredObjectAccessManifestChainV5 } from
  "../../src/server/storage/postgres-object-access-manifest-v5.ts";
import type { CryptoPostgresExecutor } from
  "../../src/server/storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from
  "../../src/server/storage/postgres-record-codecs.ts";
import { currentProcessorCertificateFixtureV2 } from
  "../helpers/current-processor-certificate-v2.ts";

function sql(value: string): string {
  return value.replaceAll('"', "").replaceAll(/\s+/gu, " ").trim()
    .toLowerCase();
}

async function fixture() {
  const targetObjectId = objectId("current-v3-common-object");
  const payloadHash = new Uint8Array(32).fill(0x61);
  const current = await currentProcessorCertificateFixtureV2({
    objects: [{
      objectId: targetObjectId,
      payloadHash,
      envelopeHash: new Uint8Array(32).fill(0x62),
    }],
  });
  const manifest = current.manifests[0]!;
  const rows = [{
    object_id: targetObjectId,
    access_revision: 0,
    manifest_hash: manifest.v5Hash,
    previous_manifest_hash: null,
    payload_hash: payloadHash,
    manifest_bytes: manifest.v5Bytes,
  }];
  const statements: string[] = [];
  const executor: CryptoPostgresExecutor = {
    query: <Row extends DatabaseRow = DatabaseRow>(statement: string) => {
      statements.push(statement);
      const normalized = sql(statement);
      let result: readonly DatabaseRow[];
      if (normalized.includes("from object_crypto_access_manifests")) {
        result = rows;
      } else if (normalized.includes(
        "select authorization_bytes from processor_crypto_signer_authorizations",
      )) {
        result = [{authorization_bytes:
          current.authorizationRow.authorization_bytes}];
      } else if (normalized.includes(
        "from processor_crypto_signer_authorizations",
      )) {
        result = [current.authorizationRow];
      } else if (normalized.includes("from human_crypto_devices")) {
        result = [current.deviceRow];
      } else {
        throw new Error(`Unexpected current V2 common-object SQL: ${statement}`);
      }
      return Promise.resolve(result as readonly Row[]);
    },
  };
  return {current, executor, rows, statements, payloadHash, targetObjectId};
}

async function verify(value: Awaited<ReturnType<typeof fixture>>) {
  return verifyStoredObjectAccessManifestChainV5({
    executor: value.executor,
    crypto: value.current.crypto,
    objectId: value.targetObjectId,
    headAccessRevision: 0,
    expectedPayloadHash: value.payloadHash,
    expectedHeadManifestHash: value.rows[0]!.manifest_hash,
    resolveHistoricalAgentManagerAuthority: () => null,
  });
}

describe("stored common-v5 current processor certificate", () => {
  test("survives request deletion and issuing-device revocation", async () => {
    const value = await fixture();
    const verified = await verify(value);

    expect(verified.headManifest.signer.kind).toBe("processor_invocation");
    expect(verified.signerEvidence).toHaveLength(1);
    expect(verified.signerEvidence[0]).toMatchObject({
      kind: "processor_authorization",
      issuer: {
        subjectHumanId: value.current.issuer.humanId,
        deviceId: value.current.issuer.deviceId,
        hostAuthorizationRevision: value.current.issuer.securityRevision,
      },
    });
    expect(value.current.deviceRow.state).toBe("revoked");
    expect(value.statements.some((statement) => sql(statement).includes(
      "background_crypto_authorization_requests",
    ))).toBe(false);
  });

  test.each(["certificate", "object", "scope"] as const)(
    "rejects %s substitution",
    async (substitution) => {
      const value = await fixture();
      if (substitution === "certificate") {
        const changed = Uint8Array.from(
          value.current.authorizationRow.authorization_bytes,
        );
        changed[changed.length - 1]! ^= 1;
        value.current.authorizationRow.authorization_bytes = changed;
        value.current.authorizationRow.authorization_hash =
          value.current.crypto.hash(changed);
      } else if (substitution === "object") {
        const changed = Uint8Array.from(value.rows[0]!.manifest_bytes);
        changed[changed.length - 1]! ^= 1;
        value.rows[0]!.manifest_bytes = changed;
        value.rows[0]!.manifest_hash = value.current.crypto.hash(changed);
      } else {
        value.current.authorizationRow.namespace_id = "other-namespace";
      }
      expect(verify(value)).rejects.toThrow();
    },
  );
});
