import { expect, test } from "bun:test";
import {
  taskDefinitionCryptoRevisions,
  tasks,
  type DirectDatabase,
  type PostgresJsBridgeConnection,
  type TaskContentBackfillClaim,
} from "@nautilo/db";
import { bindEncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { TaskContentBackfillSubject } from
  "../../src/routes/task-content-backfill-authority";
import {
  assertMappedTaskContentBackfill,
  createTaskContentBackfillScanService,
} from "../../src/routes/task-content-backfill-scan";

const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "10000000-0000-4000-8000-000000000002";
const TASK = "10000000-0000-4000-8000-000000000003";
const NAMESPACE = "10000000-0000-4000-8000-000000000004";
const CLAIM = "10000000-0000-4000-8000-000000000005";
const ORIGINAL_CLAIM = "10000000-0000-4000-8000-000000000006";
const NOW = 10_000;

const subject: TaskContentBackfillSubject = Object.freeze({
  userId: USER,
  humanActorId: HUMAN,
  admission: Object.freeze({
    deviceId: "device.current",
    deviceGeneration: 1,
    serverInstanceId: "server.1",
    lineageGeneration: 1,
    epoch: 2,
    securityRevision: 3,
    headDigest: new Uint8Array(32).fill(7),
    expiresAt: NOW + 400,
  }),
});

const candidate = Object.freeze({
  kind: "definition" as const,
  taskId: TASK,
  sourceCreatedAt: new Date(1_000),
  sourceUpdatedAt: new Date(2_000),
  sourceRevision: 0,
  sourceStatus: "paused",
});

const claim: TaskContentBackfillClaim = Object.freeze({
  claimId: CLAIM,
  humanActorId: HUMAN,
  requesterUserId: USER,
  deviceId: "device.current",
  policyRevision: 7,
  expiresAt: new Date(NOW + 350),
  candidate,
});

function fixture(mode: "plaintext_only" | "shadow_encryption" | "encrypted_only" = "shadow_encryption") {
  const calls: string[] = [];
  let currentClaim: TaskContentBackfillClaim | null = claim;
  let deviceCurrent = true;
  let authorityCurrent = true;
  let sourceClassification: "supported" | "unsupported" | "no_content" | "waiting_parent" | null = "supported";
  const owner = bindEncryptionDataOperationOwner({
    policy: {
      resolve: async () => ({
        policy: {
          mode,
          shadowBehavior: mode === "plaintext_only" ? "fallback" : "strict",
        },
        revalidationToken: 7,
      }),
      revalidate: async () => {},
    },
  });
  const port = Object.freeze({}) as PostgresJsBridgeConnection;
  let mappedAssertion: ((...args: never[]) => Promise<boolean>) | undefined;
  const service = createTaskContentBackfillScanService({
    db: {} as DirectDatabase,
    restricted: port,
    crypto: new LatticeCrypto(),
    serverScope: "server.1",
    owner,
    pageLimit: 12,
    leaseDurationMs: 1_000,
    sweepIntervalMs: 5_000,
    now: () => NOW,
    createId: () => CLAIM,
  }, {
    withDevice: async input => {
      calls.push("device");
      return deviceCurrent ? input.use({
        restricted: port,
        signingPublicKey: new Uint8Array(32),
        hostAuthorizationRevision: 1,
      }) : null;
    },
    withCandidateAuthority: async input => {
      expect(input.restricted).toBe(port);
      calls.push(`authority.${input.state}`);
      return authorityCurrent ? input.use({} as never) : null;
    },
    discover: async (_db, input) => {
      calls.push(`discover.${input.pageLimit}.${input.resumeAt.getTime()}`);
      return {
        status: "candidate" as const,
        candidate,
        policyRevision: 7,
        requesterUserId: USER,
      };
    },
    claim: async (_db, input) => {
      calls.push("claim");
      return {
        status: "claimed" as const,
        claim: Object.freeze({ ...claim, expiresAt: input.expiresAt }),
      };
    },
    readClaim: async (_db, input) => {
      calls.push(`read.${input.claimId}`);
      return currentClaim;
    },
    progress: async () => {
      calls.push("progress");
      return {
        eligibleDefinitions: 1,
        mappedDefinitions: 0,
        eligibleResults: 0,
        mappedResults: 0,
        claimedRepairing: 0,
        waiting: 0,
        unsupported: 0,
        failed: 0,
        noContent: 0,
        pending: 1,
      };
    },
    release: async (_db, input) => {
      calls.push(`release.${String(input.advance)}`);
      return input.claim.claimId === claim.claimId;
    },
    acknowledge: async (_db, input) => {
      calls.push(`ack.${input.outcome}`);
      if (input.outcome === "mapped") mappedAssertion = input.assertMapped as typeof mappedAssertion;
      return "acknowledged" as const;
    },
    classifySource: async () => {
      calls.push(`classify.${String(sourceClassification)}`);
      return sourceClassification;
    },
  });
  return {
    calls,
    service,
    mappedAssertion: () => mappedAssertion,
    revokeDevice() { deviceCurrent = false; },
    revokeAuthority() { authorityCurrent = false; },
    setClaim(value: TaskContentBackfillClaim | null) { currentClaim = value; },
    setSourceClassification(value: typeof sourceClassification) {
      sourceClassification = value;
    },
  };
}

for (const mode of ["plaintext_only", "encrypted_only"] as const) {
  test(`${mode} exits before device admission or scan mutation`, async () => {
    const f = fixture(mode);
    expect(await f.service.discover(subject)).toEqual({ status: "inactive" });
    expect(await f.service.progress(subject)).toEqual({ status: "inactive" });
    expect(f.calls).toEqual([]);
  });
}

test("discovery is content-free and admitted-device bound", async () => {
  const f = fixture();
  expect(await f.service.discover(subject)).toEqual({
    status: "ready",
    value: {
      status: "candidate",
      candidate,
      policyRevision: 7,
      requesterUserId: USER,
    },
  });
  expect(f.calls).toEqual(["device", `discover.12.${NOW + 5_000}`]);

  const denied = fixture();
  denied.revokeDevice();
  expect(await denied.service.discover(subject)).toEqual({ status: "unauthorized" });
  expect(denied.calls).toEqual(["device"]);
});

test("claim exposes only current Namespace authority and bounds lease by admission", async () => {
  const f = fixture();
  const result = await f.service.claim(subject, { candidate, policyRevision: 7 });
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("Expected claim result");
  expect(result.value.status).toBe("claimed");
  if (result.value.status !== "claimed") throw new Error("Expected claim");
  expect(result.value.claim.expiresAt.getTime()).toBe(subject.admission.expiresAt);
  expect(f.calls).toEqual(["device", "claim", "authority.source"]);

  const revoked = fixture();
  revoked.revokeAuthority();
  expect(await revoked.service.claim(subject, { candidate, policyRevision: 7 }))
    .toEqual({ status: "ready", value: { status: "deferred" } });
  expect(revoked.calls).toEqual(["device", "claim", "authority.source", "release.true"]);
});

test("release reloads exact server claim and reauthorizes its namespace", async () => {
  const f = fixture();
  expect(await f.service.release(subject, CLAIM, false)).toEqual({
    status: "ready",
    value: true,
  });
  expect(f.calls).toEqual(["device", `read.${CLAIM}`, "authority.source", "release.false"]);

  const wrong = fixture();
  wrong.setClaim(Object.freeze({ ...claim, requesterUserId:
    "20000000-0000-4000-8000-000000000001" }));
  expect(await wrong.service.release(subject, CLAIM, true)).toEqual({
    status: "ready",
    value: false,
  });
  expect(wrong.calls).toEqual(["device", `read.${CLAIM}`]);
});

test("mapped acknowledgement receives the borrowed immutable-ledger verifier", async () => {
  const f = fixture();
  expect(await f.service.acknowledge(subject, CLAIM, "mapped")).toEqual({
    status: "ready",
    value: "acknowledged",
  });
  expect(f.calls).toEqual(["device", `read.${CLAIM}`, "authority.mapped", "ack.mapped"]);
  expect(f.mappedAssertion()).toBeFunction();
});

test("non-mapped acknowledgement must match the freshly classified held source", async () => {
  const supported = fixture();
  expect(await supported.service.acknowledge(subject, CLAIM, "unsupported"))
    .toEqual({ status: "ready", value: "source_changed" });
  expect(supported.calls).toEqual([
    "device", `read.${CLAIM}`, "authority.source", "classify.supported",
  ]);

  const clientIntegrity = fixture();
  expect(await clientIntegrity.service.acknowledge(subject, CLAIM, "integrity"))
    .toEqual({ status: "ready", value: "source_changed" });
  expect(clientIntegrity.calls).toEqual([
    "device", `read.${CLAIM}`, "authority.source", "classify.supported",
  ]);

  for (const disposition of ["unsupported", "no_content", "waiting_parent"] as const) {
    const exact = fixture();
    exact.setSourceClassification(disposition);
    expect(await exact.service.acknowledge(subject, CLAIM, disposition))
      .toEqual({ status: "ready", value: "acknowledged" });
    expect(exact.calls).toEqual([
      "device", `read.${CLAIM}`, "authority.source", `classify.${disposition}`,
      `ack.${disposition}`,
    ]);
  }
});

test("mapped verifier accepts an exact v2 origin from an older claim and device", async () => {
  const digest = new Uint8Array(32).fill(9);
  const objectId = `task-historical:v1:${"a".repeat(64)}`;
  const ledger = {
    taskId: TASK,
    contentNamespaceId: NAMESPACE,
    contentRevision: 1,
    operationId: `task-historical-publish:${"a".repeat(64)}`,
    requestDigest: digest,
    authorityFingerprint: new Uint8Array(32).fill(4),
    requesterHumanId: HUMAN,
    anchorNamespaceId: NAMESPACE,
    cryptoObjectId: objectId,
    representation: "dual" as const,
    payloadVersion: 1,
    cryptoAccessRevision: 0,
    requiredNamespaceFingerprint: new Uint8Array(32).fill(5),
    historicalRepair: {
      version: 2,
      claimId: ORIGINAL_CLAIM,
      publisherDeviceId: "device.original",
      signedRequestDigest: Buffer.from(digest).toString("hex"),
      sourceDigest: "b".repeat(64),
      sourcePayloadHash: "c".repeat(64),
      sourceRevision: 0,
      genesisManifestHash: "d".repeat(64),
    },
    completion: "complete" as const,
    disposition: "mapped" as const,
    failureCode: null,
    cryptoCompletedAt: new Date(3_000),
  };
  const mapped = {
    ownerId: USER,
    requestorId: USER,
    namespaceId: NAMESPACE,
    revision: 1,
    objectId,
    accessRevision: 0,
    fingerprint: new Uint8Array(32).fill(5),
    representation: "dual" as const,
    mappingState: "verified" as const,
  };
  const transaction = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => table === taskDefinitionCryptoRevisions ? [ledger]
            : table === tasks ? [mapped] : [],
        }),
      }),
    }),
  } as unknown as Parameters<typeof assertMappedTaskContentBackfill>[0];
  expect(await assertMappedTaskContentBackfill(transaction, claim)).toBe(true);

  ledger.historicalRepair = { ...ledger.historicalRepair, version: 1 };
  expect(await assertMappedTaskContentBackfill(transaction, claim)).toBe(false);
});
