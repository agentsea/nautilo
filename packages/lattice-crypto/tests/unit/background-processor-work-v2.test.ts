import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "../../src/crypto/index.ts";
import {
  MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  backgroundWorkDescriptorDigestV2,
  decodeBackgroundProcessorWorkDescriptorV2,
  encodeBackgroundWorkDescriptorV2,
  type BackgroundProcessorWorkDescriptorV2,
} from "../../src/background/work-descriptor-v2.ts";
import { backgroundProcessorWorkV2Fixture } from "../helpers/background-work-v2-fixture.ts";

describe("current named Stenographer descriptor", () => {
  const crypto = new LatticeCrypto();
  const fixture = () => backgroundProcessorWorkV2Fixture(new Uint8Array(65).fill(7));

  test("round trips exact source, outputs and current Domain/Namespace authority", () => {
    const value = fixture();
    const bytes = encodeBackgroundWorkDescriptorV2(value);
    const decoded = decodeBackgroundProcessorWorkDescriptorV2(bytes);
    expect(decoded).toEqual(value);
    expect(encodeBackgroundWorkDescriptorV2(decoded)).toEqual(bytes);
    decoded.authority.domainHeadDigest.fill(0);
    decoded.recipientPublicKey.fill(0);
    expect(decodeBackgroundProcessorWorkDescriptorV2(bytes)).toEqual(value);
  });

  test("all current authority and recipient coordinates change the signed digest", () => {
    const value = fixture();
    const digest = backgroundWorkDescriptorDigestV2(crypto, value);
    const alternatives: BackgroundProcessorWorkDescriptorV2[] = [
      {...value, policyRevision: value.policyRevision + 1},
      {...value, recipientGeneration: value.recipientGeneration + 1},
      {...value, inputBindings: [...value.inputBindings].reverse()},
      {...value, outputSlots: [{...value.outputSlots[0]!, objectId: "other-record"}]},
    ];
    for (const [key, item] of Object.entries(value.authority)) {
      const changed = item instanceof Uint8Array ? item.map((byte) => byte ^ 1)
        : typeof item === "number" ? item + 1 : `${item}-other`;
      if (key === "namespaceId" || key === "domainId") continue;
      alternatives.push({...value, authority: {...value.authority, [key]: changed}});
    }
    for (const alternative of alternatives) {
      expect(backgroundWorkDescriptorDigestV2(crypto, alternative)).not.toEqual(digest);
    }
  });

  test("rejects legacy roots, extra authority, unsupported subjects and dishonest output slots", () => {
    const value = fixture();
    for (const invalid of [
      {...value, formatVersion: 1}, {...value, formatVersion: 3},
      {...value, subject: {...value.subject, processorKind: "reflection"}},
      {...value, subject: {...value.subject, processorVersion: 2}}, {...value, purpose: "journal.compact"},
      {...value, authority: {...value.authority, aiRoot: new Uint8Array(32)}},
      {...value, processorAuthorizationRevision: 1},
      {...value, anchorNamespaceId: "foreign-namespace"},
      {...value, authority: {...value.authority, domainId: "foreign-domain"}},
      {...value, inputBindings: [{...value.inputBindings[0]!, namespaceId: "foreign-namespace"}]},
      {...value, outputSlots: [{...value.outputSlots[0]!, namespaceIds: ["foreign-namespace"]}]},
      {...value, outputSlots: [{...value.outputSlots[0]!, namespaceIds: [value.anchorNamespaceId, "foreign-namespace"]}]},
      {...value, operations: ["decrypt"]},
      {...value, outputSlots: [{...value.outputSlots[0]!, objectId: value.inputBindings[0]?.objectId}]},
      {...value, outputSlots: [{...value.outputSlots[0]!, objectType: "memory"}]},
      {...value, inputBindings: ["same", "same"].map(objectId => ({objectId, namespaceId: "namespace-1"}))},
      {...value, expiresAt: value.expiresAt + 1},
    ]) {
      expect(() => encodeBackgroundWorkDescriptorV2(invalid as BackgroundProcessorWorkDescriptorV2)).toThrow();
    }
  });

  test("admits the complete supported shape without truncation within durable wire capacity", () => {
    const value = fixture();
    const id = (label: string) => label.padEnd(128, "x");
    const maximum: BackgroundProcessorWorkDescriptorV2 = {
      ...value, requestId: id("request"), workId: id("work"),
      anchorNamespaceId: id("namespace"), anchorDomainId: id("domain"),
      recipientKeyId: id("recipient"), idempotencyId: id("idempotency"),
      authority: {...value.authority, serverId: id("server"), roomId: id("room"),
        namespaceId: id("namespace"), domainId: id("domain")},
      inputBindings: Array.from({length: 256}, (_, index) => ({objectId: id(`input-${index}`), namespaceId: id("namespace")})),
      outputSlots: Array.from({length: 5}, (_, index) => ({...value.outputSlots[0]!, objectId: id(`output-${index}`), namespaceIds: [id("namespace")]})),
    };
    const bytes = encodeBackgroundWorkDescriptorV2(maximum);
    expect(bytes.length).toBeLessThanOrEqual(MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2);
    // Existing durable request envelope; no ledger capacity widening is needed.
    expect(MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2).toBeLessThanOrEqual(128 * 1_024);
    expect(decodeBackgroundProcessorWorkDescriptorV2(bytes)).toEqual(maximum);
  });

  test("rejects truncation, trailing bytes and overlong input before decoding", () => {
    const bytes = encodeBackgroundWorkDescriptorV2(fixture());
    expect(() => decodeBackgroundProcessorWorkDescriptorV2(bytes.slice(0, -1))).toThrow();
    expect(() => decodeBackgroundProcessorWorkDescriptorV2(Uint8Array.from([...bytes, 0]))).toThrow();
    expect(() => decodeBackgroundProcessorWorkDescriptorV2(new Uint8Array(MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2 + 1))).toThrow();
  });
});
