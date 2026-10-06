import { describe, expect, test } from "bun:test";
import {
  authorizationRevision,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import { decodeNamespaceObjectEnvelopeV2 } from
  "@nautilo/lattice-crypto/wire";

import { taskRuntimeAgentObjectSetFixture } from
  "../../../lattice-crypto/tests/helpers/task-runtime-agent-object-set-fixture.ts";
import {
  MEMORY_OBJECT_TYPE,
  deriveMemoryCryptoObjectIdV1,
} from "../../src/memory/memory-repository.ts";
import type { VerifiedAgentObject } from
  "../../src/object/agent-object-protector.ts";
import { readPreparedTaskRuntimeAgentObjectSnapshot } from
  "../../src/object/task-runtime-agent-object-crypto.ts";
import { createTaskRuntimeAgentObjectRepairer } from
  "../../src/object/task-runtime-agent-object-repair.ts";

const MEMORY_ID = "21000000-0000-4000-8000-000000000001";
const NOW = 2_200_000_000_000;

describe("Task Runtime Agent object repair", () => {
  test("forwards exact Memory coordinates and resists request mutation across awaits", async () => {
    const base = await taskRuntimeAgentObjectSetFixture(92_501);
    const controller = new AbortController();
    await base.withEvidence(controller.signal, () => NOW, async evidence => {
      const selected = base.nativeNamespaces[0]!;
      const namespaceKey = new Uint8Array(32).fill(0x71);
      const authority = Object.freeze({
        namespaceId: selected.namespaceId,
        namespaceAccessRevision: selected.accessRevision,
        namespaceKeyGeneration: selected.keyGeneration,
        domainId: selected.domainId,
        domainKeyGeneration: selected.domainKeyGeneration,
        domainAuthorizationRevision: selected.domainAuthorizationRevision,
        domainHeadDigest: selected.domainHeadDigest,
        namespaceHeadDigest: selected.headDigest,
        namespacePublicationDigest: selected.publicationDigest,
        namespacePublicationSetDigest: selected.publicationSetDigest,
        namespaceAudienceFingerprint: selected.audienceFingerprint,
      });
      let durable: VerifiedAgentObject | null = null;
      let firstRead = true;
      let releaseRead: (() => void) | undefined;
      const readGate = new Promise<void>(resolve => {
        releaseRead = resolve;
      });
      const persisted: Readonly<{
        memoryId: string;
        contentRevision: number;
        operationId: string;
        evidence: unknown;
      }>[] = [];
      const service = createTaskRuntimeAgentObjectRepairer({
        crypto: base.crypto,
        evidence,
        entities: {
          signal: controller.signal,
          useCurrentSet: async request => ({
            status: "executed" as const,
            value: await request.execute([{ namespaceKey, authority }]),
          }),
          use: async request => ({
            status: "executed" as const,
            value: await request.execute({ namespaceKey, authority }),
          }),
        },
        runtime: base.initialized.runtime,
        signerPublication: base.initialized.signerPublication,
        resolveHistoricalSignerPublicationManager: () => base.manager.publicKey,
        agentAuthorizationRevision: authorizationRevision(7),
        persist: async request => {
          persisted.push(Object.freeze({
            memoryId: request.memoryId,
            contentRevision: request.contentRevision,
            operationId: request.operationId,
            evidence: request.evidence,
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
      const objectId = deriveMemoryCryptoObjectIdV1({
        memoryId: MEMORY_ID,
        contentRevision: 1,
      });
      const plaintext = new TextEncoder().encode("Task Memory content");
      const request = {
        memoryId: MEMORY_ID,
        contentRevision: 1,
        operationId: "task-memory-operation",
        source: {
          objectId,
          objectType: MEMORY_OBJECT_TYPE,
          existingObjectId: null,
          expectedAccessRevision: 0,
          createdAt: NOW,
          namespaceIds: [selected.namespaceId],
          plaintextBytes: plaintext,
        },
        decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
      };
      const protection = service.protect(request);
      request.memoryId = "21000000-0000-4000-8000-000000000099";
      request.contentRevision = 99;
      request.operationId = "mutated-operation";
      request.source.objectId = "mutated-object";
      (request.source.namespaceIds as unknown as string[])[0] =
        "mutated-namespace";
      request.source.plaintextBytes.fill(0x7f);
      releaseRead?.();
      expect(await protection).toEqual({
        status: "verified",
        objectId,
        provenance: "repaired",
        verification: "authenticated",
        value: "Task Memory content",
      });
      expect(persisted).toEqual([{
        memoryId: MEMORY_ID,
        contentRevision: 1,
        operationId: "task-memory-operation",
        evidence,
      }]);
      expect(plaintext.every(byte => byte === 0x7f)).toBeTrue();

      expect(await service.protect({
        ...request,
        memoryId: MEMORY_ID,
        contentRevision: 1,
        operationId: "wrong-coordinate",
        source: {
          ...request.source,
          objectId: "wrong-object",
          namespaceIds: [selected.namespaceId],
          plaintextBytes: new TextEncoder().encode("wrong"),
        },
      })).toEqual({
        status: "failed",
        reason: "entity_coordinate_invalid",
      });
      expect(persisted).toHaveLength(1);

      controller.abort();
      expect(await service.protect({
        memoryId: MEMORY_ID,
        contentRevision: 1,
        operationId: "closed-operation",
        source: {
          objectId,
          objectType: MEMORY_OBJECT_TYPE,
          existingObjectId: objectId,
          expectedAccessRevision: 0,
          createdAt: 0,
          namespaceIds: [selected.namespaceId],
          plaintextBytes: null,
        },
        decode: bytes => new TextDecoder().decode(bytes),
      })).toEqual({
        status: "waiting_for_authority",
        reason: "authorization_cancelled",
      });
    });
  });

  test("requires genuine evidence for the same Agent", async () => {
    const base = await taskRuntimeAgentObjectSetFixture(92_502);
    expect(() => createTaskRuntimeAgentObjectRepairer({
      crypto: base.crypto,
      evidence: base.evidence as unknown as TaskRuntimeExecutionEvidence,
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
  });
});
