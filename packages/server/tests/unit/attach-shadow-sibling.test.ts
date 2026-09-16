import {describe, expect, test} from "bun:test";
import type {DurableRecordPublication} from "@nautilo/reflection/durable";
import {createHmacRecordRequestCommitmentPort, type PostgresRecordProductStore} from "@nautilo/reflection-bridge/server";

import {attachReflectionShadowSibling} from "../../src/reflection/attach-shadow-sibling";

const publication: DurableRecordPublication = {
  record: {
    recordRef: "record:shadow",
    lifecycle: "current",
    structuralHeight: 0,
    processingGeneration: 1,
    semantic: {
      posture: "derived",
      statement: "The release is Tuesday.",
      observedContentFingerprint: "fingerprint:shadow",
      childRecordRefs: [],
      sourceDependencies: [],
      anchors: [{kind: "room", anchorRef: "room:one", role: "origin"}],
      terminalAuthorityLeafHandles: ["namespace:one"],
      producer: {producerRef: "organizer", policyVersion: "candidate-policy-v1"},
    },
  },
  idempotencyKey: "sleep:shadow:1",
  publicationBindingRef: "binding:protected",
};

describe("Reflection Shadow ordinary sibling attachment", () => {
  test("derives the same distinct sibling identity and commitment on replay", async () => {
    type Attachment = Parameters<PostgresRecordProductStore["attachOrdinarySibling"]>[0];
    const calls: Attachment[] = [];
    const outcomes = ["attached", "replayed"] as const;
    const product = {async attachOrdinarySibling(value: Attachment) {
      calls.push({...value, ordinaryRequestCommitment: value.ordinaryRequestCommitment.slice()});
      return outcomes[calls.length - 1]!;
    }};
    const plaintext = new Uint8Array([1, 2, 3, 4]);
    const protectedRequestCommitment = new Uint8Array(32).fill(7);
    const commitmentKey = new Uint8Array(32).fill(9);
    const publicationBefore = structuredClone(publication);
    const plaintextBefore = plaintext.slice();
    const keyBefore = commitmentKey.slice();

    await attachReflectionShadowSibling({product, publication, protectedRequestCommitment,
      plaintext, commitmentKey});
    await attachReflectionShadowSibling({product, publication, protectedRequestCommitment,
      plaintext, commitmentKey});

    expect(calls).toHaveLength(2);
    expect(calls[0]!.ordinaryPublication.idempotencyKey).toMatch(/^reflection-shadow:[0-9a-f]{64}$/u);
    expect(calls[0]!.ordinaryPublication.idempotencyKey).not.toBe(publication.idempotencyKey);
    expect(calls[0]!.ordinaryPublication.idempotencyKey).toBe(calls[1]!.ordinaryPublication.idempotencyKey);
    expect(calls[0]!.protectedPublicationId).toBe(publication.idempotencyKey);
    expect(calls[0]!.protectedRequestCommitment).toBe(protectedRequestCommitment);
    expect(calls[0]!.ordinaryPayloadBytes).toBe(plaintext);
    expect(calls[0]!.ordinaryRequestCommitment).toEqual(calls[1]!.ordinaryRequestCommitment);
    const expected = createHmacRecordRequestCommitmentPort(commitmentKey)
      .commit(plaintext, calls[0]!.ordinaryPublication);
    expect(calls[0]!.ordinaryRequestCommitment).toEqual(expected);
    expected.fill(0);
    expect(publication).toEqual(publicationBefore);
    expect(plaintext).toEqual(plaintextBefore);
    expect(commitmentKey).toEqual(keyBefore);
  });

  test.each(["blocked", "conflict"] as const)("rejects a %s product result without mutating borrowed bytes", async outcome => {
    const plaintext = new Uint8Array([5, 6, 7]);
    const protectedRequestCommitment = new Uint8Array(32).fill(2);
    const commitmentKey = new Uint8Array(32).fill(4);
    const before = plaintext.slice();
    const product = {attachOrdinarySibling: async () => outcome};
    expect(attachReflectionShadowSibling({product, publication, protectedRequestCommitment,
      plaintext, commitmentKey})).rejects.toThrow("ordinary sibling did not attach");
    await Promise.resolve();
    expect(plaintext).toEqual(before);
  });
});
