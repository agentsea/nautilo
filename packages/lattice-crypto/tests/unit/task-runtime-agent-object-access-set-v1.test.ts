import { describe, expect, test } from "bun:test";

import type {
  TaskRuntimeExecutionEvidenceV1,
} from "../../src/background/task-runtime-execution-evidence-v1.ts";
import {
  assertAuthenticPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1,
  cloneTaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1,
  prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1,
  taskRuntimeAgentObjectAccessGenesisSetAuthorityMatchesEvidenceV1,
} from "../../src/object/task-runtime-agent-access-manifest-set-v1.ts";
import {
  decodeNamespaceObjectEnvelopeV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../../src/format/object-v2.ts";
import {
  consumeAuthorizedObjectAccessWriteV2,
  type AuthorizedObjectAccessWriteV2,
  type ObjectAccessAuthorizationExpectationV2,
} from "../../src/object/authorized-write.ts";
import {
  ObjectAccessPersistenceOutcomeUnknownV2,
  type ObjectAccessStateCasStorageV2,
} from "../../src/object/storage-coordinator.ts";
import {
  persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1,
  type CurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorizationV1,
  type WithCurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorizationV1,
} from "../../src/object/task-runtime-agent-storage-coordinator-v1.ts";
import { assertObjectAccessAuthorizationExpectation } from
  "../../src/storage/v2-record-policy.ts";
import type { ObjectAccessStateCasStatusV2 } from
  "../../src/storage/v2-records.ts";
import {
  agentId,
  agentRuntimeGeneration,
  accessRevision,
  authorizationRevision,
  namespaceGeneration,
  objectId,
} from "../../src/v2-types/ids.ts";
import {
  NOW,
  bytes,
  taskRuntimeAgentObjectSetFixture,
} from "../helpers/task-runtime-agent-object-set-fixture.ts";

function storage(input: Readonly<{
  objectId: string;
  payloadBytes: Uint8Array;
  status?: ObjectAccessStateCasStatusV2;
  beforeObjectReturn?: () => void;
  beforeCasReturn?: () => void;
  onObjectRead?: () => void;
  onCas?: () => void;
  inspectAuthorization?: (
    authorization: ObjectAccessAuthorizationExpectationV2,
  ) => void;
}>): ObjectAccessStateCasStorageV2 {
  return {
    getObject: async (objectId) => {
      input.onObjectRead?.();
      input.beforeObjectReturn?.();
      return objectId === input.objectId
        ? { objectId, payloadBytes: input.payloadBytes.slice() }
        : null;
    },
    compareAndSwapObjectAccessState: async (
      authorized: AuthorizedObjectAccessWriteV2,
    ) => {
      input.onCas?.();
      const snapshot = consumeAuthorizedObjectAccessWriteV2(authorized);
      input.inspectAuthorization?.(snapshot.authorization);
      assertObjectAccessAuthorizationExpectation(snapshot.authorization);
      input.beforeCasReturn?.();
      return input.status ?? "applied";
    },
  };
}

function heldOwner(
  current: CurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorizationV1,
  hooks: Readonly<{
    beforeUse?: () => void;
    afterUse?: () => void;
  }> = {},
): WithCurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorizationV1 {
  return async (_context, use) => {
    hooks.beforeUse?.();
    const result = await use(current);
    hooks.afterUse?.();
    return result;
  };
}

describe("Task Runtime Agent native object access set", () => {
  test("persists and exactly replays inside the held authority callback", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture();
    await fixture.withEvidence(
      new AbortController().signal,
      () => NOW,
      async (evidence) => {
        const prepared = fixture.prepare(evidence, [0, 2]);
        expect(prepared.authority.namespaces.map((entry) => entry.namespaceId))
          .toEqual([
            fixture.namespaceFacts[0]!.namespaceId,
            fixture.namespaceFacts[2]!.namespaceId,
          ]);
        expect(prepared.authority.domains.map((entry) => entry.domainId))
          .toEqual([
            fixture.domainFacts[0]!.domainId,
            fixture.domainFacts[1]!.domainId,
          ]);

        let held = false;
        let observedCasWhileHeld = false;
        const appliedStorage = storage({
          objectId: fixture.objectId,
          payloadBytes: fixture.payloadBytes,
          onCas: () => {
            observedCasWhileHeld = held;
          },
        });
        const applied = await
        persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: fixture.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: heldOwner(
            fixture.currentAuthorization(appliedStorage),
            {
              beforeUse: () => {
                held = true;
              },
              afterUse: () => {
                held = false;
              },
            },
          ),
        });
        const duplicateStorage = storage({
          objectId: fixture.objectId,
          payloadBytes: fixture.payloadBytes,
          status: "duplicate",
        });
        const duplicate = await
        persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: fixture.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: heldOwner(
            fixture.currentAuthorization(duplicateStorage),
          ),
        });
        expect(applied).toBe("applied");
        expect(duplicate).toBe("duplicate");
        expect(observedCasWhileHeld).toBe(true);
      },
    );
  });

  test("rejects forged evidence, copied or mutated preparation, and another authentic evidence", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture(90_002);
    const signal = new AbortController().signal;
    await fixture.withEvidence(signal, () => NOW, async (evidence) => {
      expect(() => fixture.prepare(
        { ...evidence } as TaskRuntimeExecutionEvidenceV1,
        [0],
      )).toThrow("not active");
      const prepared = fixture.prepare(evidence, [0]);
      const exactStorage = storage({
        objectId: fixture.objectId,
        payloadBytes: fixture.payloadBytes,
      });
      expect(persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
        crypto: fixture.crypto,
        prepared: { ...prepared },
        evidence,
        withCurrentAuthorization: heldOwner(
          fixture.currentAuthorization(exactStorage),
        ),
      })).rejects.toThrow("authentic preparation");

      const originalByte = prepared.manifestBytes[0]!;
      prepared.manifestBytes[0] = originalByte ^ 0xff;
      expect(persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
        crypto: fixture.crypto,
        prepared,
        evidence,
        withCurrentAuthorization: heldOwner(
          fixture.currentAuthorization(exactStorage),
        ),
      })).rejects.toThrow("authentic preparation");
      prepared.manifestBytes[0] = originalByte;

      await fixture.withEvidence(signal, () => NOW, async (otherEvidence) => {
        expect(persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: fixture.crypto,
          prepared,
          evidence: otherEvidence,
          withCurrentAuthorization: heldOwner(
            fixture.currentAuthorization(exactStorage),
          ),
        })).rejects.toThrow("exact execution evidence");
      });
    });
  });

  test("rejects incomplete, duplicate, and substituted Namespace envelope sets", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture(90_003);
    await fixture.withEvidence(
      new AbortController().signal,
      () => NOW,
      evidence => {
        const input = fixture.prepareInput(evidence, [0, 1]);
        expect(() => prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
          fixture.crypto,
          fixture.prepareInput(evidence, []),
        )).toThrow();
        expect(() => prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
          fixture.crypto,
          { ...input, envelopeBytes: input.envelopeBytes.slice(0, 1) },
        )).toThrow("set is invalid");
        expect(() => prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
          fixture.crypto,
          {
            ...input,
            envelopeBytes: [input.envelopeBytes[0]!, input.envelopeBytes[0]!],
          },
        )).toThrow("envelope set is incomplete");
        expect(() => prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
          fixture.crypto,
          {
            ...input,
            namespaces: [input.namespaces[0]!, input.namespaces[0]!],
          },
        )).toThrow("not canonical");

        const namespace = input.namespaces[0]!;
        for (const substituted of [
          { ...namespace, domainId: fixture.domainFacts[1]!.domainId },
          { ...namespace, domainKeyGeneration: namespace.domainKeyGeneration + 1 },
          {
            ...namespace,
            domainAuthorizationRevision:
              namespace.domainAuthorizationRevision + 1,
          },
          { ...namespace, domainHeadDigest: bytes(0xee) },
          { ...namespace, accessRevision: namespace.accessRevision + 1 },
        ]) {
          expect(() =>
            prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
              fixture.crypto,
              { ...input, envelopeBytes: [input.envelopeBytes[0]!],
                namespaces: [substituted] },
            )
          ).toThrow("authority was substituted");
        }
      },
    );
  });

  test("binds every canonical envelope coordinate to its selected Namespace", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture(90_014);
    await fixture.withEvidence(
      new AbortController().signal,
      () => NOW,
      evidence => {
        const input = fixture.prepareInput(evidence, [0]);
        const decoded = decodeNamespaceObjectEnvelopeV2(input.envelopeBytes[0]!);
        const envelope = (context: typeof decoded.context): Uint8Array =>
          encodeNamespaceObjectEnvelopeV2({ ...decoded, context });
        for (const context of [
          { ...decoded.context, objectId: objectId("another-task-object") },
          {
            ...decoded.context,
            keyGeneration: namespaceGeneration(
              decoded.context.keyGeneration + 1,
            ),
          },
          {
            ...decoded.context,
            bindingRevisionAtWrap: accessRevision(
              decoded.context.bindingRevisionAtWrap + 1,
            ),
          },
          {
            ...decoded.context,
            keyClass: "human" as const,
          },
        ]) {
          expect(() => prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
            fixture.crypto,
            { ...input, envelopeBytes: [envelope(context)] },
          )).toThrow();
        }
        const otherNamespace = fixture.prepareInput(evidence, [1]);
        expect(() => prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
          fixture.crypto,
          { ...input, envelopeBytes: otherNamespace.envelopeBytes },
        )).toThrow();
        expect(() => prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
          fixture.crypto,
          {
            ...input,
            envelopeBytes: ["not-bytes" as unknown as Uint8Array],
          },
        )).toThrow();

        const pair = fixture.prepareInput(evidence, [0, 1]);
        const canonical = prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
          fixture.crypto,
          pair,
        );
        const reversed = prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
          fixture.crypto,
          { ...pair, envelopeBytes: [...pair.envelopeBytes].reverse() },
        );
        expect(reversed.envelopeBytes).toEqual(canonical.envelopeBytes);
        expect(reversed.manifestBytes).toEqual(canonical.manifestBytes);
      },
    );
  });

  test("rejects substituted signer, Runtime, manager, and payload authority", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture(90_015);
    const other = await taskRuntimeAgentObjectSetFixture(90_016);
    await fixture.withEvidence(
      new AbortController().signal,
      () => NOW,
      evidence => {
        const input = fixture.prepareInput(evidence, [0]);
        for (const substituted of [
          {
            ...input,
            agentAuthorizationRevision:
              input.agentAuthorizationRevision + 1,
          },
          {
            ...input,
            runtime: {
              ...input.runtime,
              agentId: agentId("substituted-preparation-runtime"),
            },
          },
          {
            ...input,
            signerPublication: other.initialized.signerPublication,
          },
          {
            ...input,
            resolveHistoricalSignerPublicationManager: () =>
              other.manager.publicKey,
          },
          { ...input, payloadHash: new Uint8Array(31) },
        ]) {
          expect(() => prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
            fixture.crypto,
            substituted,
          )).toThrow();
        }
      },
    );
  });

  test("rejects invalid cloned authority operations and digest shapes", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture(90_017);
    await fixture.withEvidence(
      new AbortController().signal,
      () => NOW,
      evidence => {
        const authority = fixture.prepare(evidence, [0]).authority;
        const first = authority.namespaces[0]!;
        for (const operations of [
          [],
          ["encrypt", "encrypt"],
          ["encrypt", "decrypt"],
          ["decrypt", "encrypt", "encrypt"],
          ["read"],
        ]) {
          expect(() =>
            cloneTaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1({
              ...authority,
              namespaces: [{
                ...first,
                operations: operations as ("decrypt" | "encrypt")[],
              }],
            })
          ).toThrow();
        }
        expect(() =>
          cloneTaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1({
            ...authority,
            payloadHash: new Uint8Array(31),
          })
        ).toThrow();
        expect(() =>
          cloneTaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1({
            ...authority,
            purpose: "different-purpose" as typeof authority.purpose,
          })
        ).toThrow();
        expect(() =>
          cloneTaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1({
            ...authority,
            claimExpiresAt: -1,
          })
        ).toThrow();
        expect(() =>
          cloneTaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1({
            ...authority,
            domains: [{
              ...authority.domains[0]!,
              keyClass: "human" as typeof authority.domains[0]["keyClass"],
            }],
          })
        ).toThrow();
        expect(() =>
          cloneTaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1({
            ...authority,
            envelopes: [{
              ...authority.envelopes[0]!,
              keyClass: "human" as typeof authority.envelopes[0]["keyClass"],
            }],
          })
        ).toThrow();
        expect(() =>
          cloneTaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1({
            ...authority,
            namespaces: [{
              ...first,
              audienceFingerprint: new Uint8Array(31),
            }],
          })
        ).toThrow();
      },
    );
  });

  test("matches every execution coordinate and the exact selected authority", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture(90_018);
    await fixture.withEvidence(
      new AbortController().signal,
      () => NOW,
      evidence => {
        const authority = fixture.prepare(evidence, [0, 2]).authority;
        expect(taskRuntimeAgentObjectAccessGenesisSetAuthorityMatchesEvidenceV1(
          authority,
          evidence,
        )).toBe(true);
        const variants = [
          { ...authority, requestId: `${authority.requestId}-other` },
          { ...authority, workId: `${authority.workId}-other` },
          { ...authority, claimId: `${authority.claimId}-other` },
          { ...authority, authorizationDigest: bytes(0xee) },
          { ...authority, claimExpiresAt: authority.claimExpiresAt + 1 },
          { ...authority, recipientExpiresAt: authority.recipientExpiresAt + 1 },
          { ...authority, expiresAt: authority.expiresAt + 1 },
          { ...authority, recipientGeneration: authority.recipientGeneration + 1 },
          { ...authority, recipientKeyId: `${authority.recipientKeyId}-other` },
          { ...authority, policyRevision: authority.policyRevision + 1 },
          { ...authority, episodeId: `${authority.episodeId}-other` },
          { ...authority, sourceRoomId: `${authority.sourceRoomId}-other` },
          {
            ...authority,
            hostAuthorizationRevision: authority.hostAuthorizationRevision + 1,
          },
          {
            ...authority,
            recipientAuthorizationRevision:
              authority.recipientAuthorizationRevision + 1,
          },
          { ...authority, taskId: `${authority.taskId}-other` },
          { ...authority, taskRunId: `${authority.taskRunId}-other` },
          { ...authority, agentId: agentId("substituted-authority-agent") },
        ];
        for (const variant of variants) {
          expect(taskRuntimeAgentObjectAccessGenesisSetAuthorityMatchesEvidenceV1(
            variant,
            evidence,
          )).toBe(false);
        }
        expect(taskRuntimeAgentObjectAccessGenesisSetAuthorityMatchesEvidenceV1(
          {
            ...authority,
            namespaces: authority.namespaces.map((entry, index) =>
              index === 0 ? { ...entry, operations: ["encrypt"] } : entry
            ),
          },
          evidence,
        )).toBe(false);
        expect(taskRuntimeAgentObjectAccessGenesisSetAuthorityMatchesEvidenceV1(
          {
            ...authority,
            domains: authority.domains.map((entry, index) =>
              index === 0 ? { ...entry, participantDigest: bytes(0xef) } : entry
            ),
          },
          evidence,
        )).toBe(false);
        expect(taskRuntimeAgentObjectAccessGenesisSetAuthorityMatchesEvidenceV1(
          {
            ...authority,
            domains: [
              ...authority.domains,
              fixture.domainFacts[0]!,
            ],
          },
          evidence,
        )).toBe(false);
      },
    );
  });

  test("detects mutation of every owned prepared evidence family", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture(90_019);
    await fixture.withEvidence(
      new AbortController().signal,
      () => NOW,
      evidence => {
        const prepared = fixture.prepare(evidence, [0, 1]);
        for (const value of [
          prepared.manifestBytes,
          prepared.manifestHash,
          prepared.envelopeBytes[0]!,
          prepared.authority.authorizationDigest,
          prepared.authority.envelopes[0]!.envelopeHash,
          prepared.authority.namespaces[0]!.audienceFingerprint,
          prepared.authority.domains[0]!.participantDigest,
        ]) {
          const original = value[0]!;
          value[0] = original ^ 0xff;
          expect(() =>
            assertAuthenticPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
              prepared,
            )
          ).toThrow();
          value[0] = original;
          expect(() =>
            assertAuthenticPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
              prepared,
            )
          ).not.toThrow();
        }
      },
    );
  });

  test("returns stale for current signer drift and for storage head drift", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture(90_004);
    await fixture.withEvidence(
      new AbortController().signal,
      () => NOW,
      async evidence => {
        const prepared = fixture.prepare(evidence, [0]);
        let signerCasCalls = 0;
        const signerStorage = storage({
          objectId: fixture.objectId,
          payloadBytes: fixture.payloadBytes,
          onCas: () => {
            signerCasCalls += 1;
          },
        });
        const current = fixture.currentAuthorization(signerStorage);
        expect(await persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: fixture.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: heldOwner({
            ...current,
            currentRuntime: {
              ...current.currentRuntime,
              runtimeGeneration: agentRuntimeGeneration(
                current.currentRuntime.runtimeGeneration + 1,
              ),
            },
          }),
        })).toBe("stale");
        expect(signerCasCalls).toBe(0);

        let headCasCalls = 0;
        const headStorage = storage({
          objectId: fixture.objectId,
          payloadBytes: fixture.payloadBytes,
          status: "stale",
          onCas: () => {
            headCasCalls += 1;
          },
        });
        expect(await persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: fixture.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: heldOwner(
            fixture.currentAuthorization(headStorage),
          ),
        })).toBe("stale");
        expect(headCasCalls).toBe(1);
      },
    );
  });

  test("rejects current Runtime identity and durable payload drift before CAS", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture(90_011);
    await fixture.withEvidence(
      new AbortController().signal,
      () => NOW,
      async evidence => {
        const prepared = fixture.prepare(evidence, [0]);
        for (const drift of ["agent", "authorization"] as const) {
          let casCalls = 0;
          const exactStorage = storage({
            objectId: fixture.objectId,
            payloadBytes: fixture.payloadBytes,
            onCas: () => {
              casCalls += 1;
            },
          });
          const current = fixture.currentAuthorization(exactStorage);
          const currentRuntime = drift === "agent"
            ? {
                ...current.currentRuntime,
                agentId: agentId("substituted-task-runtime-agent"),
              }
            : {
                ...current.currentRuntime,
                authorizationRevision: authorizationRevision(
                  current.currentRuntime.authorizationRevision + 1,
                ),
              };
          expect(await persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
            crypto: fixture.crypto,
            prepared,
            evidence,
            withCurrentAuthorization: heldOwner({
              ...current,
              currentRuntime,
            }),
          })).toBe("stale");
          expect(casCalls).toBe(0);
        }

        let payloadCasCalls = 0;
        expect(await persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: fixture.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: heldOwner(fixture.currentAuthorization(storage({
            objectId: fixture.objectId,
            payloadBytes: new Uint8Array(fixture.payloadBytes.length).fill(0xee),
            onCas: () => {
              payloadCasCalls += 1;
            },
          }))),
        })).toBe("stale");
        expect(payloadCasCalls).toBe(0);
      },
    );
  });

  test("rejects malformed current authority and invalid storage outcomes", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture(90_012);
    await fixture.withEvidence(
      new AbortController().signal,
      () => NOW,
      async evidence => {
        const prepared = fixture.prepare(evidence, [0]);
        const exact = fixture.currentAuthorization(storage({
          objectId: fixture.objectId,
          payloadBytes: fixture.payloadBytes,
        }));
        for (const malformed of [
          { ...exact, unexpected: true },
          { ...exact, storage: { ...exact.storage, getObject: undefined } },
          {
            ...exact,
            storage: {
              ...exact.storage,
              compareAndSwapObjectAccessState: undefined,
            },
          },
        ]) {
          expect(await persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
            crypto: fixture.crypto,
            prepared,
            evidence,
            withCurrentAuthorization: heldOwner(
              malformed as unknown as
                CurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorizationV1,
            ),
          })).toBe("stale");
        }

        const absentStorage: ObjectAccessStateCasStorageV2 = {
          getObject: async () => null,
          compareAndSwapObjectAccessState: async () => {
            throw new Error("CAS must not run without the exact payload");
          },
        };
        expect(await persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: fixture.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: heldOwner(
            fixture.currentAuthorization(absentStorage),
          ),
        })).toBe("stale");

        const invalidStatusStorage: ObjectAccessStateCasStorageV2 = {
          getObject: async objectId => ({
            objectId,
            payloadBytes: fixture.payloadBytes.slice(),
          }),
          compareAndSwapObjectAccessState: async authorized => {
            consumeAuthorizedObjectAccessWriteV2(authorized);
            return "invalid" as ObjectAccessStateCasStatusV2;
          },
        };
        const invalidStatus =
          persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
            crypto: fixture.crypto,
            prepared,
            evidence,
            withCurrentAuthorization: heldOwner(
              fixture.currentAuthorization(invalidStatusStorage),
            ),
          });
        expect(invalidStatus).rejects.toBeInstanceOf(
          ObjectAccessPersistenceOutcomeUnknownV2,
        );
        await invalidStatus.catch(() => undefined);
      },
    );
  });

  test("returns stale without reading or writing when authority is unavailable", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture(90_005);
    await fixture.withEvidence(
      new AbortController().signal,
      () => NOW,
      async evidence => {
        const prepared = fixture.prepare(evidence, [0]);
        let objectReads = 0;
        let casCalls = 0;
        const unusedStorage = storage({
          objectId: fixture.objectId,
          payloadBytes: fixture.payloadBytes,
          onObjectRead: () => {
            objectReads += 1;
          },
          onCas: () => {
            casCalls += 1;
          },
        });
        expect(await persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: fixture.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: async () => null,
        })).toBe("stale");
        expect(objectReads).toBe(0);
        expect(casCalls).toBe(0);
        void unusedStorage;
      },
    );
  });

  test("rejects manufactured owner results and a second callback use", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture(90_006);
    await fixture.withEvidence(
      new AbortController().signal,
      () => NOW,
      async evidence => {
        const prepared = fixture.prepare(evidence, [0]);
        const current = fixture.currentAuthorization(storage({
          objectId: fixture.objectId,
          payloadBytes: fixture.payloadBytes,
        }));
        expect(persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: fixture.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: async () => "applied",
        })).rejects.toThrow("manufactured result");
        expect(persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: fixture.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: async (_context, use) => {
            const first = await use(current);
            await use(current);
            return first;
          },
        })).rejects.toThrow("one-use");
        expect(persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: fixture.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: async (_context, use) => {
            expect(await use(current)).toBe("applied");
            return "duplicate";
          },
        })).rejects.toThrow("manufactured result");
      },
    );
  });

  test("rejects a callback used after its authority owner returns", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture(90_013);
    await fixture.withEvidence(
      new AbortController().signal,
      () => NOW,
      async evidence => {
        const prepared = fixture.prepare(evidence, [0]);
        const current = fixture.currentAuthorization(storage({
          objectId: fixture.objectId,
          payloadBytes: fixture.payloadBytes,
        }));
        let escaped: Promise<ObjectAccessStateCasStatusV2> | null = null;
        const result = persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: fixture.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: async (_context, use) => {
            escaped = Promise.resolve().then(() => use(current));
            void escaped.catch(() => undefined);
            return null;
          },
        });
        expect(result).rejects.toThrow("manufactured result");
        await result.catch(() => undefined);
        expect(escaped).not.toBeNull();
        expect(escaped!).rejects.toThrow("escaped its owner");
        await escaped!.catch(() => undefined);

        let releaseCas: ((status: ObjectAccessStateCasStatusV2) => void)
          | undefined;
        let markCasStarted: (() => void) | undefined;
        const casStarted = new Promise<void>(resolve => {
          markCasStarted = resolve;
        });
        const delayedCas = new Promise<ObjectAccessStateCasStatusV2>(resolve => {
          releaseCas = resolve;
        });
        const delayedStorage: ObjectAccessStateCasStorageV2 = {
          getObject: async objectId => ({
            objectId,
            payloadBytes: fixture.payloadBytes.slice(),
          }),
          compareAndSwapObjectAccessState: async authorized => {
            consumeAuthorizedObjectAccessWriteV2(authorized);
            markCasStarted?.();
            return delayedCas;
          },
        };
        let escapedAfterCas: Promise<ObjectAccessStateCasStatusV2> | null = null;
        const afterCas = persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: fixture.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: async (_context, use) => {
            escapedAfterCas = use(fixture.currentAuthorization(delayedStorage));
            void escapedAfterCas.catch(() => undefined);
            await casStarted;
            return null;
          },
        });
        await casStarted;
        releaseCas?.("applied");
        expect(afterCas).rejects.toThrow("manufactured result");
        await afterCas.catch(() => undefined);
        expect(escapedAfterCas).not.toBeNull();
        expect(escapedAfterCas!).rejects.toBeInstanceOf(
          ObjectAccessPersistenceOutcomeUnknownV2,
        );
        await escapedAfterCas!.catch(() => undefined);
      },
    );
  });

  test("expires at asynchronous edges and throws after CAS while authority is held", async () => {
    const before = await taskRuntimeAgentObjectSetFixture(90_007);
    const beforeController = new AbortController();
    await before.withEvidence(
      beforeController.signal,
      () => NOW,
      async evidence => {
        const prepared = before.prepare(evidence, [0]);
        let casCalls = 0;
        const current = before.currentAuthorization(storage({
          objectId: before.objectId,
          payloadBytes: before.payloadBytes,
          onCas: () => {
            casCalls += 1;
          },
        }));
        expect(persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: before.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: async (_context, use) => {
            beforeController.abort();
            return use(current);
          },
        })).rejects.toThrow("not active");
        expect(casCalls).toBe(0);
      },
    );

    const afterRead = await taskRuntimeAgentObjectSetFixture(90_008);
    const readController = new AbortController();
    await afterRead.withEvidence(
      readController.signal,
      () => NOW,
      async evidence => {
        const prepared = afterRead.prepare(evidence, [0]);
        let casCalls = 0;
        const current = afterRead.currentAuthorization(storage({
          objectId: afterRead.objectId,
          payloadBytes: afterRead.payloadBytes,
          beforeObjectReturn: () => readController.abort(),
          onCas: () => {
            casCalls += 1;
          },
        }));
        expect(persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: afterRead.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: heldOwner(current),
        })).rejects.toThrow("not active");
        expect(casCalls).toBe(0);
      },
    );

    const afterCas = await taskRuntimeAgentObjectSetFixture(90_009);
    const casController = new AbortController();
    await afterCas.withEvidence(
      casController.signal,
      () => NOW,
      async evidence => {
        const prepared = afterCas.prepare(evidence, [0]);
        let authorityHeld = false;
        let failureObservedWhileHeld = false;
        const current = afterCas.currentAuthorization(storage({
          objectId: afterCas.objectId,
          payloadBytes: afterCas.payloadBytes,
          beforeCasReturn: () => casController.abort(),
        }));
        const result = persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: afterCas.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: async (_context, use) => {
            authorityHeld = true;
            try {
              return await use(current);
            } catch (error) {
              failureObservedWhileHeld = authorityHeld;
              throw error;
            } finally {
              authorityHeld = false;
            }
          },
        });
        expect(result).rejects.toBeInstanceOf(
          ObjectAccessPersistenceOutcomeUnknownV2,
        );
        await result.catch(() => undefined);
        expect(failureObservedWhileHeld).toBe(true);
      },
    );
  });

  test("records only the exact selected Domains in the durable expectation", async () => {
    const fixture = await taskRuntimeAgentObjectSetFixture(90_010);
    await fixture.withEvidence(
      new AbortController().signal,
      () => NOW,
      async evidence => {
        const prepared = fixture.prepare(evidence, [0, 1]);
        const observed: ObjectAccessAuthorizationExpectationV2[] = [];
        const exactStorage = storage({
          objectId: fixture.objectId,
          payloadBytes: fixture.payloadBytes,
          inspectAuthorization: authorization => {
            observed.push(authorization);
          },
        });
        expect(await persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1({
          crypto: fixture.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: heldOwner(
            fixture.currentAuthorization(exactStorage),
          ),
        })).toBe("applied");
        const authorization = observed[0];
        if (authorization?.kind !== "task-runtime-agent-genesis-set") {
          throw new Error("expected Task Runtime Agent authorization");
        }
        expect(() => assertObjectAccessAuthorizationExpectation({
          ...authorization,
          context: {
            ...authorization.context,
            domains: [
              ...authorization.context.domains,
              fixture.domainFacts[1]!,
            ],
          },
        })).toThrow("Domain set is not exact");
      },
    );
  });
});
