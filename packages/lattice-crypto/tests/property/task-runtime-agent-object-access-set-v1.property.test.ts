import { describe, expect, test } from "bun:test";

import {
  prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1,
} from "../../src/object/task-runtime-agent-access-manifest-set-v1.ts";
import { decodeNamespaceObjectEnvelopeV2 } from
  "../../src/format/object-v2.ts";
import {
  NOW,
  taskRuntimeAgentObjectSetFixture,
} from "../helpers/task-runtime-agent-object-set-fixture.ts";

describe("Task Runtime Agent Namespace subset recorded properties", () => {
  test("projects every canonical subset to exactly its used Domains", async () => {
    for (let seed = 1; seed <= 7; seed += 1) {
      const fixture = await taskRuntimeAgentObjectSetFixture(91_000 + seed);
      await fixture.withEvidence(
        new AbortController().signal,
        () => NOW,
        (evidence) => {
          const selectedIndexes = [0, 1, 2].filter((index) =>
            ((seed & (1 << index)) !== 0)
          );
          const prepared = fixture.prepare(evidence, selectedIndexes);
          expect(prepared.authority.namespaces.map((entry) => entry.namespaceId))
            .toEqual(selectedIndexes.map((index) =>
              fixture.namespaceFacts[index]!.namespaceId
            ));
          expect(prepared.authority.domains.map((entry) => entry.domainId))
            .toEqual([...new Set(selectedIndexes.map((index) =>
              fixture.namespaceFacts[index]!.domain.domainId
            ))].sort());
          expect(prepared.authority.namespaces.map((entry) => entry.operations))
            .toEqual(selectedIndexes.map((index) =>
              fixture.evidence.namespaceRequirements[index]!.operations
            ));
          expect(prepared.authority).toMatchObject({
            objectId: fixture.objectId,
            operationId: `task-object-write-${91_000 + seed}`,
            requestId: evidence.requestId,
            workId: evidence.workId,
            claimId: evidence.claimId,
            claimExpiresAt: evidence.claimExpiresAt,
            recipientExpiresAt: evidence.recipientExpiresAt,
            expiresAt: evidence.expiresAt,
            recipientGeneration: evidence.recipientGeneration,
            recipientKeyId: evidence.recipientKeyId,
            policyRevision: evidence.policyRevision,
            episodeId: evidence.episodeId,
            sourceRoomId: evidence.sourceRoomId,
            hostAuthorizationRevision: evidence.hostAuthorizationRevision,
            recipientAuthorizationRevision:
              evidence.recipientAuthorizationRevision,
            taskId: evidence.result.taskId,
            taskRunId: evidence.result.taskRunId,
            agentId: evidence.result.signerAgentId,
            agentAuthorizationRevision:
              fixture.initialized.signerPublication.authorizationRevision,
            runtimeGeneration: fixture.initialized.runtime.generation,
            signerKeyId: fixture.initialized.signerPublication.signerKeyId,
          });
          expect(prepared.authority.payloadHash).toEqual(
            fixture.crypto.hash(fixture.payloadBytes),
          );
          expect(prepared.authority.authorizationDigest).toEqual(
            evidence.authorizationDigest,
          );
          expect(prepared.authority.namespaces).toEqual(
            selectedIndexes.map(index => ({
              ...fixture.nativeNamespaces[index]!,
              operations:
                fixture.evidence.namespaceRequirements[index]!.operations,
              expectedPolicyRevision: evidence.policyRevision,
            })),
          );
          const selectedDomainIds = new Set(selectedIndexes.map(index =>
            fixture.namespaceFacts[index]!.domain.domainId
          ));
          expect(prepared.authority.domains).toEqual(
            fixture.domainFacts.filter(entry => selectedDomainIds.has(entry.domainId)),
          );
          const envelopeContexts = prepared.envelopeBytes.map(bytes =>
            decodeNamespaceObjectEnvelopeV2(bytes).context
          );
          expect(envelopeContexts.map(entry => entry.namespaceId)).toEqual(
            selectedIndexes.map(index =>
              fixture.namespaceFacts[index]!.namespaceId
            ),
          );
          const envelopeCoordinates = envelopeContexts.map(entry => [
            String(entry.objectId),
            String(entry.namespaceId),
            String(entry.keyClass),
            Number(entry.keyGeneration),
            Number(entry.bindingRevisionAtWrap),
          ]);
          expect(envelopeCoordinates).toEqual(
            prepared.authority.envelopes.map(entry => [
              String(entry.objectId),
              String(entry.namespaceId),
              String(entry.keyClass),
              Number(entry.keyGeneration),
              Number(entry.bindingRevisionAtWrap),
            ]),
          );
          expect(prepared.authority.envelopes.map(entry => entry.envelopeHash))
            .toEqual(prepared.envelopeBytes.map(bytes => fixture.crypto.hash(bytes)));
          expect(prepared.manifest).toMatchObject({
            objectId: fixture.objectId,
            payloadHash: prepared.authority.payloadHash,
            accessRevision: 0,
            previousManifestHash: null,
            signer: {
              kind: "agent_runtime",
              agentId: fixture.initialized.runtime.agentId,
              runtimeGeneration: fixture.initialized.runtime.generation,
              signerKeyId: fixture.initialized.signerPublication.signerKeyId,
            },
            signerAuthorizationHash: null,
            hostAuthorizationRevision:
              fixture.initialized.signerPublication.authorizationRevision,
          });
          const hex = (value: Uint8Array): string =>
            Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
          expect(prepared.manifest.envelopeHashes.map(hex).sort()).toEqual(
            prepared.authority.envelopes.map(entry =>
              hex(entry.envelopeHash)
            ).sort(),
          );

          const first = selectedIndexes[0]!;
          const duplicateInput = fixture.prepareInput(evidence, [first, first]);
          expect(() =>
            prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
              fixture.crypto,
              duplicateInput,
            )
          ).toThrow("not canonical");
          const widened = fixture.prepareInput(evidence, [first]);
          expect(() =>
            prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
              fixture.crypto,
              {
                ...widened,
                namespaces: [{
                  ...widened.namespaces[0]!,
                  namespaceId: `${widened.namespaces[0]!.namespaceId}-extra`,
                }],
              },
            )
          ).toThrow("authority was substituted");
          if (selectedIndexes.length > 1) {
            const permuted = [...selectedIndexes].reverse();
            expect(() => fixture.prepare(evidence, permuted))
              .toThrow("not canonical");
          }
        },
      );
    }
  });
});
