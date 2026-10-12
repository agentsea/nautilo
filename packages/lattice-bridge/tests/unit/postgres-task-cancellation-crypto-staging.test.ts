import { expect, test } from "bun:test";
import type { PostgresJsBridgeConnection, PostgresJsBridgeRow } from "@nautilo/db";
import {
  LatticeCrypto, accessRevision, agentId, authorizationRevision, cryptoDeviceId, cryptoDomainId,
  decryptObjectThroughNamespace,
  createDomainForegroundAuthorizationPlan, domainNamespaceRetainedAuthoritySetDigest,
  humanId, mintDomainForegroundAuthorization, namespaceGeneration, namespaceId,
  prepareAgentRuntimeInitialization, prepareDomainNamespaceBundle,
  TaskRuntimeRecipientRegistry,
  type DomainForegroundSecretEntry,
  type TaskRuntimeCancellationResultEvidence,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2, DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2, encodeAgentRuntimeSignerPublicationV1,
  serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import { deriveTaskContentCryptoObjectIdV1 } from "../../src/task/task-content-repository.ts";
import { decodeTaskRunResultPayloadV1 } from "../../src/task/task-payload-v1.ts";

import { verifyCryptoPostgresHandle, type CryptoPostgresConnection, type CryptoPostgresExecutor } from "../../src/server/storage/postgres-lattice-storage.ts";
import type { DatabaseRow, DatabaseScalar } from "../../src/server/storage/postgres-record-codecs.ts";

const NOW = 1_920_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000711";
const RUN = "20000000-0000-4000-8000-000000000711";
const HUMAN = "30000000-0000-4000-8000-000000000711";
const NAMESPACE = "40000000-0000-4000-8000-000000000711";
const DOMAIN = "50000000-0000-4000-8000-000000000711";
const AGENT = "60000000-0000-4000-8000-000000000711";
const DEVICE = "task-native-result-device";
const SERVER = "https://nautilo.example";
const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);
type Adjust = (stage: string, rows: readonly PostgresJsBridgeRow[]) => readonly PostgresJsBridgeRow[];

async function fixture(adjust: Adjust = (_stage, rows) => rows) {
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const domainKey = bytes(0x41);
  const generationKey = bytes(0x42);
  const retained = [{ generation: namespaceGeneration(0), accessRevision: accessRevision(0), headDigest: bytes(0x43), generationKey }];
  const retainedDigest = domainNamespaceRetainedAuthoritySetDigest(crypto, retained);
  const domainRequirement = { domainId: DOMAIN, sourceNamespaceId: NAMESPACE,
    participantDigest: bytes(0x61), participantCount: 1, keyClass: "ai" as const,
    domainKeyGeneration: 4, authorizationRevision: authorizationRevision(9), headDigest: bytes(0x62),
    activeNamespaceBindingSetDigest: bytes(0x63), activeNamespaceBindingCount: 1 };
  const domain: DomainForegroundSecretEntry = { ...domainRequirement, domainKey };
  const current = { serverId: SERVER, cryptoDomainId: cryptoDomainId(DOMAIN), participantDigest: domain.participantDigest,
    participantCount: 1, keyClass: "ai" as const, domainKeyGeneration: 4,
    domainAuthorizationRevision: authorizationRevision(9), domainHeadDigest: domain.headDigest,
    namespaceId: namespaceId(NAMESPACE), namespaceAccessRevision: accessRevision(0),
    namespaceCurrentGeneration: namespaceGeneration(0), bundleRevision: 1, retainedAuthoritySetDigest: retainedDigest };
  const native = prepareDomainNamespaceBundle(crypto, {
    operationId: "native-task-result-binding", previousBindingDigest: null,
    bundle: { ...current, formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2, retainedGenerationCount: 1, retainedGenerations: retained },
    issuerHumanId: humanId(HUMAN), issuerDeviceId: cryptoDeviceId(DEVICE), issuerDeviceSigningGeneration: 1,
    issuerSigningPrivateKey: issuer.privateKey, issuerSigningPublicKey: issuer.publicKey, domainKey, issuedAt: NOW,
  });
  const initialized = await prepareAgentRuntimeInitialization({ crypto, operationId: "native-result-initialization", agentId: agentId(AGENT),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{ objectId: "task-native-agent-config", configRevision: authorizationRevision(1), plaintextDek: bytes(0x21) }],
    domains: [], resolveCurrentDomainCommitterAuthority: () => null,
    manager: { managerHumanId: humanId(HUMAN), managerAuthorizationRevision: authorizationRevision(2), managerDeviceId: cryptoDeviceId(DEVICE) },
    managerSigningPrivateKey: manager.privateKey, resolveCurrentManagerAuthority: () => manager.publicKey });
  const stages: string[] = [];
  const restricted: PostgresJsBridgeConnection = {
    query: async <Row extends PostgresJsBridgeRow>(statement: string) => {
      let stage: string; let rows: readonly PostgresJsBridgeRow[];
      if (statement.includes("SELECT current_user::text")) {
        stage = "role"; rows = [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }];
      } else if (statement.includes('from "namespace_domain_key_heads"') && statement.includes('inner join')) {
        stage = "native-binding"; rows = [{ binding_bytes: native.bytes, binding_digest: native.bindingDigest, signing_public_key: issuer.publicKey }];
      } else if (statement.includes('from "namespace_domain_key_heads"')) {
        stage = "namespace"; rows = [{ namespace_id: NAMESPACE, namespace_access_revision: 0, namespace_current_generation: 0,
          domain_id: DOMAIN, domain_key_generation: 4, domain_authorization_revision: 9, domain_head_digest: domain.headDigest,
          bundle_revision: 1, retained_generation_count: 1, retained_authority_set_digest: retainedDigest, binding_digest: native.bindingDigest }];
      } else if (statement.includes('from "domain_key_heads"')) {
        stage = "domain"; rows = [{ domain_id: DOMAIN, domain_key_generation: "4", authorization_revision: "9",
          head_digest: domain.headDigest, participant_digest: domain.participantDigest, participant_count: "1" }];
      } else throw new Error(`Unexpected native result query: ${statement}`);
      stages.push(stage);
      return adjust(stage, rows) as readonly Row[];
    },
    transaction: async (use) => use(restricted), transactionOnce: async (use) => use(restricted),
  };
  const base = { restricted, crypto, serverScope: SERVER, domains: [domain], signal: new AbortController().signal,
    payload: { formatVersion: 1 as const, resultText: "Native protected result", lastError: null },
    authority: { authorityVersion: 1 as const, kind: "requester_private_namespace" as const, keyClass: "ai" as const,
      requesterHumanId: HUMAN, namespaceId: NAMESPACE, domainId: DOMAIN, expectedAccessRevision: 0, expectedPolicyRevision: 3 },
    createdAt: NOW, agentAuthorizationRevision: 7, runtime: initialized.runtime,
    signerPublication: initialized.signerPublication, resolveHistoricalSignerPublicationManager: () => manager.publicKey,
    assertCurrentTaskAuthority: () => { stages.push("product"); return Promise.resolve(); } };
  const cancellationCoordinate = Object.freeze({
    kind: "run_result" as const,
    taskId: TASK,
    taskRunId: RUN,
    contentRevision: 2 as const,
  });
  const cancellationResult = Object.freeze({
    taskId: TASK,
    taskRunId: RUN,
    contentRevision: 2 as const,
    objectId: deriveTaskContentCryptoObjectIdV1(cancellationCoordinate),
    signerAgentId: AGENT,
    namespace: Object.freeze({
      namespaceId: NAMESPACE,
      domainId: DOMAIN,
      operations: Object.freeze(["encrypt"] as const),
      expectedAccessRevision: 0,
      expectedPolicyRevision: 3,
    }),
  });
  let cancellationNow = NOW;
  const withCancellationEvidence = async <Value>(operation: (
    evidence: TaskRuntimeCancellationResultEvidence,
    signal: AbortSignal,
    domains: readonly DomainForegroundSecretEntry[],
    authorizationBytes: Uint8Array,
  ) => Value | PromiseLike<Value>) => {
    const recipients = new TaskRuntimeRecipientRegistry(crypto, {
      now: () => cancellationNow,
    });
    const attempt = await recipients.createAttempt({
      requestId: `task-run-cancellation-result-authorization:${RUN}`,
      workId: RUN,
      recipientGeneration: 1,
      recipientKeyId: "native-cancel-result-recipient",
      expiresAt: NOW + 60_000,
    });
    if (attempt.status !== "created") throw new Error("cancellation recipient unavailable");
    const plan = createDomainForegroundAuthorizationPlan(crypto, {
      authorizationId: `task-run-cancellation-result-authorization:${RUN}`,
      policyRevision: 3,
      sessionId: "native-cancel-result-episode",
      roomId: "native-cancel-result-room",
      subjectHumanId: humanId(HUMAN),
      committerDeviceId: cryptoDeviceId(DEVICE),
      committerDeviceSigningGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(5),
      recipientKind: "runtime",
      recipientPrincipalId: "nautilo_task_runtime",
      recipientAuthorizationRevision: authorizationRevision(6),
      recipientRuntimeGeneration: 1,
      recipientKeyId: "native-cancel-result-recipient",
      operations: ["encrypt"],
      issuedAt: NOW,
      deadlineAt: NOW + 60_000,
      maximumSecretBytes: 4_096,
      domains: [domainRequirement],
    });
    const authorization = await mintDomainForegroundAuthorization(crypto, {
      plan,
      domains: [domain],
      committerDeviceSigningPrivateKey: issuer.privateKey,
      recipientEncryptionPublicKey: attempt.attempt.recipientPublicKey,
    });
    const authorizationBytes = serializeDomainForegroundAuthorizationV2(
      authorization,
    );
    try {
      return await recipients.withOpenedCancellationResultGrant({
        requestId: `task-run-cancellation-result-authorization:${RUN}`,
        workId: RUN,
        recipientGeneration: 1,
        recipientKeyId: "native-cancel-result-recipient",
        claimId: "native-cancel-result-claim",
        claimExpiresAt: NOW + 60_000,
        authorizationBytes,
        current: {
          authorizationId: plan.authorizationId,
          policyRevision: plan.policyRevision,
          sessionId: plan.sessionId,
          roomId: plan.roomId,
          subjectHumanId: plan.subjectHumanId,
          committerDeviceId: plan.committerDeviceId,
          committerDeviceSigningGeneration:
            plan.committerDeviceSigningGeneration,
          committerDeviceSigningPublicKey: issuer.publicKey,
          committerDeviceActive: true,
          hostAuthorizationRevision: plan.hostAuthorizationRevision,
          recipientKind: plan.recipientKind,
          recipientPrincipalId: plan.recipientPrincipalId,
          recipientAuthorizationRevision:
            plan.recipientAuthorizationRevision,
          recipientRuntimeGeneration: plan.recipientRuntimeGeneration,
          recipientKeyId: plan.recipientKeyId,
          recipientAuthorized: true,
          domains: plan.domains,
        },
        currentNamespaceRequirements: [{
          ordinal: 0,
          namespaceId: NAMESPACE,
          domainId: DOMAIN,
          operations: ["encrypt"],
          expectedAccessRevision: 0,
          expectedPolicyRevision: 3,
        }],
        result: cancellationResult,
        operation: (domains, signal, evidence) => operation(
          evidence,
          signal,
          domains,
          authorizationBytes,
        ),
      });
    } finally {
      authorizationBytes.fill(0);
      recipients.close();
    }
  };
  return {
    crypto,
    cancellationCoordinate,
    cancellationResult,
    generationKey,
    base,
    setCancellationNow: (value: number) => { cancellationNow = value; },
    stages,
    withCancellationEvidence,
  };
}

function cloneRow(row: DatabaseRow): DatabaseRow {
  return Object.freeze(Object.fromEntries(Object.entries(row).map(
    ([key, value]) => [key, value instanceof Uint8Array ? value.slice() : value],
  ))) as DatabaseRow;
}

type DurableState = {
  object: DatabaseRow | null;
  manifests: Map<number, DatabaseRow>;
  envelopes: DatabaseRow[];
  head: DatabaseRow | null;
  receipt: DatabaseRow | null;
};

function cloneState(state: DurableState): DurableState {
  return {
    object: state.object === null ? null : cloneRow(state.object),
    manifests: new Map([...state.manifests].map(
      ([revision, row]) => [revision, cloneRow(row)],
    )),
    envelopes: state.envelopes.map(cloneRow),
    head: state.head === null ? null : cloneRow(state.head),
    receipt: state.receipt === null ? null : cloneRow(state.receipt),
  };
}

class NativeResultCryptoConnection implements CryptoPostgresConnection {
  state: DurableState = {
    object: null,
    manifests: new Map(),
    envelopes: [],
    head: null,
    receipt: null,
  };
  claim: DatabaseRow | null = null;
  failReceipt = false;
  rejectFinalClaim = false;
  claimReads = 0;
  statements: string[] = [];

  constructor(readonly signer: DatabaseRow | null, readonly native: PostgresJsBridgeConnection) {}

  query<Row extends DatabaseRow = DatabaseRow>(
    statement: string,
    _parameters: readonly DatabaseScalar[] = [],
  ): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }] as unknown as Row[]);
    }
    return this.transaction(tx => tx.query<Row>(statement, _parameters));
  }

  async transaction<Result>(
    callback: (transaction: CryptoPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    const working = cloneState(this.state);
    const transaction: CryptoPostgresExecutor = {
      query: async <Row extends DatabaseRow = DatabaseRow>(
        statement: string,
        parameters: readonly DatabaseScalar[] = [],
      ): Promise<readonly Row[]> => {
        this.statements.push(statement);
        const normalized = statement.replaceAll('"', "").toLowerCase();
        if (normalized.includes("current_user::text")) return [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }] as unknown as Row[];
        if (normalized.includes("pg_advisory_xact_lock")) return [];
        if (normalized.includes("from background_crypto_authorization_requests")) {
          this.claimReads += 1;
          return this.claim === null ? [] : [{ ...this.claim,
            ...(this.rejectFinalClaim && this.claimReads > 1 ? { live: false } : {}) }] as unknown as Row[];
        }
        if (normalized.includes("from task_cancellation_crypto_staging_receipts")) {
          return (working.receipt === null ? [] : [cloneRow(working.receipt)]) as Row[];
        }
        if (normalized.includes("insert into task_cancellation_crypto_staging_receipts")) {
          if (this.failReceipt) throw new Error("receipt write failed");
          const fields = ["request_id", "recipient_generation", "claim_id", "authorization_digest",
            "stopped_intent_hash", "policy_revision", "authority_fingerprint", "crypto_object_id", "genesis_manifest_hash"];
          working.receipt = Object.fromEntries(fields.map((field, i) => [field, parameters[i]!])) as DatabaseRow;
          return [];
        }
        if (normalized.includes("from crypto_objects")) {
          return (working.object === null ? [] : [cloneRow(working.object)]) as Row[];
        }
        if (normalized.includes("from object_crypto_access_heads")) {
          if (working.head === null) return [];
          const revision = working.head["access_revision"] as number;
          const manifest = working.manifests.get(revision);
          if (manifest === undefined) return [];
          return [{ ...cloneRow(working.head), ...cloneRow(manifest) }] as Row[];
        }
        if (
          normalized.includes("from object_crypto_access_manifests")
          && normalized.includes("access_revision >=")
        ) {
          const minimum = parameters[1] as number;
          const maximum = parameters[2] as number;
          return [...working.manifests]
            .filter(([revision]) => revision >= minimum && revision <= maximum)
            .sort(([left], [right]) => left - right)
            .map(([, row]) => cloneRow(row)) as Row[];
        }
        if (normalized.includes("from object_crypto_access_manifests")) {
          const revision = parameters[1] as number;
          const manifest = working.manifests.get(revision);
          return (manifest === undefined ? [] : [cloneRow(manifest)]) as Row[];
        }
        if (normalized.includes("from object_crypto_namespace_envelopes")) {
          const revision = parameters[1] as number;
          return working.envelopes.filter(
            (row) => row["access_revision"] === revision,
          ).map(cloneRow) as Row[];
        }
        if (normalized.includes("from agent_crypto_runtime_signers")) {
          return (this.signer === null ? [] : [cloneRow(this.signer)]) as Row[];
        }
        if (normalized.includes("insert into crypto_objects")) {
          working.object = {
            object_id: parameters[0] as string,
            payload_hash: (parameters[1] as Uint8Array).slice(),
            payload_bytes: (parameters[2] as Uint8Array).slice(),
          };
          return [];
        }
        if (normalized.includes("insert into object_crypto_access_manifests")) {
          const revision = parameters[1] as number;
          working.manifests.set(revision, {
            object_id: parameters[0] as string,
            access_revision: revision,
            manifest_hash: (parameters[2] as Uint8Array).slice(),
            previous_manifest_hash: parameters[3] === null
              ? null
              : (parameters[3] as Uint8Array).slice(),
            payload_hash: (parameters[4] as Uint8Array).slice(),
            manifest_bytes: (parameters[5] as Uint8Array).slice(),
          });
          return [];
        }
        if (normalized.includes("insert into object_crypto_namespace_envelopes")) {
          working.envelopes.push({
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            namespace_id: parameters[2] as string,
            ordinal: parameters[3] as number,
            envelope_hash: (parameters[4] as Uint8Array).slice(),
            envelope_bytes: (parameters[5] as Uint8Array).slice(),
          });
          return [];
        }
        if (normalized.includes("insert into object_crypto_access_heads")) {
          working.head = {
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            manifest_hash: (parameters[2] as Uint8Array).slice(),
          };
          return [];
        }
        return this.native.query<Row>(statement, parameters);
      },
    };
    const result = await callback(transaction);
    this.state = working;
    return result;
  }
}



import type { ProtectedTaskCancellationOutputIntent } from "@nautilo/db";
import {
  stageNativeTaskCancellationPublication, inspectStagedTaskCancellationPublication,
  reserveStagedTaskCancellationPublication, hasTaskCancellationCryptoPublication,
  type StageNativeTaskCancellationPublicationInput,
} from "../../src/server/task/postgres-task-cancellation-crypto-staging.ts";

const OWNER = "70000000-0000-4000-8000-000000000711";
async function stagingFixture() {
  const value = await fixture();
  const publication = value.base.signerPublication;
  const connection = new NativeResultCryptoConnection({
    agent_id: publication.agentId, runtime_generation: publication.runtimeGeneration,
    authorization_revision: publication.authorizationRevision, transition_kind: publication.transitionKind,
    operation_id: publication.operationId, signer_key_id: publication.signerKeyId,
    signer_public_key: publication.signerPublicKey,
    publication_bytes: encodeAgentRuntimeSignerPublicationV1(publication),
  }, value.base.restricted);
  const intent: ProtectedTaskCancellationOutputIntent = {
    taskId: TASK, taskRunId: RUN, requesterUserId: OWNER, agentId: AGENT,
    contentNamespaceId: NAMESPACE, representation: "protected", resultRevision: 2,
    resultOperationId: `task-run-cancelled-result:${RUN}`, resultObjectId: value.cancellationResult.objectId,
    policyRevision: 3, taskStatus: "cancelled", runStatus: "cancelled", terminalAt: new Date(NOW - 1),
  };
  const history = {
    resolveHistoricalHumanDeviceSigningPublicKey: () => Promise.resolve(null),
    resolveHistoricalAgentSignerAuthority: ((context) => ({ ...context,
      managerSigningPublicKey: value.base.resolveHistoricalSignerPublicationManager().slice() })) satisfies StageNativeTaskCancellationPublicationInput["resolveHistoricalAgentSignerAuthority"],
  };
  const handle = await verifyCryptoPostgresHandle(connection);
  const inspect = () => inspectStagedTaskCancellationPublication({
    ...history, handle, intent, crypto: value.crypto, authority: value.base.authority,
  });
  async function run(use: (stage: () => Promise<"staged" | "already_staged">) => Promise<void>) {
    const result = await value.withCancellationEvidence(async (evidence, signal, domains, authorizationBytes) => {
      const identity = JSON.stringify(["nautilo/task-cancellation-result/v1", TASK, RUN,
        OWNER, AGENT, NAMESPACE, intent.resultOperationId, intent.resultObjectId, intent.terminalAt.getTime()]);
      connection.claim = {
        request_id: evidence.requestId, work_id: RUN, work_kind: "task.cancel_result", purpose: "task.cancel_result",
        state: "running", format_version: 3, credential_subject_kind: "runtime", runtime_kind: "task", runtime_version: 1,
        claim_id: evidence.claimId, recipient_generation: evidence.recipientGeneration, recipient_key_id: evidence.recipientKeyId,
        accepted_response_kind: "runtime", accepted_response_hash: evidence.authorizationDigest.slice(),
        accepted_response_bytes: authorizationBytes.slice(), issuing_human_id: HUMAN,
        expected_policy_revision: 3, namespace_id: NAMESPACE, domain_id: DOMAIN, expected_namespace_access_revision: 0, expected_domain_epoch: 4,
        idempotency_key: `task-cancellation:${Buffer.from(value.crypto.hash(new TextEncoder().encode(identity))).toString("hex")}`,
        live: true,
      };
      return use(() => connection.transaction(async tx => {
        const executor = tx as unknown as Pick<PostgresJsBridgeConnection, "query">;
        const borrowed: PostgresJsBridgeConnection = { query: executor.query.bind(executor),
          transaction: callback => callback(executor), transactionOnce: callback => callback(executor) };
        return stageNativeTaskCancellationPublication({ ...history, intent,
          preparation: { ...value.base, evidence, signal, domains, restricted: borrowed },
          assertCurrentClaim: () => Promise.resolve(),
        });
      }));
    });
    expect(result.status).toBe("opened");
  }
  return { value, connection, intent, handle, history, inspect, run };
}
async function fails(operation: Promise<unknown>): Promise<void> {
  expect(await operation.then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
}

test("stages only fixed ciphertext atomically and reserves verified restart metadata", async () => {
  const f = await stagingFixture();
  await f.run(async stage => { expect(await stage()).toBe("staged"); });
  const object = f.connection.state.object!;
  const envelope = f.connection.state.envelopes[0]!;
  const plaintext = decryptObjectThroughNamespace(f.value.crypto, f.value.generationKey,
    decodeNamespaceObjectEnvelopeV2(envelope["envelope_bytes"] as Uint8Array),
    decodeEncryptedPayloadV2(object["payload_bytes"] as Uint8Array));
  expect(decodeTaskRunResultPayloadV1(plaintext!)).toEqual({ formatVersion: 1, resultText: "Task cancelled", lastError: null });
  plaintext!.fill(0);
  // Recovery no longer has a grant, evidence, or even the authorization row.
  f.connection.claim = null;
  const staged = await f.inspect();
  expect(staged?.intent).toEqual(f.intent);
  let reserved = false;
  expect(await reserveStagedTaskCancellationPublication({ staged: staged!, authority: f.value.base.authority,
    product: { reserveRevision: input => {
      reserved = true;
      expect(input).toMatchObject({ operationId: f.intent.resultOperationId,
        coordinate: f.value.cancellationCoordinate, cryptoObjectId: f.intent.resultObjectId,
        representation: "protected", operationalMetadata: null, payloadVersion: 1 });
      expect(input.requestDigest).toEqual(staged!.genesisManifestHash);
      return Promise.resolve({ status: "stale" });
    } },
  })).toEqual({ status: "stale" });
  expect(reserved).toBe(true);
  expect(f.connection.statements.some(statement => statement.includes("clock_timestamp()"))).toBe(true);
});

test("exact receipt replay does not prepare randomized ciphertext again", async () => {
  const f = await stagingFixture();
  await f.run(async stage => {
    expect(await stage()).toBe("staged");
    const payload = (f.connection.state.object!["payload_bytes"] as Uint8Array).slice();
    const bindings = f.value.stages.filter(stage => stage === "native-binding").length;
    expect(await stage()).toBe("already_staged");
    expect(f.value.stages.filter(stage => stage === "native-binding")).toHaveLength(bindings);
    expect(f.connection.state.object!["payload_bytes"]).toEqual(payload);
  });
});

test.each(["receipt_failure", "claim_expired_before_commit"])("rolls back ciphertext and receipt after %s", async reason => {
  const f = await stagingFixture();
  f.connection.failReceipt = reason === "receipt_failure";
  f.connection.rejectFinalClaim = reason === "claim_expired_before_commit";
  await f.run(async stage => { await fails(stage()); });
  expect(f.connection.state.object).toBeNull();
  expect(f.connection.state.receipt).toBeNull();
  expect(f.connection.statements.some(statement => statement.includes('insert into "crypto_objects"'))).toBe(true);
  expect(f.connection.statements.some(statement => statement.includes('insert into "task_cancellation_crypto_staging_receipts"'))).toBe(true);
});

test.each(["claim_id", "purpose", "work_id", "recipient_generation", "expected_policy_revision", "accepted_response_hash", "live"])(
  "rejects changed %s before crypto writes", async key => {
    const f = await stagingFixture();
    await f.run(async stage => {
      f.connection.claim = { ...f.connection.claim, [key]: key === "live" ? false
        : key === "accepted_response_hash" ? bytes(0x99)
        : key === "recipient_generation" || key === "expected_policy_revision" ? 99 : "foreign" };
      await fails(stage());
    });
    expect(f.connection.state.object).toBeNull();
    expect(f.connection.state.receipt).toBeNull();
  },
);

test("bare ciphertext fences fresh work and cannot acquire a receipt", async () => {
  const f = await stagingFixture();
  f.connection.state.object = { object_id: f.intent.resultObjectId, payload_hash: bytes(1), payload_bytes: bytes(2) };
  expect(await hasTaskCancellationCryptoPublication(f.handle,
    { requestId: `task-run-cancellation-result-authorization:${RUN}`, objectId: f.intent.resultObjectId })).toBe(true);
  expect(await f.inspect()).toBeNull();
  await f.run(async stage => { await fails(stage()); });
  expect(f.connection.state.receipt).toBeNull();
});

test.each(["intent", "digest", "forged"])("reservation rejects %s token mutation", async mutation => {
  const f = await stagingFixture();
  await f.run(async stage => { await stage(); });
  let token = (await f.inspect())!;
  if (mutation === "intent") token.intent.terminalAt.setTime(NOW);
  if (mutation === "digest") token.genesisManifestHash[0] = token.genesisManifestHash[0]! ^ 1;
  if (mutation === "forged") token = { ...token };
  let calls = 0;
  await fails(reserveStagedTaskCancellationPublication({ staged: token, authority: f.value.base.authority,
    product: { reserveRevision: () => { calls += 1; return Promise.resolve({ status: "stale" }); } } }));
  expect(calls).toBe(0);
});

test.each(["request_id", "genesis_manifest_hash", "stopped_intent_hash"])("inspection rejects substituted %s", async key => {
  const f = await stagingFixture();
  await f.run(async stage => { await stage(); });
  f.connection.state.receipt = { ...f.connection.state.receipt,
    [key]: key === "request_id" ? "another-request" : bytes(0x88) };
  await fails(f.inspect());
});

test("inspection requires the intended Agent even when substituted intent hash matches", async () => {
  const f = await stagingFixture();
  await f.run(async stage => { await stage(); });
  const intent = { ...f.intent, agentId: "60000000-0000-4000-8000-000000000712" };
  f.connection.state.receipt = { ...f.connection.state.receipt,
    stopped_intent_hash: f.value.crypto.hash(new TextEncoder().encode(JSON.stringify([
      "nautilo/task-cancellation-crypto-staging-intent/v1", intent.taskId, intent.taskRunId,
      intent.requesterUserId, intent.agentId, intent.contentNamespaceId, intent.representation,
      intent.resultRevision, intent.resultOperationId, intent.resultObjectId, intent.policyRevision,
      intent.taskStatus, intent.runStatus, intent.terminalAt.getTime(),
    ]))) };
  await fails(inspectStagedTaskCancellationPublication({ ...f.history, handle: f.handle,
    crypto: f.value.crypto, intent, authority: f.value.base.authority }));
});

test("an existing receipt for another claim never authorizes another preparation", async () => {
  const f = await stagingFixture();
  await f.run(async stage => {
    await stage();
    f.connection.state.receipt = { ...f.connection.state.receipt, claim_id: "foreign-claim" };
    const bindings = f.value.stages.filter(stage => stage === "native-binding").length;
    await fails(stage());
    expect(f.value.stages.filter(stage => stage === "native-binding")).toHaveLength(bindings);
  });
});
