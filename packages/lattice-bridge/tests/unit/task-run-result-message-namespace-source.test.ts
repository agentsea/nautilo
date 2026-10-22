import { expect, test } from "bun:test";
import { authorizationRevision } from "@nautilo/lattice-crypto";
import type { PostgresJsBridgeConnection, PostgresJsBridgeRow } from "@nautilo/db";
import { withNativeTaskRunResultMessageNamespaceSource } from
  "../../src/server/task/native-task-run-result-preparation.ts";
import { withTaskRuntimeRunResultReadEvidenceV1 } from
  "../../../lattice-crypto/src/background/task-runtime-run-result-read-evidence-v1.ts";
import { taskRunResultMessageFixture } from "../fixtures/task-run-result-message-fixture";
import type { NativeTaskNamespaceSource } from "../../src/server/task/native-task-message-preparation.ts";

async function fixture() {
  const value = await taskRunResultMessageFixture();
  const source = value.destinationSource;
  const domain = value.evidenceInput.messageWrite!.domain;
  const binding = Buffer.from(source.bindingBytes);
  const digest = Buffer.from(source.expectedBindingDigest);
  const signing = Buffer.from(source.issuerSigningPublicKey);
  const retained = Buffer.from(source.current.retainedAuthoritySetDigest);
  const head = Buffer.from(domain.headDigest);
  const before = [binding, digest, signing, retained, head].map(bytes => Uint8Array.from(bytes));
  let reads = 0;
  let revoke = false;
  const restricted: PostgresJsBridgeConnection = {
    query: <Row extends PostgresJsBridgeRow>(statement: string) => {
      reads++;
      let rows: readonly PostgresJsBridgeRow[];
      if (statement.includes("SELECT current_user::text")) rows = [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }];
      else if (statement.includes('from "namespace_domain_key_heads"') && statement.includes("inner join")) {
        rows = [{ binding_bytes: binding, binding_digest: digest, signing_public_key: signing }];
      } else if (statement.includes('from "namespace_domain_key_heads"')) {
        rows = [{ namespace_id: source.current.namespaceId,
          namespace_access_revision: source.current.namespaceAccessRevision,
          namespace_current_generation: source.current.namespaceCurrentGeneration,
          domain_id: domain.domainId, domain_key_generation: domain.domainKeyGeneration,
          domain_authorization_revision: domain.authorizationRevision,
          domain_head_digest: head, bundle_revision: source.current.bundleRevision,
          retained_generation_count: 1, retained_authority_set_digest: retained, binding_digest: digest }];
      } else if (statement.includes('from "domain_key_heads"')) {
        rows = [{ domain_id: domain.domainId, domain_key_generation: domain.domainKeyGeneration,
          authorization_revision: domain.authorizationRevision + (revoke ? 1 : 0),
          head_digest: head, participant_digest: domain.participantDigest, participant_count: domain.participantCount }];
      } else throw new Error("Unexpected Namespace source query");
      return Promise.resolve(rows as readonly Row[]);
    },
    transaction: use => use(restricted), transactionOnce: use => use(restricted),
  };
  return { value, restricted, reads: () => reads, revoke: () => { revoke = true; },
    originals: [binding, digest, signing, retained, head], before,
    domains: [{ ...domain, authorizationRevision: authorizationRevision(domain.authorizationRevision), domainKey: source.domainKey }] };
}

test("opens only the independent destination, wipes owned bytes without mutating PostgreSQL Buffers", async () => {
  const f = await fixture();
  let escaped: NativeTaskNamespaceSource | undefined;
  let checks = 0;
  await f.value.run(async ({ evidence }) => {
    expect(await withNativeTaskRunResultMessageNamespaceSource({ restricted: f.restricted,
      crypto: f.value.crypto, serverScope: f.value.destinationSource.current.serverId,
      evidence, domains: f.domains, signal: f.value.controller.signal,
      assertCurrentTaskAuthority: () => { checks++; return Promise.resolve(); },
    }, source => {
      escaped = source;
      expect(String(source.current.namespaceId)).toBe(evidence.messageWrite!.namespace.namespaceId);
      expect(String(source.current.namespaceId)).not.toBe(evidence.result.namespace.namespaceId);
      expect(source.bindingBytes).toEqual(f.value.destinationSource.bindingBytes);
      return Promise.resolve("opened");
    })).toBe("opened");
  });
  expect(checks).toBe(2);
  expect(escaped!.bindingBytes.every(byte => byte === 0)).toBe(true);
  expect(escaped!.issuerSigningPublicKey.every(byte => byte === 0)).toBe(true);
  f.originals.forEach((bytes, index) => expect(Uint8Array.from(bytes)).toEqual(f.before[index]!));
  expect(f.domains[0]!.domainKey.some(byte => byte !== 0)).toBe(true);
});

test("private-only Domain projection and forged read evidence never open a destination", async () => {
  const f = await fixture();
  await f.value.run(async ({ evidence }) => {
    for (const override of [
      { evidence: { ...evidence }, domains: f.domains },
      { evidence, domains: [{ ...evidence.resultDomain, authorizationRevision: authorizationRevision(evidence.resultDomain.authorizationRevision), domainKey: f.domains[0]!.domainKey }] },
    ]) {
      const results = await Promise.allSettled([withNativeTaskRunResultMessageNamespaceSource({
        restricted: f.restricted, crypto: f.value.crypto,
        serverScope: f.value.destinationSource.current.serverId,
        ...override, signal: f.value.controller.signal, assertCurrentTaskAuthority: () => Promise.resolve(),
      }, () => { throw new Error("Must not open"); })]);
      expect(results[0]?.status).toBe("rejected");
    }
    expect(f.reads()).toBe(0);
  });
});

test("authority changes during callback reject and still erase owned bundle bytes", async () => {
  const f = await fixture();
  let escaped: NativeTaskNamespaceSource | undefined;
  await f.value.run(async ({ evidence }) => {
    const results = await Promise.allSettled([withNativeTaskRunResultMessageNamespaceSource({
      restricted: f.restricted, crypto: f.value.crypto,
      serverScope: f.value.destinationSource.current.serverId,
      evidence, domains: f.domains, signal: f.value.controller.signal,
      assertCurrentTaskAuthority: () => Promise.resolve(),
    }, source => { escaped = source; f.revoke(); return Promise.resolve("stale"); })]);
    expect(results[0]?.status).toBe("rejected");
  });
  expect(escaped!.bindingBytes.every(byte => byte === 0)).toBe(true);
});

test("authentic read-only evidence cannot acquire a Message write bundle", async () => {
  const f = await fixture();
  const { messageWrite: _write, ...readOnly } = f.value.evidenceInput;
  const results = await Promise.allSettled([withTaskRuntimeRunResultReadEvidenceV1({
    evidence: { ...readOnly, messageWrite: null }, signal: f.value.controller.signal, now: () => f.value.allocation.createdAt,
    execute: evidence => withNativeTaskRunResultMessageNamespaceSource({
      restricted: f.restricted, crypto: f.value.crypto,
      serverScope: f.value.destinationSource.current.serverId,
      evidence, domains: f.domains, signal: f.value.controller.signal,
      assertCurrentTaskAuthority: () => Promise.resolve(),
    }, () => Promise.resolve("must not open")),
  })]);
  expect(results[0]?.status).toBe("rejected");
  expect(f.reads()).toBe(0);
});
