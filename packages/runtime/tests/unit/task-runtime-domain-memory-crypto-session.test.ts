import { describe, expect, test } from "bun:test";
import {
  authorizationRevision,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import { decodeNamespaceObjectEnvelopeV2 } from
  "@nautilo/lattice-crypto/wire";
import {
  MEMORY_OBJECT_TYPE,
  commitMemoryMutationV1,
  deriveMemoryCryptoObjectIdV1,
  encodeMemoryPayloadV1,
  readPreparedTaskRuntimeAgentObjectSnapshot,
  type VerifiedAgentObject,
} from "@nautilo/lattice-bridge";
import type { ForegroundMemoryRepairSource } from "@nautilo/lattice-bridge/server";
import {
  withTaskRuntimeExecutionEvidenceV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import { taskRuntimeAgentObjectSetFixture } from
  "../../../lattice-crypto/tests/helpers/task-runtime-agent-object-set-fixture.ts";

import {
  createTaskRuntimeDomainMemoryCryptoSession,
  type TaskRuntimeDomainMemoryCryptoSessionInput,
} from "../../src/memory/task-runtime-domain-memory-crypto-session.ts";

const NOW = 2_200_000_000_000;
const SUBJECT_ID = "22000000-0000-4000-8000-000000000001";
const MEMORY_ID = "22000000-0000-4000-8000-000000000002";
const NAMESPACE_ID = "22000000-0000-4000-8000-000000000003";
const SCOPE_ID = "22000000-0000-4000-8000-000000000004";
const OTHER_SCOPE_ID = "22000000-0000-4000-8000-000000000005";

describe("Task Runtime Domain Memory crypto session", () => {
  test("binds plan coordinates and preserves a completed semantic result across closure", async () => {
    const base = await taskRuntimeAgentObjectSetFixture(92_601);
    const sourceNamespace = base.nativeNamespaces[0]!;
    const selectedNamespace = Object.freeze({
      ...sourceNamespace,
      namespaceId: NAMESPACE_ID,
    });
    const evidenceInput = Object.freeze({
      ...base.evidence,
      result: Object.freeze({
        ...base.evidence.result,
        namespace: Object.freeze({
          ...base.evidence.result.namespace,
          namespaceId: NAMESPACE_ID,
        }),
      }),
      namespaceRequirements: Object.freeze(
        base.evidence.namespaceRequirements.map((entry, index) =>
          index === 0
            ? Object.freeze({ ...entry, namespaceId: NAMESPACE_ID })
            : entry
        ),
      ),
    });
    const controller = new AbortController();
    await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceInput,
      signal: controller.signal,
      now: () => NOW,
      execute: async evidence => {
        const namespaceKey = new Uint8Array(32).fill(0x71);
        const namespaceAuthority = Object.freeze({
          namespaceId: NAMESPACE_ID,
          namespaceAccessRevision: selectedNamespace.accessRevision,
          namespaceKeyGeneration: selectedNamespace.keyGeneration,
          domainId: selectedNamespace.domainId,
          domainKeyGeneration: selectedNamespace.domainKeyGeneration,
          domainAuthorizationRevision:
            selectedNamespace.domainAuthorizationRevision,
          domainHeadDigest: selectedNamespace.domainHeadDigest,
          namespaceHeadDigest: selectedNamespace.headDigest,
          namespacePublicationDigest: selectedNamespace.publicationDigest,
          namespacePublicationSetDigest:
            selectedNamespace.publicationSetDigest,
          namespaceAudienceFingerprint:
            selectedNamespace.audienceFingerprint,
        });
        let durable: VerifiedAgentObject | null = null;
        let firstRead = true;
        let releaseRead: (() => void) | undefined;
        const readGate = new Promise<void>(resolve => {
          releaseRead = resolve;
        });
        let failAfterExecution = false;
        const persisted: Readonly<{
          memoryId: string;
          contentRevision: number;
          operationId: string;
        }>[] = [];
        const factory = createTaskRuntimeDomainMemoryCryptoSession({
          subjectUserId: SUBJECT_ID,
          agentId: evidence.result.signerAgentId,
          evidence,
          crypto: base.crypto,
          entities: {
            signal: controller.signal,
            use: async request => ({
              status: "executed" as const,
              value: await request.execute({
                namespaceKey,
                authority: namespaceAuthority,
              }),
            }),
            useCurrentSet: async request => {
              const value = await request.execute([{
                namespaceKey,
                authority: namespaceAuthority,
              }]);
              if (failAfterExecution) {
                throw new TypeError("Task authority closed after callback");
              }
              return { status: "executed" as const, value };
            },
          },
          runtime: base.initialized.runtime,
          signerPublication: base.initialized.signerPublication,
          resolveHistoricalSignerPublicationManager: () =>
            base.manager.publicKey,
          agentAuthorizationRevision: authorizationRevision(7),
          persist: async request => {
            persisted.push(Object.freeze({
              memoryId: request.memoryId,
              contentRevision: request.contentRevision,
              operationId: request.operationId,
            }));
            const snapshot = readPreparedTaskRuntimeAgentObjectSnapshot(
              request.prepared,
              request.evidence,
            );
            durable = Object.freeze({
              objectId: request.prepared.objectId,
              accessRevision: 0,
              payloadBytes: snapshot.object.payloadBytes.ciphertext.slice(),
              namespaceEnvelopes: Object.freeze(
                snapshot.access.envelopeBytes.map(bytes => {
                  const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
                  return Object.freeze({
                    namespaceId: envelope.context.namespaceId,
                    keyGeneration: envelope.context.keyGeneration,
                    bindingRevisionAtWrap:
                      envelope.context.bindingRevisionAtWrap,
                    envelopeBytes: bytes.slice(),
                  });
                }),
              ),
            });
            return "created";
          },
          read: async () => {
            if (firstRead) {
              firstRead = false;
              await readGate;
            }
            const current = durable;
            return current === null ? null : Object.freeze({
              ...current,
              payloadBytes: current.payloadBytes.slice(),
              namespaceEnvelopes: current.namespaceEnvelopes.map(entry =>
                Object.freeze({
                  ...entry,
                  envelopeBytes: entry.envelopeBytes.slice(),
                })
              ),
            });
          },
        });
        const productAuthority = Object.freeze({
          mode: "namespace" as const,
          subjectUserId: SUBJECT_ID,
          agentId: evidence.result.signerAgentId,
          readableNamespaceIds: Object.freeze([NAMESPACE_ID]),
          mutableNamespaceIds: Object.freeze([NAMESPACE_ID]),
          writableNamespaceId: NAMESPACE_ID,
        });
        const payload = {
          formatVersion: 1 as const,
          type: "preference" as const,
          content: "Keep Task Memory exact.",
        };
        const plan = {
          operationId: "task-memory-plan-operation",
          action: "created" as const,
          mutationKind: "save" as const,
          memoryId: MEMORY_ID,
          contentRevision: 1,
          cryptoAccessRevision: 0,
          expectedPriorAccessRevision: 0,
          cryptoObjectId: deriveMemoryCryptoObjectIdV1({
            memoryId: MEMORY_ID,
            contentRevision: 1,
          }),
          requiredNamespaceIds: [NAMESPACE_ID],
          reservationDigest: new Uint8Array(32).fill(0x61),
          mutationCommitment: commitMemoryMutationV1({
            kind: "save",
            payload,
          }),
          importance: 0.5,
          createdAt: NOW,
        };
        const preparation = factory.session.prepare({
          entrypointId: "subagent.scope",
          agentId: evidence.result.signerAgentId,
          authority: productAuthority,
          plan,
          content: { kind: "complete", payload },
        });
        plan.operationId = "mutated-plan-operation";
        plan.memoryId = "22000000-0000-4000-8000-000000000099";
        plan.contentRevision = 99;
        plan.cryptoObjectId = deriveMemoryCryptoObjectIdV1({
          memoryId: plan.memoryId,
          contentRevision: plan.contentRevision,
        });
        plan.requiredNamespaceIds[0] =
          "22000000-0000-4000-8000-000000000098";
        payload.content = "mutated content";
        releaseRead?.();
        const prepared = await preparation;
        expect(prepared.status).toBe("success");
        if (prepared.status !== "success") throw new Error(prepared.reason);
        expect(prepared.value).toMatchObject({
          memoryId: MEMORY_ID,
          contentRevision: 1,
          objectId: deriveMemoryCryptoObjectIdV1({
            memoryId: MEMORY_ID,
            contentRevision: 1,
          }),
          objectType: MEMORY_OBJECT_TYPE,
        });
        expect(persisted).toEqual([{
          memoryId: MEMORY_ID,
          contentRevision: 1,
          operationId: "task-memory-plan-operation",
        }]);
        expect(await factory.completion.complete(prepared.value)).toBe(
          "duplicate",
        );
        expect(factory.readPreparedPayload(prepared.value)).toEqual({
          formatVersion: 1,
          type: "preference",
          content: "Keep Task Memory exact.",
        });
        expect(() => factory.readPreparedPayload({ ...prepared.value }))
          .toThrow("belongs to another crypto session");

        failAfterExecution = true;
        let semanticCommits = 0;
        expect(await factory.session.authorizeCommit({
          entrypointId: "subagent.scope",
          agentId: evidence.result.signerAgentId,
          authority: productAuthority,
          target: {
            memoryId: MEMORY_ID,
            contentRevision: 1,
            cryptoAccessRevision: 0,
            cryptoObjectId: deriveMemoryCryptoObjectIdV1({
              memoryId: MEMORY_ID,
              contentRevision: 1,
            }),
            requiredNamespaceIds: [NAMESPACE_ID],
          },
          operation: "publish",
          commit: () => {
            semanticCommits += 1;
            controller.abort();
            return "committed" as const;
          },
        })).toEqual({ status: "success", value: "committed" });
        expect(semanticCommits).toBe(1);
        expect(await factory.session.openMany({
          entrypointId: "subagent.scope",
          agentId: evidence.result.signerAgentId,
          authority: productAuthority,
          candidates: [],
        })).toEqual({
          status: "unavailable",
          reason: "authorization_required",
        });
        expect(factory.completion.complete(prepared.value)).rejects.toThrow(
          "evidence is not active",
        );
        expect(() => factory.readPreparedPayload(prepared.value)).toThrow(
          "not active",
        );
      },
    });
  });

  test("requires active genuine evidence for the exact Agent", async () => {
    const base = await taskRuntimeAgentObjectSetFixture(92_602);
    expect(() => createTaskRuntimeDomainMemoryCryptoSession({
      subjectUserId: SUBJECT_ID,
      agentId: base.evidence.result.signerAgentId,
      evidence: base.evidence as unknown as TaskRuntimeExecutionEvidence,
      crypto: base.crypto,
      entities: {
        signal: new AbortController().signal,
        use: async () => ({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        }),
        useCurrentSet: async () => ({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        }),
      },
      runtime: base.initialized.runtime,
      signerPublication: base.initialized.signerPublication,
      resolveHistoricalSignerPublicationManager: () => base.manager.publicKey,
      agentAuthorizationRevision: authorizationRevision(7),
      persist: async () => "stale",
      read: async () => null,
    })).toThrow("not active");

    await base.withEvidence(
      new AbortController().signal,
      () => NOW,
      evidence => {
        expect(() => createTaskRuntimeDomainMemoryCryptoSession({
          subjectUserId: SUBJECT_ID,
          agentId: "another-agent",
          evidence,
          crypto: base.crypto,
          entities: {
            signal: new AbortController().signal,
            use: async () => ({
              status: "unavailable" as const,
              reason: "authorization_unavailable" as const,
            }),
            useCurrentSet: async () => ({
              status: "unavailable" as const,
              reason: "authorization_unavailable" as const,
            }),
          },
          runtime: base.initialized.runtime,
          signerPublication: base.initialized.signerPublication,
          resolveHistoricalSignerPublicationManager: () =>
            base.manager.publicKey,
          agentAuthorizationRevision: authorizationRevision(7),
          persist: async () => "stale",
          read: async () => null,
        })).toThrow("does not match execution evidence");
      },
    );
  });

  test("protects one exact Scope Shadow source through the session object owner", async () => {
    const base = await taskRuntimeAgentObjectSetFixture(92_604);
    const controller = new AbortController();
    const sourceNamespace = base.nativeNamespaces[0]!;
    const origin = Object.freeze({
      ...sourceNamespace,
      namespaceId: NAMESPACE_ID,
    });
    const evidenceInput = Object.freeze({
      ...base.evidence,
      result: Object.freeze({
        ...base.evidence.result,
        namespace: Object.freeze({
          ...base.evidence.result.namespace,
          namespaceId: NAMESPACE_ID,
        }),
      }),
      namespaceRequirements: Object.freeze(
        base.evidence.namespaceRequirements.map((entry, index) =>
          index === 0
            ? Object.freeze({ ...entry, namespaceId: NAMESPACE_ID })
            : entry
        ),
      ),
    });
    await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceInput,
      signal: controller.signal,
      now: () => NOW,
      execute: async evidence => {
      const namespaceKey = new Uint8Array(32).fill(0x7a);
      const namespaceAuthority = Object.freeze({
        namespaceId: origin.namespaceId,
        namespaceAccessRevision: origin.accessRevision,
        namespaceKeyGeneration: origin.keyGeneration,
        domainId: origin.domainId,
        domainKeyGeneration: origin.domainKeyGeneration,
        domainAuthorizationRevision: origin.domainAuthorizationRevision,
        domainHeadDigest: origin.domainHeadDigest,
        namespaceHeadDigest: origin.headDigest,
        namespacePublicationDigest: origin.publicationDigest,
        namespacePublicationSetDigest: origin.publicationSetDigest,
        namespaceAudienceFingerprint: origin.audienceFingerprint,
      });
      let durable: VerifiedAgentObject | null = null;
      let readCount = 0;
      let persistCount = 0;
      let abortOnRead: AbortController | null = null;
      const sessionInput: TaskRuntimeDomainMemoryCryptoSessionInput = {
        subjectUserId: SUBJECT_ID,
        agentId: evidence.result.signerAgentId,
        evidence,
        crypto: base.crypto,
        entities: {
          signal: controller.signal,
          use: async request => ({
              status: "executed" as const,
              value: await request.execute({
                namespaceKey,
                authority: namespaceAuthority,
              }),
            }),
          useCurrentSet: async request => ({
            status: "executed" as const,
            value: await request.execute([{
              namespaceKey,
              authority: namespaceAuthority,
            }]),
          }),
        },
        runtime: base.initialized.runtime,
        signerPublication: base.initialized.signerPublication,
        resolveHistoricalSignerPublicationManager: () => base.manager.publicKey,
        agentAuthorizationRevision: authorizationRevision(7),
        persist: async request => {
          persistCount += 1;
          expect(request.memoryId).toBe(MEMORY_ID);
          expect(request.contentRevision).toBe(2);
          expect(request.operationId).toBe("task-scope-memory-repair");
          const snapshot = readPreparedTaskRuntimeAgentObjectSnapshot(
            request.prepared,
            request.evidence,
          );
          durable = Object.freeze({
            objectId: request.prepared.objectId,
            accessRevision: 0,
            payloadBytes: snapshot.object.payloadBytes.ciphertext.slice(),
            namespaceEnvelopes: Object.freeze(
              snapshot.access.envelopeBytes.map(bytes => {
                const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
                return Object.freeze({
                  namespaceId: envelope.context.namespaceId,
                  keyGeneration: envelope.context.keyGeneration,
                  bindingRevisionAtWrap:
                    envelope.context.bindingRevisionAtWrap,
                  envelopeBytes: bytes.slice(),
                });
              }),
            ),
          });
          return "created" as const;
        },
        read: async request => {
          readCount += 1;
          expect(request.objectId).toBe(deriveMemoryCryptoObjectIdV1({
            memoryId: MEMORY_ID,
            contentRevision: 2,
          }));
          expect(request.expectedObjectType).toBe(MEMORY_OBJECT_TYPE);
          expect(request.expectedNamespaceIds).toEqual([origin.namespaceId]);
          abortOnRead?.abort();
          const current = durable;
          return current === null ? null : Object.freeze({
            ...current,
            payloadBytes: current.payloadBytes.slice(),
            namespaceEnvelopes: Object.freeze(
              current.namespaceEnvelopes.map(entry => Object.freeze({
                ...entry,
                envelopeBytes: entry.envelopeBytes.slice(),
              })),
            ),
          });
        },
      };
      const factory = createTaskRuntimeDomainMemoryCryptoSession({
        ...sessionInput,
        scopeBinding: {
          scopeId: SCOPE_ID,
          originWritableNamespaceId: origin.namespaceId,
          readableNamespaceIds: [origin.namespaceId],
        },
      });
      const payload = Object.freeze({
        formatVersion: 1 as const,
        type: "preference",
        content: "Repair only this current Scope origin.",
      });
      const plaintextBytes = encodeMemoryPayloadV1(payload);
      const requestCommitment = new Uint8Array(32).fill(0x68);
      const originalPlaintext = plaintextBytes.slice();
      const originalCommitment = requestCommitment.slice();
      const source = Object.freeze({
        memory: Object.freeze({
          id: MEMORY_ID,
          type: payload.type,
          content: payload.content,
          importance: 0.7,
          tier: 1,
          createdAt: new Date(NOW),
        }),
        representationMode: "ordinary-and-protected" as const,
        expectedContentRevision: 0,
        targetContentRevision: 2,
        existingObjectId: null,
        expectedAccessRevision: 0,
        accessNamespaceIds: Object.freeze([origin.namespaceId]),
        createdAt: NOW,
        plaintextBytes,
        requestCommitment,
      }) satisfies ForegroundMemoryRepairSource;

      const repaired = await factory.protectExactRepair({
        operationId: "task-scope-memory-repair",
        source,
      });
      expect(repaired).toMatchObject({
        status: "verified",
        objectId: deriveMemoryCryptoObjectIdV1({
          memoryId: MEMORY_ID,
          contentRevision: 2,
        }),
        provenance: "repaired",
        verification: "authenticated",
        value: payload,
      });
      expect(persistCount).toBe(1);
      expect(plaintextBytes).toEqual(originalPlaintext);
      expect(requestCommitment).toEqual(originalCommitment);

      const existingSource = Object.freeze({
        ...source,
        existingObjectId: deriveMemoryCryptoObjectIdV1({
          memoryId: MEMORY_ID,
          contentRevision: 2,
        }),
      });
      expect(await factory.protectExactRepair({
        operationId: "task-scope-memory-existing",
        source: existingSource,
      })).toMatchObject({
        status: "verified",
        provenance: "existing",
        verification: "independent_parity",
        value: payload,
      });
      expect(persistCount).toBe(1);

      const beforeRejectedReads = readCount;
      expect((await factory.protectExactRepair({
        operationId: "task-scope-memory-foreign",
        source: { ...source, accessNamespaceIds: [OTHER_SCOPE_ID] },
      })).status).toBe("failed");
      expect((await factory.protectExactRepair({
        operationId: "task-scope-memory-forged-object",
        source: { ...source, existingObjectId: OTHER_SCOPE_ID },
      })).status).toBe("failed");
      expect(readCount).toBe(beforeRejectedReads);

      const namespaceFactory = createTaskRuntimeDomainMemoryCryptoSession(
        sessionInput,
      );
      expect((await namespaceFactory.protectExactRepair({
        operationId: "task-namespace-memory-repair",
        source,
      })).status).toBe("failed");
      expect(readCount).toBe(beforeRejectedReads);

      const preCancelled = new AbortController();
      preCancelled.abort();
      expect(await factory.protectExactRepair({
        operationId: "task-scope-memory-cancelled-before",
        source: existingSource,
        signal: preCancelled.signal,
      })).toMatchObject({ status: "waiting_for_authority" });
      expect(readCount).toBe(beforeRejectedReads);

      const afterRead = new AbortController();
      abortOnRead = afterRead;
      expect(await factory.protectExactRepair({
        operationId: "task-scope-memory-cancelled-after",
        source: existingSource,
        signal: afterRead.signal,
      })).toMatchObject({ status: "waiting_for_authority" });
      abortOnRead = null;
      expect(readCount).toBe(beforeRejectedReads + 1);
      expect(plaintextBytes).toEqual(originalPlaintext);
      expect(requestCommitment).toEqual(originalCommitment);
      },
    });
  });

  test("forwards one frozen Scope binding and keeps Namespace authority separate", async () => {
    const base = await taskRuntimeAgentObjectSetFixture(92_603);
    await base.withEvidence(
      new AbortController().signal,
      () => NOW,
      async evidence => {
        const origin = NAMESPACE_ID;
        const mutableReadable = [origin];
        let keySetUses = 0;
        const factory = createTaskRuntimeDomainMemoryCryptoSession({
          scopeBinding: {
            scopeId: SCOPE_ID,
            originWritableNamespaceId: origin,
            readableNamespaceIds: mutableReadable,
          },
          subjectUserId: SUBJECT_ID,
          agentId: evidence.result.signerAgentId,
          evidence,
          crypto: base.crypto,
          entities: {
            signal: new AbortController().signal,
            use: async () => ({
              status: "unavailable" as const,
              reason: "authorization_unavailable" as const,
            }),
            useCurrentSet: async () => {
              keySetUses += 1;
              return {
                status: "unavailable" as const,
                reason: "authorization_unavailable" as const,
              };
            },
          },
          runtime: base.initialized.runtime,
          signerPublication: base.initialized.signerPublication,
          resolveHistoricalSignerPublicationManager: () =>
            base.manager.publicKey,
          agentAuthorizationRevision: authorizationRevision(7),
          persist: async () => "stale",
          read: async () => null,
        });
        mutableReadable[0] = OTHER_SCOPE_ID;
        const authority = Object.freeze({
          mode: "scope" as const,
          subjectUserId: SUBJECT_ID,
          agentId: evidence.result.signerAgentId,
          scopeId: SCOPE_ID,
          originWritableNamespaceId: origin,
        });
        expect(await factory.session.openMany({
          entrypointId: "subagent.scope",
          agentId: evidence.result.signerAgentId,
          authority,
          candidates: [],
        })).toEqual({ status: "success", value: [] });
        expect(await factory.session.openMany({
          entrypointId: "subagent.scope",
          agentId: evidence.result.signerAgentId,
          authority,
          candidates: [{
            memoryId: MEMORY_ID,
            contentRevision: 1,
            cryptoAccessRevision: 0,
            cryptoObjectId: deriveMemoryCryptoObjectIdV1({
              memoryId: MEMORY_ID,
              contentRevision: 1,
            }),
            readNamespaceId: origin,
            requiredNamespaceIds: [origin],
            importance: 0.5,
            tier: 1,
            score: 0.9,
            createdAt: new Date(NOW),
          }],
        })).toEqual({
          status: "unavailable",
          reason: "encryption_pending",
        });
        expect(await factory.session.openMany({
          entrypointId: "subagent.scope",
          agentId: evidence.result.signerAgentId,
          authority: { ...authority, scopeId: OTHER_SCOPE_ID },
          candidates: [],
        })).toEqual({
          status: "unavailable",
          reason: "authorization_required",
        });
        expect(await factory.session.openMany({
          entrypointId: "subagent.scope",
          agentId: evidence.result.signerAgentId,
          authority: {
            mode: "namespace",
            subjectUserId: SUBJECT_ID,
            agentId: evidence.result.signerAgentId,
            readableNamespaceIds: [origin],
            mutableNamespaceIds: [origin],
            writableNamespaceId: origin,
          },
          candidates: [],
        })).toEqual({
          status: "unavailable",
          reason: "authorization_required",
        });
        const payload = Object.freeze({
          formatVersion: 1 as const,
          type: "preference" as const,
          content: "Binding cannot mint Namespace keys.",
        });
        expect(await factory.session.prepare({
          entrypointId: "subagent.scope",
          agentId: evidence.result.signerAgentId,
          authority,
          plan: {
            operationId: "scope-binding-does-not-grant",
            action: "created",
            mutationKind: "save",
            memoryId: MEMORY_ID,
            contentRevision: 1,
            cryptoAccessRevision: 0,
            expectedPriorAccessRevision: 0,
            cryptoObjectId: deriveMemoryCryptoObjectIdV1({
              memoryId: MEMORY_ID,
              contentRevision: 1,
            }),
            requiredNamespaceIds: [origin],
            reservationDigest: new Uint8Array(32).fill(0x61),
            mutationCommitment: commitMemoryMutationV1({
              kind: "save",
              payload,
            }),
            importance: 0.5,
            createdAt: NOW,
          },
          content: { kind: "complete", payload },
        })).toEqual({
          status: "unavailable",
          reason: "authorization_required",
        });
        expect(keySetUses).toBe(1);
      },
    );
  });
});
