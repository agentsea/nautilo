import { describe, expect, test } from "bun:test";
import { parseModelInputExposureMetadataV1 } from "../../src/payload";

describe("model-input exposure metadata v1", () => {
  test("accepts the two exact closed variants and normalizes dependencies", () => {
    expect(parseModelInputExposureMetadataV1({
      version: 1,
      status: "incomplete",
    })).toEqual({ version: 1, status: "incomplete" });

    expect(parseModelInputExposureMetadataV1({
      version: 1,
      status: "complete",
      dependencies: [{
        kind: "record",
        recordId: "record-b",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["leaf-b", "leaf-a"],
      }, {
        kind: "record",
        recordId: "record-a",
        observedProcessingGeneration: 2,
        terminalAuthorityLeafHandles: ["leaf-c"],
      }],
    })).toEqual({
      version: 1,
      status: "complete",
      dependencies: [{
        kind: "record",
        recordId: "record-a",
        observedProcessingGeneration: 2,
        terminalAuthorityLeafHandles: ["leaf-c"],
      }, {
        kind: "record",
        recordId: "record-b",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["leaf-a", "leaf-b"],
      }],
    });
  });

  test("rejects unknown fields, malformed dependencies, and oversized metadata", () => {
    expect(parseModelInputExposureMetadataV1({
      version: 1,
      status: "incomplete",
      extra: true,
    })).toBeNull();
    expect(parseModelInputExposureMetadataV1({
      version: 1,
      status: "complete",
      dependencies: [{ kind: "record", recordId: "record-a" }],
    })).toBeNull();
    expect(parseModelInputExposureMetadataV1({
      version: 1,
      status: "complete",
      dependencies: Array.from({ length: 4_000 }, (_, index) => ({
        kind: "record",
        recordId: `record-${index}`,
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: [`leaf-${index}`],
      })),
    })).toBeNull();
  });
});
