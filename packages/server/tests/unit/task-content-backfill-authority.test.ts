import { expect, test } from "bun:test";
import type { DirectDatabase, PostgresJsBridgeConnection, TaskContentBackfillClaim } from "@nautilo/db";
import { bindEncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import type { NamespaceProductAuthoritySnapshot } from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import { createHumanProductTransactionContext } from "../../src/routes/human-message-product-store";
import {
  createTaskContentBackfillAuthority, withCurrentTaskContentBackfillDevice,
  type HeldTaskContentBackfillAuthority,
  type TaskContentBackfillSubject,
} from "../../src/routes/task-content-backfill-authority";
import type { readTaskContentBackfillSource } from "../../src/routes/task-content-backfill-source";
import { LatticeCrypto, accessRevision, namespaceGeneration, namespaceId, humanId, cryptoDeviceId } from "@nautilo/lattice-crypto";

const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "10000000-0000-4000-8000-000000000002";
const TASK = "10000000-0000-4000-8000-000000000003";
const ROOM = "10000000-0000-4000-8000-000000000004";
const CLAIM = "10000000-0000-4000-8000-000000000005";
const AGENT = "10000000-0000-4000-8000-000000000006";
const DOMAIN = "10000000-0000-4000-8000-000000000007";

function fixture(mode: "plaintext_only" | "shadow_encryption" | "encrypted_only" = "shadow_encryption") {
  let now = 1_000;
  const calls: string[] = [];
  const subject: TaskContentBackfillSubject = {
    userId: USER, humanActorId: HUMAN,
    admission: { deviceId: "device.1", deviceGeneration: 1, serverInstanceId: "server.1",
      lineageGeneration: 1, epoch: 2, securityRevision: 3,
      headDigest: new Uint8Array(32).fill(5), expiresAt: 2_000 },
  };
  let claim: TaskContentBackfillClaim | null = {
    claimId: CLAIM, humanActorId: HUMAN, requesterUserId: USER,
    deviceId: "device.1", policyRevision: 7, expiresAt: new Date(1_900),
    candidate: { kind: "definition", taskId: TASK, sourceCreatedAt: new Date(500),
      sourceUpdatedAt: new Date(700), sourceRevision: 0, sourceStatus: "paused" },
  };
  const source = { agentId: AGENT, contentNamespaceId: null } as
    NonNullable<Awaited<ReturnType<typeof readTaskContentBackfillSource>>>;
  const namespace = {
    status: "ready" as const, namespaceId: ROOM, namespaceAccessRevision: 2,
    namespaceKeyGeneration: 0, namespaceHeadDigest: new Uint8Array(32),
    namespacePublicationDigest: new Uint8Array(32), namespacePublicationSetDigest: new Uint8Array(32),
    namespaceAudienceFingerprint: new Uint8Array(32), domainId: DOMAIN, domainKeyGeneration: 0,
    domainAuthorizationRevision: 1, domainHeadDigest: new Uint8Array(32),
    bundleRevision: 1, bundleDigest: new Uint8Array(32).fill(4),
  };
  const transaction = {} as CanonicalTranscriptTx;
  const port = { query: async () => [],
    transaction: async () => { throw new Error("Unexpected nested transaction"); },
    transactionOnce: async () => { throw new Error("Unexpected nested transaction"); } };
  const context = async () => ({ canonicalRunner: {
    transaction: async (use: (tx: CanonicalTranscriptTx, executor: typeof port) => Promise<unknown>) => {
      calls.push("product.begin");
      try { const result = await use(transaction, port); calls.push("product.commit"); return result; }
      catch (error) { calls.push("product.rollback"); throw error; }
    },
  } }) as unknown as Awaited<ReturnType<typeof createHumanProductTransactionContext>>;
  const productAuthority = {} as NamespaceProductAuthoritySnapshot;
  let deniedRead: "domain_drift" | "participant_drift" | null = null;
  let recipientPresent = true;
  let substituteNamespace = false;
  const issuedKeys: Uint8Array[] = [];
  const proof = () => {
    const key = new Uint8Array(32).fill(7); issuedKeys.push(key);
    return {
      status: "ready" as const, subjectHumanId: humanId(HUMAN),
      committerDeviceId: cryptoDeviceId(subject.admission.deviceId),
      committerDeviceSigningKeyGeneration: 1, committerDeviceRevision: 3,
      committerDeviceSigningPublicKey: key,
      namespaceId: namespaceId(substituteNamespace ? TASK : ROOM),
      namespaceAccessRevision: accessRevision(2), namespaceKeyGeneration: namespaceGeneration(0),
      namespaceHeadDigest: namespace.namespaceHeadDigest.slice(),
      namespacePublicationDigest: namespace.namespacePublicationDigest.slice(),
      namespacePublicationSetDigest: namespace.namespacePublicationSetDigest.slice(),
      namespaceAudienceFingerprint: namespace.namespaceAudienceFingerprint.slice(),
      participantHumanCount: 1, protectedParticipantHumanCount: 1,
      plaintextParticipantHumanCount: 0, protectedRecipientDeviceCount: recipientPresent ? 1 : 0,
    };
  };
  let roomReads = 0;
  let replaceRoom = false;
  const owner = bindEncryptionDataOperationOwner({ policy: {
    resolve: async () => ({ policy: { mode, shadowBehavior: mode === "plaintext_only" ? "fallback" : "strict" },
      revalidationToken: 7 }),
    revalidate: async () => {},
  } });
  const authority = createTaskContentBackfillAuthority({
    db: {} as DirectDatabase, restricted: port, crypto: new LatticeCrypto(),
    serverScope: "server.1", owner, now: () => now,
  }, {
    withDevice: async input => {
      calls.push("device.held");
      try { return await input.use({ restricted: port, signingPublicKey: new Uint8Array(32).fill(7),
        hostAuthorizationRevision: 3 }); }
      finally { calls.push("device.closed"); }
    },
    context,
    lockClaim: async tx => { expect(tx).toBe(transaction); calls.push("claim.held"); return claim; },
    readSource: async tx => { expect(tx).toBe(transaction); calls.push("source"); return source; },
    privateRoom: tx => {
      expect(tx).toBe(transaction);
      return async () => {
        roomReads += 1;
        return replaceRoom && roomReads > 1 ? null : { roomId: ROOM, namespaceId: ROOM };
      };
    },
    namespace: () => ({ withCurrentPrivateRoom: async operation => {
      calls.push("room.held");
      return operation.use(productAuthority);
    } }),
    readNamespace: async () => ({ namespaceId: ROOM, accessRevision: 2 }),
    domain: restricted => {
      expect(restricted).toBe(port);
      return {
        inspectMessageReadAuthority: async request => {
          expect(request.authority).toBe(productAuthority);
          expect(request.deviceId).toBe(subject.admission.deviceId);
          expect(request.keyClass).toBe("ai");
          calls.push("domain.read");
          return deniedRead === null ? proof() : { status: "unavailable", reason: "namespace_unavailable" };
        },
        inspectSharedAgentWriteAuthority: async request => {
          expect(request.authority).toBe(productAuthority);
          expect(request.deviceId).toBe(subject.admission.deviceId);
          calls.push("domain.write");
          return recipientPresent ? proof() : { status: "unavailable", reason: "recipient_sync_required" };
        },
        inspectForegroundNamespaceAuthority: async () => {
          calls.push("domain.held"); return namespace;
        },
      };
    },
  });
  return { calls, subject, authority, namespace, issuedKeys,
    denyRead(reason: "domain_drift" | "participant_drift") { deniedRead = reason; },
    removeRecipient() { recipientPresent = false; },
    substituteNamespace() { substituteNamespace = true; },
    setClaim(value: TaskContentBackfillClaim | null) { claim = value; },
    changeRoom() { replaceRoom = true; },
    expire() { now = 2_000; },
  };
}

for (const mode of ["plaintext_only", "encrypted_only"] as const) {
  test(`${mode} never opens repair custody or reads ordinary source`, async () => {
    const f = fixture(mode);
    expect(await f.authority.withCurrent({ subject: f.subject, claimId: CLAIM,
      use: async () => { throw new Error("Unreachable repair"); } })).toBeNull();
    expect(f.calls).toEqual([]);
  });
}

test("holds one canonical source authority and destroys it on callback return", async () => {
  const f = fixture();
  let held: HeldTaskContentBackfillAuthority | undefined;
  expect(await f.authority.withCurrent({ subject: f.subject, claimId: CLAIM, use: async current => {
    held = current; current.assertCurrent();
    expect(current.authority.requesterHumanId).toBe(HUMAN);
    expect(current.authority.expectedPolicyRevision).toBe(7);
    expect(current.authority.domainId).toBe(DOMAIN);
    return "read";
  } })).toBe("read");
  expect(f.calls).toEqual(["device.held", "product.begin", "claim.held", "source",
    "room.held", "domain.read", "domain.write", "domain.held", "product.commit", "device.closed"]);
  expect(() => held!.assertCurrent()).toThrow();
  expect(f.namespace.bundleDigest.every(value => value === 0)).toBe(true);
  expect(f.subject.admission.headDigest.every(value => value === 5)).toBe(true);
});

test("lost claim cannot read source and changed Room cannot enter crypto", async () => {
  for (const denial of ["claim", "room"] as const) {
    const f = fixture();
    if (denial === "claim") f.setClaim(null);
    else f.changeRoom();
    expect(await f.authority.withCurrent({ subject: f.subject, claimId: CLAIM,
      use: async () => { throw new Error("Unreachable source"); } })).toBeNull();
    expect(f.calls).not.toContain("domain.held");
    if (denial === "claim") expect(f.calls).not.toContain("source");
  }
});

test("expiry during work rolls back its product transaction", async () => {
  const f = fixture();
  expect(await f.authority.withCurrent({ subject: f.subject, claimId: CLAIM,
    use: async () => { f.expire(); return "uncommitted"; },
  }).catch((error: unknown) => error)).toBeInstanceOf(Error);
  expect(f.calls).toContain("product.rollback");
  expect(f.calls).not.toContain("product.commit");
});


for (const reason of ["domain_drift", "participant_drift"] as const) {
  test(`${reason} rejects source and durable recovery through canonical Domain authority`, async () => {
    for (const purpose of ["write", "read"] as const) {
      const f = fixture(); f.denyRead(reason);
      expect(await f.authority.withCurrent({ subject: f.subject, claimId: CLAIM, purpose,
        use: async () => { throw new Error("stale Domain cannot publish or disclose source"); } })).toBeNull();
      expect(f.calls).toContain("domain.read");
      expect(f.calls).not.toContain("domain.write");
      expect(f.calls).not.toContain("domain.held");
    }
  });
}

test("missing current recipient rejects fresh source/publication but permits metadata-only staged recovery", async () => {
  const fresh = fixture(); fresh.removeRecipient();
  expect(await fresh.authority.withCurrent({ subject: fresh.subject, claimId: CLAIM,
    use: async () => { throw new Error("fresh publication needs recipient coverage"); } })).toBeNull();
  expect(fresh.calls).toContain("domain.write");
  expect(fresh.calls).not.toContain("domain.held");
  const recovery = fixture(); recovery.removeRecipient();
  expect(await recovery.authority.withCurrent({ subject: recovery.subject, claimId: CLAIM, purpose: "read",
    use: async current => {
      current.assertCurrent();
      await current.product.transaction(async transaction => {
        expect(current.isCurrentProductTransaction(transaction)).toBe(true);
      });
      return "recovered";
    } })).toBe("recovered");
  expect(recovery.calls).toContain("domain.read");
  expect(recovery.calls).not.toContain("domain.write");
});

test("canonical proof substitution cannot authorize another Namespace", async () => {
  const f = fixture(); f.substituteNamespace();
  expect(await f.authority.withCurrent({ subject: f.subject, claimId: CLAIM,
    use: async () => { throw new Error("wrong Namespace"); } })).toBeNull();
  expect(f.namespace.bundleDigest.every(value => value === 0)).toBe(true);
  expect(f.issuedKeys.every(key => key.every(value => value === 0))).toBe(true);
});

test("unknown historical purpose cannot downgrade fresh write authority", async () => {
  const f = fixture();
  expect(await f.authority.withCurrent({ subject: f.subject, claimId: CLAIM, purpose: "inspect" as never,
    use: async () => true }).catch((error: unknown) => error)).toBeInstanceOf(TypeError);
  expect(f.calls).toEqual([]);
});


for (const revision of [1, "1", 1n, Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
  test(`raw device host revision ${typeof revision}:${revision} reaches the independent current-device proof`, async () => {
    const subject = fixture().subject;
    const stoppedAtRoleProof = new Error("stop before independent device proof");
    const queries: string[] = [];
    const executor = { query: async (statement: string) => {
      queries.push(statement);
      if (statement.includes("current_user")) throw stoppedAtRoleProof;
      expect(statement).toContain('"human_crypto_devices"');
      expect(statement).toContain("for share");
      return [{ revision }];
    } };
    const transaction = async <Value>(use: (tx: typeof executor) => Promise<Value>) => use(executor);
    const restricted = { ...executor, transaction, transactionOnce: transaction } as PostgresJsBridgeConnection;
    expect(await withCurrentTaskContentBackfillDevice({ restricted, crypto: new LatticeCrypto(), subject,
      now: () => 1_000, use: async () => { throw new Error("current device proof must still be required"); },
    }).catch((error: unknown) => error)).toBe(stoppedAtRoleProof);
    expect(queries).toHaveLength(2);
  });
}

for (const revision of [0, "0", 0n, -1, "-1", -1n, 1.5, "01", "1.0", "1e0", " 1", null,
  Number.MAX_SAFE_INTEGER + 1, "9007199254740992", 9007199254740992n]) {
  test(`invalid raw device host revision ${typeof revision}:${revision} is refused before current-device proof`, async () => {
    const subject = fixture().subject; let queries = 0;
    const executor = { query: async () => { queries += 1; return [{ revision }]; } };
    const transaction = async <Value>(use: (tx: typeof executor) => Promise<Value>) => use(executor);
    const restricted = { ...executor, transaction, transactionOnce: transaction } as PostgresJsBridgeConnection;
    expect(await withCurrentTaskContentBackfillDevice({ restricted, crypto: new LatticeCrypto(), subject,
      now: () => 1_000, use: async () => { throw new Error("invalid host revision"); },
    })).toBeNull();
    expect(queries).toBe(1);
  });
}
