import { describe, expect, test } from "bun:test";
import {
  RecordPayloadCodecError as PureRecordPayloadCodecError,
  decodeRecordPayloadV1 as decodePureRecordPayloadV1,
  encodeRecordPayloadV1 as encodePureRecordPayloadV1,
} from "@nautilo/reflection/payload";

import {
  RecordPayloadCodecError as BridgeRecordPayloadCodecError,
  decodeRecordPayloadV1 as decodeBridgeRecordPayloadV1,
  encodeRecordPayloadV1 as encodeBridgeRecordPayloadV1,
} from "../../src/record-payload-v1";

describe("RecordPayloadV1 codec relocation", () => {
  test("keeps bridge exports bound to the one pure codec implementation", () => {
    expect(BridgeRecordPayloadCodecError).toBe(PureRecordPayloadCodecError);
    expect(decodeBridgeRecordPayloadV1).toBe(decodePureRecordPayloadV1);
    expect(encodeBridgeRecordPayloadV1).toBe(encodePureRecordPayloadV1);

    const payload = {
      formatVersion: 1,
      posture: "derived",
      observedContentFingerprint: "fingerprint:one",
      sourceOwnedKind: null,
      observedLogicalObjectRef: null,
      observedRevision: null,
      statement: "One canonical Record.",
      sourceDependencies: [],
      anchors: [{ kind: "room", anchorRef: "room:one", role: "origin" }],
      childRecordIds: [],
      producer: { producerRef: "reflection", policyVersion: "policy:v1" },
      terminalAuthorityLeafHandles: ["authority:one"],
    };
    const bytes = encodePureRecordPayloadV1(payload);
    expect(encodeBridgeRecordPayloadV1(payload)).toEqual(bytes);
    expect(decodeBridgeRecordPayloadV1(bytes)).toEqual(
      decodePureRecordPayloadV1(bytes),
    );
  });

  test("preserves codec error constructor identity across both import paths", () => {
    try {
      decodeBridgeRecordPayloadV1(new TextEncoder().encode("{}"));
      throw new Error("expected RecordPayloadV1 rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PureRecordPayloadCodecError);
      expect(error).toBeInstanceOf(BridgeRecordPayloadCodecError);
    }
  });
});
