import { describe, expect, test } from "bun:test";
import {
  protectedTaskRunResultObjectId, protectedTaskRunOutputBindingId,
  protectedTaskRunMessageOperationId, protectedTaskRunWakeOperationId, protectedTaskRunWakeJobId,
  type PostgresJsBridgeConnection, type ProtectedTaskWakeContinuationReceipt,
  protectedTaskSemanticAuthorityRequirementsDigest,
} from "@nautilo/db";
import {
  LatticeCrypto, authorizationRevision, createDomainForegroundAuthorizationPlan, cryptoDeviceId, humanId,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  createTaskRuntimeBackgroundAuthorizationRequestV3,
  destroyTaskRuntimeBackgroundAuthorizationRequestV3,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV3,
} from "@nautilo/lattice-crypto/background";
import { agentRuntimeObjectSignerKeyIdV1 } from "@nautilo/lattice-crypto/wire";
import type {
  AcceptedTaskRuntimeAuthorizationV3, CurrentTaskRuntimeAuthority, TaskOutputNamespaceAuthority,
  TaskOutputNamespaceAuthorityInput, TaskOutputProductAuthority, TaskOutputRecipientAuthority,
} from "@nautilo/lattice-bridge/server";
import { protectedTaskProjectionDestinationAuthorityDigest } from "../../src/routes/protected-task-memory-projection-plan";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import {
  createProtectedTaskOutputReadAuthorityPort,
  type ProtectedTaskOutputReadAuthorityDependencies,
} from "../../src/routes/protected-task-output-read-authority";
import type { ProtectedTaskOutputReadIntent } from "../../src/routes/protected-task-output-read-product";

const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "10000000-0000-4000-8000-000000000002";
const USER = "10000000-0000-4000-8000-000000000003";
const HUMAN = "10000000-0000-4000-8000-000000000004";
const AGENT = "10000000-0000-4000-8000-000000000005";
const PRIVATE_ROOM = "20000000-0000-4000-8000-000000000001";
const ROOM = "20000000-0000-4000-8000-000000000002";
const SESSION = "20000000-0000-4000-8000-000000000003";
const PRIVATE = "30000000-0000-4000-8000-000000000001";
const DESTINATION = "30000000-0000-4000-8000-000000000002";
const EXTRA = "30000000-0000-4000-8000-000000000003";
const DOMAIN = "40000000-0000-4000-8000-000000000001";
const DEVICE = "device-output-read";
const NOW = 2_000_000_000_000;
const subject = { userId: USER, humanActorId: HUMAN, deviceId: DEVICE };
const bytes = () => new Uint8Array(32).fill(7);
function intent(wake = false): ProtectedTaskOutputReadIntent {
  return {
    requesterUserId: USER, requesterHumanId: HUMAN, agentId: AGENT, contentNamespaceId: PRIVATE,
    representation: "protected", expectedPolicyRevision: 8, acceptedPolicyRevision: 7,
    initialState: wake ? "wake_queued" : "raw_unpublished",
    result: { taskId: TASK, taskRunId: RUN, terminalStatus: "completed", contentRevision: 1,
      objectId: protectedTaskRunResultObjectId(TASK, RUN), cryptoAccessRevision: 0,
      genesisManifestHash: bytes(), signerAgentId: AGENT },
    invocation: wake ? { kind: "wake", bindingId: protectedTaskRunOutputBindingId(RUN),
      operationId: protectedTaskRunWakeOperationId(RUN), roomId: ROOM, sessionId: SESSION,
      jobId: protectedTaskRunWakeJobId(RUN), reference: { kind: "protected_task_delivery_v1", taskId: TASK,
        taskRunId: RUN, bindingId: protectedTaskRunOutputBindingId(RUN), resultObjectId: protectedTaskRunResultObjectId(TASK, RUN),
        wakeOperationId: protectedTaskRunWakeOperationId(RUN) } }
      : { kind: "raw", bindingId: protectedTaskRunOutputBindingId(RUN), operationId: protectedTaskRunMessageOperationId(RUN),
        roomId: ROOM, sessionId: SESSION },
  };
}
const extraDestination = { roomId: "20000000-0000-4000-8000-000000000004", namespaceId: EXTRA,
  label: "Other Room", kind: "group" as const, memberCount: 2, audienceFingerprint: "ab".repeat(32) };
function continuation(): ProtectedTaskWakeContinuationReceipt {
  const semanticAuthorityRequirements = [{ namespaceId: DESTINATION, operations: ["decrypt"] as const },
    { namespaceId: EXTRA, operations: ["encrypt"] as const }];
  return { wakeJobId: protectedTaskRunWakeJobId(RUN), segment: 1, priorRecipientGeneration: 0,
    taskId: TASK, taskRunId: RUN, bindingId: protectedTaskRunOutputBindingId(RUN),
    wakeOperationId: protectedTaskRunWakeOperationId(RUN),
    wakeAuthorizationRequestId: `task-wake-authorization:${protectedTaskRunWakeJobId(RUN)}`,
    additionalAuthorizationRequestId: "memory-projection:additional", interruptId: "interrupt:projection",
    operationId: "memory-projection:operation", requestDigest: bytes(), semanticAuthorityRequirements,
    requiredAuthorityDigest: protectedTaskSemanticAuthorityRequirementsDigest(semanticAuthorityRequirements),
    retainedSourceNamespaceIds: [DESTINATION], sourceEnvelopeDigest: bytes(),
    initialPolicyRevision: 7, initialAgentAuthorizationRevision: 4,
    destinationRoomId: extraDestination.roomId, destinationNamespaceId: EXTRA,
    destinationAuthorityDigest: protectedTaskProjectionDestinationAuthorityDigest(extraDestination),
    checkpointThreadId: "wake:thread", checkpointContract: "encrypted_langgraph_v1", expectedCheckpointCount: 1,
    checkpointOrderedDigest: bytes(), expectedBlobCount: 0, blobOrderedDigest: bytes(),
    expectedPendingWriteCount: 0, pendingWriteOrderedDigest: bytes(), sealedAt: new Date(NOW - 1000) };
}
function fixture(wake = false, foreground = [DESTINATION], additional = false,
  carrier: "legacy" | "v3" | "corrupt_v3" = "legacy") {
  const selected = { ...intent(wake), ...(additional ? { continuation: continuation() } : {}) };
  const crypto = new LatticeCrypto();
  const events: string[] = [];
  const state = { held: false, validProduct: true, validForeground: true, currentForeground: [...foreground],
    failCommit: false, rejectCrypto: false, resets: 0, proofEntries: 0, destinationChanged: false, capabilityLost: false };
  const transaction = {} as CanonicalTranscriptTx;
  const product: PostgresJsBridgeConnection = {
    query: async () => { expect(state.held).toBe(true); events.push("product-read"); return []; },
    transaction: async use => { expect(state.held).toBe(true); return use(product); },
    transactionOnce: async use => { expect(state.held).toBe(true); return use(product); },
  };
  const restricted: PostgresJsBridgeConnection = {
    query: async () => { expect(state.held).toBe(true); events.push("crypto-use"); return []; },
    transaction: async use => use(restricted), transactionOnce: async use => use(restricted),
  };
  const namespaceIds = [...new Set([PRIVATE, ...foreground, ...(additional ? [EXTRA] : [])])].sort();
  const namespaces = namespaceIds.map((namespaceId, ordinal) => ({ ordinal, namespaceId, domainId: DOMAIN,
    operations: [
      ...(namespaceId === PRIVATE || wake && foreground.includes(namespaceId) ? ["decrypt" as const] : []),
      ...(foreground.includes(namespaceId) || additional && namespaceId === EXTRA ? ["encrypt" as const] : []),
    ], expectedAccessRevision: 4 + ordinal, expectedPolicyRevision: 8 }));
  const domains = [{ ordinal: 0, domainId: DOMAIN, expectedEpoch: 3, expectedAuthorizationRevision: 5 }];
  const domain = { domainId: DOMAIN, sourceNamespaceId: PRIVATE, participantDigest: bytes(), participantCount: 1,
    keyClass: "ai" as const, domainKeyGeneration: 3, authorizationRevision: authorizationRevision(5),
    headDigest: bytes(), activeNamespaceBindingSetDigest: bytes(), activeNamespaceBindingCount: namespaceIds.length };
  const device = { ...subject, deviceGeneration: 1, signingPublicKey: bytes(), serverInstanceId: "server",
    lineageGeneration: 1, epoch: 1, securityRevision: 4, headDigest: bytes() };
  const workId = wake ? protectedTaskRunWakeJobId(RUN) : RUN;
  const requestId = wake ? `task-wake-authorization:${workId}` : `task-run-delivery-result-authorization:${RUN}`;
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: requestId, policyRevision: 8, sessionId: SESSION, roomId: ROOM,
    subjectHumanId: humanId(HUMAN), committerDeviceId: cryptoDeviceId(DEVICE), committerDeviceSigningGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(4), recipientKind: "runtime", recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0), recipientRuntimeGeneration: 1,
    recipientKeyId: "recipient-output", operations: ["decrypt", "encrypt"], issuedAt: NOW, deadlineAt: NOW + 60_000,
    maximumSecretBytes: 4096, domains: [domain],
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({ requestId, workId,
    workKind: wake ? "task.delivery_wake" : "task.deliver_result", workPurpose: wake ? "task.delivery_wake" : "task.deliver_result",
    recipientGeneration: 1, episodeId: SESSION, sourceRoomId: ROOM, recipientKeyId: plan.recipientKeyId,
    recipientPublicKey: new Uint8Array(65).fill(2), authorizationPlan: plan, issuedAt: NOW, deadlineAt: plan.deadlineAt });
  let descriptorBytes: Uint8Array;
  if (carrier === "legacy") {
    descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(request);
  } else {
    const signerPublicKey = new Uint8Array(32).fill(9);
    const certified = createTaskRuntimeBackgroundAuthorizationRequestV3(crypto, {
      baseRequest: request,
      work: wake ? {
        kind: "task.delivery_wake", taskId: TASK, taskRunId: RUN,
        contentRevision: 1, jobId: workId, workIdentityHash: bytes(),
      } : {
        kind: "task.deliver_result", taskId: TASK, taskRunId: RUN,
        contentRevision: 1, workIdentityHash: bytes(),
      },
      signer: { agentId: AGENT, runtimeGeneration: 0,
        signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, signerPublicKey),
        signerPublicKey },
      deviceGroupHead: { serverInstanceId: device.serverInstanceId,
        lineageGeneration: device.lineageGeneration, epoch: device.epoch,
        headDigest: device.headDigest,
        signingPublicKeyHash: crypto.hash(device.signingPublicKey) },
      namespaceRequirements: namespaces,
    });
    descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV3(
      crypto,
      certified,
    );
    destroyTaskRuntimeBackgroundAuthorizationRequestV3(certified);
    if (carrier === "corrupt_v3") {
      descriptorBytes[descriptorBytes.length - 1]! ^= 1;
    }
  }
  const accepted: AcceptedTaskRuntimeAuthorizationV3 = {
    descriptorBytes, descriptorDigest: "descriptor",
    requestId, workId, workKind: request.workKind, workPurpose: request.workPurpose,
    recipientGeneration: 1, recipientKeyId: request.recipientKeyId,
    recipientPublicKeyBase64url: Buffer.from(request.recipientPublicKey).toString("base64url"),
    expectedPolicyRevision: 8, namespaceRequirements: namespaces, domainRequirements: domains,
    authorizationId: requestId, authorizationBytes: bytes(), authorizationDigest: "authorization",
    authorizationExpiresAt: plan.deadlineAt, issuingHumanId: HUMAN, issuingDeviceId: DEVICE,
    issuingDeviceAuthorizationRevision: 4, issuerSigningPublicKeyHash: bytes(),
  };
  const authority: CurrentTaskRuntimeAuthority = { device, plan, domains: [domain], namespaceRequirements: namespaces, policyRevision: 8 };
  const planning: TaskOutputNamespaceAuthority = { sourceRoomId: ROOM, sourceNamespaceId: PRIVATE,
    facts: namespaces.map(n => ({ namespaceId: n.namespaceId, domainId: n.domainId, expectedAccessRevision: n.expectedAccessRevision,
      expectedPolicyRevision: 8, expectedDomainEpoch: 3, expectedAuthorizationRevision: 5 })),
    resultFact: { namespaceId: PRIVATE, domainId: DOMAIN, expectedAccessRevision: 4, expectedPolicyRevision: 8,
      expectedDomainEpoch: 3, expectedAuthorizationRevision: 5 },
    foregroundFacts: [],
  };
  const planningWithForeground = { ...planning, foregroundFacts: planning.facts.filter(f => foreground.includes(f.namespaceId)),
    ...(additional ? { additionalMutationFact: { destination: { roomId: extraDestination.roomId, namespaceId: EXTRA,
      semanticDigest: Buffer.from(selected.continuation!.requiredAuthorityDigest).toString("hex") },
      namespace: planning.facts.find(f => f.namespaceId === EXTRA)! } } : {}) };
  let activeProof: TaskOutputProductAuthority | null = null;
  async function held<Value>(input: TaskOutputNamespaceAuthorityInput, use: () => Promise<Value>): Promise<Value | null> {
    expect(state.held).toBe(false); state.held = true; events.push("product-held");
    const coordinates = { destinationRoomId: ROOM, destinationNamespaceId: DESTINATION, foregroundNamespaceIds: input.foregroundNamespaceIds };
    try {
      expect(input.sourceRoomId).toBe(PRIVATE_ROOM);
      expect(input.contentNamespaceId).toBe(PRIVATE);
      expect(input.destinationRoomId).toBe(ROOM);
      expect(input.destinationNamespaceId).toBe(DESTINATION);
      expect(input.episodeId).toBe(SESSION);
      expect(input.workId).toBe(workId); expect(input.requestId).toBe(requestId);
      if (!await input.validateCurrentTaskRun(product, transaction, {} as never)) return null;
      events.push("destination-locked");
      if (!await input.validateCurrentForeground(product, transaction, coordinates)) return null;
      if (input.additionalMutationDestination !== undefined
        && !await input.validateCurrentAdditionalMutationDestination!(product, transaction, input.additionalMutationDestination)) return null;
      const value = await use();
      if (!await input.validateCurrentTaskRun(product, transaction, {} as never)
        || !await input.validateCurrentForeground(product, transaction, coordinates)
        || input.additionalMutationDestination !== undefined
          && !await input.validateCurrentAdditionalMutationDestination!(product, transaction, input.additionalMutationDestination)) throw new Error("current proof changed");
      if (state.failCommit) throw new Error("product commit failed");
      return value;
    } finally { state.held = false; events.push("product-released"); }
  }
  const dependencies: Partial<ProtectedTaskOutputReadAuthorityDependencies> = {
    db: {} as never, crypto, serverScope: "https://example.test", restricted: () => restricted,
    resolveRequesterHuman: async () => ({ id: HUMAN }),
    resolveRequesterPrivateRoom: async (user, agent, namespace) => {
      expect([user, agent, namespace]).toEqual([USER, AGENT, PRIVATE]); return { roomId: PRIVATE_ROOM, namespaceId: PRIVATE };
    },
    resolveDestinationNamespace: async room => { expect(room).toBe(ROOM); return DESTINATION; },
    createProductContext: async () => ({ canonicalRunner: {} as never, handle: {} as never }),
    createProofLoader: observedIntent => {
      expect(observedIntent).not.toBe(selected); state.proofEntries++;
      let ready = false; let productChecked = false;
      return {
        validateCurrentTaskRun: async (p, tx) => {
          expect(p).toBe(product); expect(tx).toBe(transaction); expect(state.held).toBe(true);
          events.push("closed-product"); ready = false; productChecked = state.validProduct; return productChecked;
        },
        validateCurrentForeground: async (p, tx) => {
          expect(p).toBe(product); expect(tx).toBe(transaction); expect(state.held).toBe(true);
          expect(productChecked).toBe(true); events.push("closed-invocation"); ready = state.validForeground; return ready;
        },
        readCurrent: () => { expect(state.held).toBe(true); return ready ? structuredClone(observedIntent) : null; },
        reset: () => { state.resets++; ready = false; events.push("loader-reset"); },
      };
    },
    canonicalWakeForegroundAdmission: {
      discover: async ({ intent: i, subject: s }) => { expect(i.invocation.kind).toBe("wake"); expect(s.userId).toBe(USER); expect(s.humanActorId).toBe(HUMAN);
        expect(state.held).toBe(false); events.push("foreground-discovery"); return { namespaceIds: [...foreground] }; },
      readCurrent: async ({ product: p, transaction: tx, expectedNamespaceIds }) => {
        expect(p).toBe(product); expect(tx).toBe(transaction); expect(state.held).toBe(true);
        expect(expectedNamespaceIds).toEqual(foreground);
        await p.query("SELECT foreground_test_probe"); events.push("foreground-current");
        return { namespaceIds: [...state.currentForeground] };
      },
    },
    inspectAuthority: input => held(input, async () => planningWithForeground),
    withNamespaceAuthority: input => held(input, async () => {
      events.push("namespace-domain-planning");
      return input.use(planningWithForeground, product, transaction, restricted);
    }),
    withRecipientAuthority: input => held(input, async () => {
      if (state.rejectCrypto) return null;
      expect(input.namespaceRequirements).toEqual(namespaces); expect(input.domainRequirements).toEqual(domains);
      events.push("device-namespace-domain");
      const recipientAuthority: TaskOutputRecipientAuthority = { ...authority,
        sourceRoomId: ROOM, sourceNamespaceId: PRIVATE,
        resultNamespaceRequirement: { ...namespaces[0]!, operations: ["decrypt"] },
        foregroundNamespaceRequirements: namespaces.filter(n => foreground.includes(n.namespaceId)),
      };
      const result = await input.use(recipientAuthority, restricted, product, transaction);
      await input.validateBeforeCommit?.(); return result;
    }),
    withProductAuthority: input => held(input, async () => {
      activeProof = Object.freeze({}) as TaskOutputProductAuthority;
      try { return await input.use(activeProof, product, transaction, restricted); }
      finally { activeProof = null; }
    }),
    withBoundAuthority: async input => {
      expect(state.held).toBe(true); expect(input.productAuthority).toBe(activeProof!);
      expect(input.request).toEqual(request); expect(input.namespaceRequirements).toEqual(namespaces);
      expect(input.domainRequirements).toEqual(domains);
      events.push("bound-crypto"); if (state.rejectCrypto) return null;
      return input.use(authority, product, restricted);
    },
    withAcceptedAuthority: async input => {
      expect(state.held).toBe(true); expect(input.productAuthority).toBe(activeProof!);
      expect(input.accepted).not.toBe(accepted); expect(input.accepted.descriptorBytes).toEqual(accepted.descriptorBytes);
      expect(await input.validateCurrentProduct(product, transaction)).toBe(true);
      events.push("accepted-crypto"); if (state.rejectCrypto) return null;
      const value = await input.use(authority, product, restricted, transaction);
      await input.validateBeforeCommit(); return value;
    },
    readProjectionDestination: async (tx, roomId) => {
      expect(state.held).toBe(true); expect(tx).toBe(transaction); expect(roomId).toBe(extraDestination.roomId);
      events.push("destination-current");
      return { ...extraDestination, ...(state.destinationChanged ? { memberCount: 3 } : {}) };
    },
    lockProjectionDestination: async (tx, target, options) => {
      expect(state.held).toBe(true); expect(tx).toBe(transaction);
      expect(target.roomId).toBe(extraDestination.roomId); expect(target.requesterActorId).toBe(HUMAN);
      expect(options).toEqual({ actorIdentityLock: "share" }); events.push("destination-capability");
      return state.capabilityLost ? "capability_lost" : null;
    },
    now: () => NOW,
  };
  return { selected, request, accepted, namespaces, domains, authority, dependencies, state, events, product, restricted, transaction,
    admission: { ...device, expiresAt: plan.deadlineAt },
    port: () => createProtectedTaskOutputReadAuthorityPort(dependencies) };
}

describe("protected Task output read authority server port", () => {
  for (const wake of [false, true]) {
    test(`discovers ${wake ? "wake" : "raw"} current facts under both closed proof phases`, async () => {
      const f = fixture(wake);
      const result = await f.port().withDiscovery({ intent: f.selected, subject,
        use: async (current, product, tx) => {
          expect(f.state.held).toBe(true); expect(product).toBe(f.product); expect(tx).toBe(f.transaction);
          expect(current.restricted).toBe(f.restricted);
          expect(current.namespaceAuthority.sourceRoomId).toBe(ROOM);
          expect(current.namespaceAuthority.foregroundFacts.map(n => n.namespaceId)).toEqual([DESTINATION]);
          expect(current.occurrence.result).toEqual({ ...f.selected.result, namespace: { namespaceId: PRIVATE, domainId: DOMAIN,
            operations: ["decrypt"], expectedAccessRevision: 4, expectedPolicyRevision: 8 } });
          expect(current.occurrence.invocation).toEqual(f.selected.invocation);
          expect(current.resultNamespaceRequirement.operations).toEqual(["decrypt"]);
          expect(current.foregroundNamespaceRequirements[0]?.operations).toEqual(wake ? ["decrypt", "encrypt"] : ["encrypt"]);
          await current.restricted.query("SELECT metadata_test_probe"); return "discovered";
        },
      });
      expect(result).toBe("discovered"); expect(f.state.proofEntries).toBe(2); expect(f.state.resets).toBe(2);
      expect(f.events.filter(e => e === "foreground-current")).toHaveLength(wake ? 4 : 0);
      expect(f.events.indexOf("closed-invocation")).toBeLessThan(f.events.indexOf("device-namespace-domain"));
    });
  }
  for (const wake of [false, true]) {
    test(`plans ${wake ? "wake" : "raw"} without a Device inside one current combined authority scope`, async () => {
      const f = fixture(wake);
      const human = { userId: USER, humanActorId: HUMAN };
      const value = await f.port().withPlanning({ intent: f.selected, subject: human,
        use: async (current, product, transaction, restricted) => {
          expect(f.state.held).toBe(true); expect(product).toBe(f.product);
          expect(transaction).toBe(f.transaction); expect(restricted).toBe(f.restricted);
          expect(current.namespaceAuthority.sourceRoomId).toBe(ROOM);
          expect(current.namespaceAuthority.resultFact.namespaceId).toBe(PRIVATE);
          expect(current.namespaceAuthority.foregroundFacts.map(f => f.namespaceId)).toEqual([DESTINATION]);
          expect(current.occurrence.result.namespace.operations).toEqual(["decrypt"]);
          expect(current.occurrence.invocation).toEqual(f.selected.invocation);
          expect("device" in current).toBe(false);
          await product.query("SELECT planning_test_probe"); return "planned";
        },
      });
      expect(value).toBe("planned"); expect(f.state.proofEntries).toBe(1); expect(f.state.resets).toBe(1);
      expect(f.events.filter(e => e === "product-held")).toHaveLength(1);
      expect(f.events.filter(e => e === "foreground-current")).toHaveLength(wake ? 2 : 0);
      expect(f.events).not.toContain("device-namespace-domain");
      expect(f.events).not.toContain("bound-crypto"); expect(f.events).not.toContain("accepted-crypto");
    });
  }
  test("device-free planning denies missing wake admission and current authority loss", async () => {
    const human = { userId: USER, humanActorId: HUMAN };
    const wake = fixture(true);
    const { canonicalWakeForegroundAdmission: _admission, ...withoutWake } = wake.dependencies;
    expect(await createProtectedTaskOutputReadAuthorityPort(withoutWake).withPlanning({ intent: wake.selected,
      subject: human, use: () => "forbidden" })).toBeNull();
    expect(wake.events).toEqual([]);
    const denied = fixture(); denied.state.validForeground = false;
    expect(await denied.port().withPlanning({ intent: denied.selected, subject: human, use: () => "forbidden" })).toBeNull();
    expect(denied.events).not.toContain("namespace-domain-planning");
    const lost = fixture(true);
    const error = await lost.port().withPlanning({ intent: lost.selected, subject: human,
      use: () => { lost.state.currentForeground = [DESTINATION, EXTRA]; return "forbidden-success"; },
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ message: "current proof changed" }); expect(lost.state.resets).toBe(1);
  });
  test("planning still resolves the exact current Human without requiring a Device", async () => {
    const f = fixture();
    const port = createProtectedTaskOutputReadAuthorityPort({ ...f.dependencies, resolveRequesterHuman: async () => ({ id: AGENT }) });
    expect(await port.withPlanning({ intent: f.selected, subject: { userId: USER, humanActorId: HUMAN },
      use: () => "forbidden" })).toBeNull();
    expect(f.events).toEqual([]);
  });
  test("wake without canonical foreground admission stays unavailable while raw needs none", async () => {
    for (const wake of [true, false]) {
      const f = fixture(wake);
      const { canonicalWakeForegroundAdmission: _wake, ...withoutWakeAdmission } = f.dependencies;
      let used = false;
      const result = await createProtectedTaskOutputReadAuthorityPort(withoutWakeAdmission).withDiscovery({ intent: f.selected, subject, use: () => { used = true; return true; } });
      expect(result).toBe(wake ? null : true); expect(used).toBe(!wake);
      if (wake) expect(f.events).toEqual([]);
    }
  });
  test("independently admitted private Namespace merges grant operations but not result evidence", async () => {
    const f = fixture(true, [PRIVATE, DESTINATION, EXTRA]);
    expect(await f.port().withDiscovery({ intent: f.selected, subject, use: current => {
      expect(current.namespaceRequirements[0]?.operations).toEqual(["decrypt", "encrypt"]);
      expect(current.resultNamespaceRequirement.operations).toEqual(["decrypt"]);
      expect(current.occurrence.result.namespace.operations).toEqual(["decrypt"]);
      expect(current.foregroundNamespaceRequirements).toHaveLength(3);
      expect(current.namespaceAuthority.facts).toHaveLength(3); expect(current.domains).toHaveLength(1); return true;
    } })).toBe(true);
  });
  for (const point of ["before", "inside"] as const) {
    test(`current wake inventory drift ${point} use rejects without snapshot admission`, async () => {
      const f = fixture(true); let used = false;
      if (point === "before") f.state.currentForeground = [DESTINATION, EXTRA];
      const outcome = await f.port().withDiscovery({ intent: f.selected, subject, use: () => {
        used = true; f.state.currentForeground = [DESTINATION, EXTRA]; return true;
      } }).catch((error: unknown) => error instanceof Error ? error.message : error);
      expect(outcome).toBe(point === "before" ? null : "current proof changed"); expect(used).toBe(point === "inside");
      expect(f.state.resets).toBe(point === "before" ? 1 : 2);
    });
  }
  for (const mode of ["bound", "accepted"] as const) {
    for (const wake of [false, true]) {
      test(`${mode} ${wake ? "wake" : "raw"} stays in one borrowed product scope with current occurrence`, async () => {
        const f = fixture(wake); let checks = 0;
        const use = async (current: CurrentTaskRuntimeAuthority & { occurrence: unknown }, product: PostgresJsBridgeConnection,
          restricted: PostgresJsBridgeConnection) => {
          expect(f.state.held).toBe(true); expect(current.occurrence).toBeDefined();
          expect(product).toBe(f.product); expect(restricted).toBe(f.restricted); return "held";
        };
        const result = mode === "bound"
          ? await f.port().withBound({ intent: f.selected, subject, request: f.request, admission: f.admission,
            namespaceRequirements: f.namespaces, domainRequirements: f.domains, use })
          : await f.port().withAccepted({ intent: f.selected, subject, accepted: f.accepted,
            validateBeforeCommit: () => { expect(f.state.held).toBe(true); checks++; }, use });
        expect(result).toBe("held"); expect(f.state.proofEntries).toBe(1); expect(f.state.resets).toBe(1);
        expect(f.events.filter(e => e === "product-held")).toHaveLength(1);
        expect(checks).toBe(mode === "accepted" ? 2 : 0);
        expect(f.accepted.authorizationBytes.some(b => b !== 0)).toBe(true);
        expect(f.admission.headDigest.some(b => b !== 0)).toBe(true);
      });
    }
  }
  test("accepted raw authority admits a genuine V3 carrier and retains legacy V1", async () => {
    for (const carrier of ["legacy", "v3"] as const) {
      const f = fixture(false, [DESTINATION], false, carrier);
      let used = false;
      const result = await f.port().withAccepted({ intent: f.selected, subject,
        accepted: f.accepted, validateBeforeCommit: () => {}, use: () => {
          used = true;
          return carrier;
        } });
      expect(result).toBe(carrier);
      expect(used).toBe(true);
      expect(f.events).toContain("accepted-crypto");
    }
  });
  test("accepted raw authority rejects a corrupted V3 carrier before product custody", async () => {
    const f = fixture(false, [DESTINATION], false, "corrupt_v3");
    let used = false;
    const result = await f.port().withAccepted({ intent: f.selected, subject,
      accepted: f.accepted, validateBeforeCommit: () => {}, use: () => {
        used = true;
        return "forbidden";
      } });
    expect(result).toBeNull();
    expect(used).toBe(false);
    expect(f.events).not.toContain("product-held");
    expect(f.events).not.toContain("accepted-crypto");
  });
  for (const change of ["private_write", "extra_foreground", "wrong_session", "wrong_work", "wrong_request"] as const) {
    test(`bound refuses ${change} before accepted custody`, async () => {
      const f = fixture();
      const request = { ...f.request, ...(change === "wrong_session" ? { episodeId: RUN }
        : change === "wrong_work" ? { workId: TASK } : change === "wrong_request" ? { requestId: "substituted-request" } : {}) };
      const requirements = change === "private_write" ? f.namespaces.map(n => ({ ...n, operations: ["decrypt", "encrypt"] as const }))
        : change === "extra_foreground" ? [...f.namespaces, { ...f.namespaces[1]!, ordinal: 2, namespaceId: EXTRA }] : f.namespaces;
      let used = false;
      const result = await f.port().withBound({ intent: f.selected, subject, request, admission: f.admission,
        namespaceRequirements: requirements, domainRequirements: f.domains, use: async () => { used = true; return true; } })
        .catch(() => null);
      expect(result).toBeNull(); expect(used).toBe(false); expect(f.events).not.toContain("bound-crypto");
    });
  }
  for (const changed of ["product", "invocation", "crypto"] as const) {
    test(`denies changed ${changed} without a consumer effect`, async () => {
      const f = fixture(); if (changed === "product") f.state.validProduct = false;
      if (changed === "invocation") f.state.validForeground = false;
      if (changed === "crypto") f.state.rejectCrypto = true;
      let used = false;
      expect(await f.port().withAccepted({ intent: f.selected, subject, accepted: f.accepted,
        validateBeforeCommit: () => {}, use: () => { used = true; return true; } })).toBeNull();
      expect(used).toBe(false); expect(f.state.resets).toBe(1);
    });
  }
  test("snapshots result and invocation before asynchronous discovery", async () => {
    const f = fixture();
    const originalGenesis = f.selected.result.genesisManifestHash.slice();
    const port = createProtectedTaskOutputReadAuthorityPort({ ...f.dependencies,
      resolveRequesterHuman: async () => {
        f.selected.result.genesisManifestHash.fill(0);
        return { id: HUMAN };
      },
    });
    expect(await port.withDiscovery({ intent: f.selected, subject, use: current => {
      expect(current.occurrence.result.genesisManifestHash).toEqual(originalGenesis);
      expect(current.occurrence.invocation.sessionId).toBe(SESSION);
      return true;
    } })).toBe(true);
  });
  test("rejects a substituted requester before product or crypto work", async () => {
    const f = fixture();
    expect(await f.port().withDiscovery({ intent: f.selected, subject: { ...subject, humanActorId: AGENT },
      use: () => "forbidden" })).toBeNull();
    expect(f.events).toEqual([]);
  });
  test("wake discovery must supply a canonical destination-containing inventory", async () => {
    for (const ids of [[PRIVATE], [DESTINATION, DESTINATION], [EXTRA, DESTINATION]]) {
      const f = fixture(true, ids);
      expect(await f.port().withDiscovery({ intent: f.selected, subject, use: () => "forbidden" })).toBeNull();
      expect(f.events).not.toContain("product-held");
    }
  });
  test("current product proof loss or outer commit failure cannot report success", async () => {
    for (const fail of ["proof", "commit", "claim"] as const) {
      const f = fixture(); let used = false;
      const outcome = await f.port().withAccepted({ intent: f.selected, subject, accepted: f.accepted,
        validateBeforeCommit: () => { if (used && fail === "claim") throw new Error("claim expired"); },
        use: () => { used = true; if (fail === "proof") f.state.validProduct = false;
          if (fail === "commit") f.state.failCommit = true; return "forbidden-success"; },
      }).catch((error: unknown) => error instanceof Error ? error.message : error);
      expect(outcome).toBe(fail === "proof" ? "current proof changed" : fail === "commit" ? "product commit failed" : "claim expired");
      expect(f.state.held).toBe(false); expect(f.state.resets).toBe(1);
    }
  });
});

test("running wake writers enter the genuine product owner without nesting accepted authority", async () => {
  const f = fixture(true);
  const writer = Object.freeze({}) as never;
  let writes = 0;
  f.state.currentForeground = [DESTINATION, EXTRA];
  const port = createProtectedTaskOutputReadAuthorityPort({ ...f.dependencies,
    canonicalWakeForegroundAdmission: { ...f.dependencies.canonicalWakeForegroundAdmission!,
      discover: async () => ({ namespaceIds: [DESTINATION, EXTRA] }) },
    withAcceptedAuthority: async () => { throw new Error("Wake writer cannot nest accepted authority"); },
    withWakeWriterAuthority: async input => {
      expect(f.state.held).toBe(true);
      expect(await input.validateCurrentProduct(f.product, f.transaction)).toBe(true);
      expect(input.accepted).not.toBe(f.accepted);
      expect(input.accepted.descriptorBytes).toEqual(f.accepted.descriptorBytes);
      writes += 1;
      const result = await input.use(writer);
      await input.validateBeforeCommit();
      return result;
    },
  });
  const operation = { subject, accepted: f.accepted,
    evidence: {} as never, signer: {} as never,
    resolveHistoricalSignerPublicationManager: () => null,
    validateBeforeCommit: () => Promise.resolve(),
    use: (value: typeof writer) => { expect(value).toBe(writer); return Promise.resolve("written"); },
  };
  expect(await port.withWakeWriter!({ ...operation, intent: f.selected })).toBeNull();
  expect(writes).toBe(0);
  expect(await port.withWakeWriter!({ ...operation,
    intent: { ...f.selected, initialState: "wake_running" },
  })).toBe("written");
  expect(writes).toBe(1);
  expect(f.state.held).toBe(false);
});

test("running wake writer admits a genuine V3 carrier and rejects corruption", async () => {
  for (const carrier of ["v3", "corrupt_v3"] as const) {
    const f = fixture(true, [DESTINATION], false, carrier);
    let writes = 0;
    const port = createProtectedTaskOutputReadAuthorityPort({ ...f.dependencies,
      withWakeWriterAuthority: async input => {
        writes += 1;
        return input.use({} as never);
      },
    });
    const result = await port.withWakeWriter!({ subject, accepted: f.accepted,
      intent: { ...f.selected, initialState: "wake_running" },
      evidence: {} as never, signer: {} as never,
      resolveHistoricalSignerPublicationManager: () => null,
      validateBeforeCommit: () => Promise.resolve(),
      use: () => Promise.resolve("written"),
    });
    expect(result).toBe(carrier === "v3" ? "written" : null);
    expect(writes).toBe(carrier === "v3" ? 1 : 0);
    expect(f.events.includes("product-held")).toBe(carrier === "v3");
  }
});

test("wake projection stays inside its accepted Namespace set and canonical destination locks", async () => {
  for (const failure of ["none", "outside_grant", "destination_changed"] as const) {
    const f = fixture(true);
    let destinationLocks = 0;
    let writes = 0;
    const port = createProtectedTaskOutputReadAuthorityPort({ ...f.dependencies,
      lockProjectionDestination: async (transaction, destination) => {
        expect(f.state.held).toBe(true);
        expect(transaction).toBe(f.transaction);
        expect(destination).toMatchObject({ userId: subject.userId,
          requesterActorId: subject.humanActorId, roomLabel: "Chosen Room", audienceFingerprint: "sealed-audience" });
        destinationLocks += 1;
        return failure === "destination_changed" ? "destination_changed" : null;
      },
      withProductAuthority: input => f.dependencies.withProductAuthority!({ ...input,
        use: async (proof, product, transaction, restricted) => {
          if (input.projectionDestination === undefined
            || !await input.validateCurrentProjectionDestination!(product, transaction)) return null;
          return input.use(proof, product, transaction, restricted);
        },
      }),
      withWakeWriterAuthority: async input => {
        expect(f.state.held).toBe(true);
        writes += 1;
        return input.use({} as never);
      },
    });
    const result = await port.withWakeWriter!({ subject, accepted: f.accepted,
      intent: { ...f.selected, initialState: "wake_running" },
      projectionDestination: { roomId: f.selected.invocation.roomId,
        namespaceId: failure === "outside_grant" ? PRIVATE : DESTINATION,
        label: "Chosen Room", kind: "group", memberCount: 2, audienceFingerprint: "sealed-audience" },
      evidence: {} as never, signer: {} as never,
      resolveHistoricalSignerPublicationManager: () => null,
      validateBeforeCommit: () => Promise.resolve(),
      use: () => Promise.resolve("published"),
    });
    expect(result).toBe(failure === "none" ? "published" : null);
    expect(destinationLocks).toBe(failure === "outside_grant" ? 0 : 1);
    expect(writes).toBe(failure === "none" ? 1 : 0);
    expect(f.state.held).toBe(false);
  }
});

test("sealed wake destination is independently held, encrypt-only and never projected into source foreground", async () => {
  const f = fixture(true, [DESTINATION], true);
  expect(await f.port().withDiscovery({ intent: f.selected, subject, use: current => {
    expect(current.foregroundNamespaceRequirements.map(n => n.namespaceId)).toEqual([DESTINATION]);
    expect(current.namespaceAuthority.additionalMutationFact?.destination.namespaceId).toBe(EXTRA);
    expect(current.namespaceRequirements.find(n => n.namespaceId === EXTRA)?.operations).toEqual(["encrypt"]);
    return "ready";
  } })).toBe("ready");
  expect(f.events.indexOf("destination-capability")).toBeLessThan(f.events.indexOf("device-namespace-domain"));
  expect(await f.port().withAccepted({ intent: f.selected, subject, accepted: f.accepted,
    validateBeforeCommit: () => {}, use: current => current.namespaceAuthority.additionalMutationFact?.destination.namespaceId }))
    .toBe(EXTRA);
});
for (const drift of ["destinationChanged", "capabilityLost"] as const) {
  test(`sealed wake ${drift} denies before grant and after borrowed use`, async () => {
    const f = fixture(true, [DESTINATION], true); f.state[drift] = true;
    expect(await f.port().withPlanning({ intent: f.selected, subject, use: () => { throw new Error("must not enter"); } })).toBeNull();
    f.state[drift] = false;
    await Promise.resolve(expect(f.port().withPlanning({ intent: f.selected, subject, use: () => { f.state[drift] = true; return "not committed"; } }))
      .rejects.toThrow("current proof changed"));
  });
}
test("wake continuation cannot nominate decrypt destinations, lose retained source authority, or reuse an old generation", async () => {
  for (const source of [PRIVATE, EXTRA]) {
    const f = fixture(true, [DESTINATION], true);
    const receipt = f.selected.continuation!;
    const semanticAuthorityRequirements = source === EXTRA
      ? [{ namespaceId: EXTRA, operations: ["decrypt", "encrypt"] as const }]
      : [{ namespaceId: source, operations: ["decrypt"] as const },
        { namespaceId: EXTRA, operations: ["encrypt"] as const }];
    const changed = { ...f.selected, continuation: { ...receipt, semanticAuthorityRequirements,
      requiredAuthorityDigest: protectedTaskSemanticAuthorityRequirementsDigest(semanticAuthorityRequirements) } };
    expect(await f.port().withPlanning({ intent: changed, subject, use: () => "forged" })).toBeNull();
    expect(f.state.proofEntries).toBe(0);
  }
  const f = fixture(true, [DESTINATION], true);
  expect(await f.port().withAccepted({ intent: { ...f.selected, continuation: { ...f.selected.continuation!, segment: 2 } },
    subject, accepted: f.accepted, validateBeforeCommit: () => {}, use: () => "old grant" })).toBeNull();
});

test("planning a sealed outside destination lends only held product metadata and rechecks capability", async () => {
  for (const failure of ["none", "changed", "revoked", "post-use"] as const) {
    const f = fixture(true);
    f.state.destinationChanged = failure === "changed";
    f.state.capabilityLost = failure === "revoked";
    let entered = 0;
    const port = createProtectedTaskOutputReadAuthorityPort({ ...f.dependencies,
      withProductAuthority: input => f.dependencies.withProductAuthority!({ ...input, use: async (proof, product, tx, restricted) => {
        expect(input.projectionPlanningOnly).toBe(true);
        expect(input.foregroundNamespaceIds).toEqual([DESTINATION]);
        expect(input.additionalMutationDestination).toBeUndefined();
        if (!await input.validateCurrentProjectionDestination!(product, tx)) return null;
        const value = await input.use(proof, product, tx, restricted);
        if (!await input.validateCurrentProjectionDestination!(product, tx)) throw new Error("destination changed");
        return value;
      } }),
    });
    const result = port.withWakeProjectionDestination!({ intent: { ...f.selected, initialState: "wake_running" },
      subject, destination: extraDestination, use: (current, product, tx) => {
        entered++; expect(f.state.held).toBe(true); expect(product).toBe(f.product); expect(tx).toBe(f.transaction);
        expect(current.destinationAuthorityDigest).toEqual(protectedTaskProjectionDestinationAuthorityDigest(extraDestination));
        if (failure === "post-use") f.state.capabilityLost = true;
        return Promise.resolve("planned");
      } });
    if (failure === "post-use") await Promise.resolve(expect(result).rejects.toThrow("destination changed"));
    else expect(await result).toBe(failure === "none" ? "planned" : null);
    expect(entered).toBe(failure === "none" || failure === "post-use" ? 1 : 0);
    expect(f.events).not.toContain("device-namespace-domain");
    expect(f.state.held).toBe(false);
  }
});

test("authentic continuation restricts expanded canonical visibility to the original source envelope", async () => {
  const f = fixture(true, [DESTINATION], true);
  f.state.currentForeground = [DESTINATION, EXTRA];
  const port = createProtectedTaskOutputReadAuthorityPort({ ...f.dependencies,
    canonicalWakeForegroundAdmission: { ...f.dependencies.canonicalWakeForegroundAdmission!,
      discover: async () => ({ namespaceIds: [DESTINATION, EXTRA] }),
    },
  });
  expect(await port.withPlanning({ intent: f.selected, subject, use: current => {
    expect(current.namespaceAuthority.foregroundFacts.map(row => row.namespaceId)).toEqual([DESTINATION]);
    expect(current.namespaceAuthority.additionalMutationFact?.namespace.namespaceId).toBe(EXTRA);
    return "restricted";
  } })).toBe("restricted");
  f.state.currentForeground = [EXTRA];
  expect(await port.withPlanning({ intent: f.selected, subject, use: () => "lost source" })).toBeNull();
});


test("accepted wake retains only signed ordinary reads when fresh visibility expands", async () => {
  const f = fixture(true);
  const port = createProtectedTaskOutputReadAuthorityPort({ ...f.dependencies, canonicalWakeForegroundAdmission: {
    ...f.dependencies.canonicalWakeForegroundAdmission!, discover: async () => ({ namespaceIds: [DESTINATION, EXTRA] }),
  } });
  f.state.currentForeground = [DESTINATION, EXTRA];
  let used = false;
  expect(await port.withAccepted({ intent: f.selected, subject, accepted: f.accepted,
    validateBeforeCommit: () => {}, use: current => {
      used = true;
      expect(current.foregroundNamespaceRequirements.map(n => n.namespaceId)).toEqual([DESTINATION]);
      expect(current.resultNamespaceRequirement.operations).toEqual(["decrypt"]);
      return true;
    } })).toBe(true);
  expect(used).toBe(true);
  f.state.currentForeground = [EXTRA];
  used = false;
  expect(await port.withAccepted({ intent: f.selected, subject, accepted: f.accepted,
    validateBeforeCommit: () => {}, use: () => { used = true; return true; } })).toBeNull();
  expect(used).toBe(false);
});
