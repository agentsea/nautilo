import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import {
  MODEL_INPUT_EXPOSURE_METADATA_KEY,
  bindModelInputExposure,
  bindModelInputExposureFromAuthorizedPersistedPayload,
  copyModelInputExposure,
  declareModelInputExposureProducer,
  encodeModelInputExposureForMetadata,
  getAuthoredModelInputExposure,
  iterateWithAuthoredModelInputExposure,
  readDeclaredModelInputExposureProducer,
  readModelInputExposure,
  unionModelInputExposures,
  type DurableModelExposureDependency,
} from "../../src/memory/model-input-exposure";
import { createGetCurrentTimeTool } from
  "../../src/tools/time/get-current-time";

const source: DurableModelExposureDependency = Object.freeze({
  kind: "source",
  sourceKind: "message",
  logicalSourceRef: "message:17",
  observedRevision: "0",
  observedContentFingerprint: "sha256:abc",
  terminalAuthorityLeafHandle: "namespace:one",
});

describe("model input exposure", () => {
  test("trusts only process-bound evidence and copies it across exact clones", () => {
    const untrusted = new HumanMessage({
      content: "hello",
      additional_kwargs: {
        [MODEL_INPUT_EXPOSURE_METADATA_KEY]: {
          version: 1,
          status: "complete",
          dependencies: [],
        },
      },
    });
    expect(readModelInputExposure(untrusted)).toBeUndefined();

    bindModelInputExposure(untrusted, {
      status: "complete",
      dependencies: [source],
    });
    const clone = copyModelInputExposure(
      untrusted,
      new HumanMessage("hello"),
    );
    expect(readModelInputExposure(clone)).toEqual({
      status: "complete",
      dependencies: [source],
    });
  });

  test("unions exact dependencies and fails closed on missing evidence", () => {
    const first = bindModelInputExposure(new HumanMessage("one"), {
      status: "complete",
      dependencies: [source],
    });
    const second = bindModelInputExposure(new HumanMessage("two"), {
      status: "complete",
      dependencies: [],
    });
    expect(unionModelInputExposures([first, second])).toEqual({
      status: "complete",
      dependencies: [source],
    });
    expect(unionModelInputExposures([first, new HumanMessage("unknown")]))
      .toEqual({ status: "incomplete" });
  });

  test("collapses identical historical inputs also retained by an AI row", () => {
    const direct = bindModelInputExposure(new HumanMessage("prior Human"), {
      status: "complete", dependencies: [source],
    });
    const derived = bindModelInputExposure(new HumanMessage("derived reply"), {
      status: "complete", dependencies: [{ ...source }],
    });
    expect(unionModelInputExposures([direct, derived])).toEqual({
      status: "complete", dependencies: [source],
    });
    const record = {
      kind: "record" as const, recordRef: "record:one", observedProcessingGeneration: 1,
      terminalAuthorityLeafHandles: ["namespace:two", "namespace:one"],
    };
    const first = bindModelInputExposure({}, { status: "complete", dependencies: [record] });
    const second = bindModelInputExposure({}, {
      status: "complete", dependencies: [{ ...record, terminalAuthorityLeafHandles: [...record.terminalAuthorityLeafHandles].reverse() }],
    });
    expect(unionModelInputExposures([first, second])).toEqual({
      status: "complete", dependencies: [{ ...record, terminalAuthorityLeafHandles: ["namespace:one", "namespace:two"] }],
    });
  });

  test("conflicting observations remain incomplete without breaking chat", () => {
    const first = bindModelInputExposure({}, { status: "complete", dependencies: [source] });
    const second = bindModelInputExposure({}, {
      status: "complete", dependencies: [{ ...source, observedRevision: "1" }],
    });
    expect(unionModelInputExposures([first, second])).toEqual({ status: "incomplete" });
  });

  test("round trips strict durable metadata only through the authorized parser", () => {
    const original = bindModelInputExposure(new HumanMessage("hello"), {
      status: "complete",
      dependencies: [source],
    });
    const encoded = encodeModelInputExposureForMetadata(original);
    const reopened = new HumanMessage("hello");
    expect(bindModelInputExposureFromAuthorizedPersistedPayload(
      reopened,
      encoded,
    )).toBeTrue();
    expect(readModelInputExposure(reopened)).toEqual({
      status: "complete",
      dependencies: [source],
    });
    expect(bindModelInputExposureFromAuthorizedPersistedPayload(reopened, {
      ...(encoded as Record<string, unknown>),
      extra: true,
    })).toBeFalse();
  });

  test("keeps exact producer declarations outside model-visible metadata", () => {
    const producer = declareModelInputExposureProducer({}, {
      status: "complete",
      dependencies: [],
    });
    expect(readDeclaredModelInputExposureProducer(producer)).toEqual({
      status: "complete",
      dependencies: [],
    });
    expect(Object.keys(producer)).toEqual([]);
  });

  test("keeps authored evidence around every lazy iterator step", async () => {
    const observed: Array<unknown> = [];
    async function* iterableSource() {
      observed.push(getAuthoredModelInputExposure());
      yield "first";
      await Promise.resolve();
      observed.push(getAuthoredModelInputExposure());
      yield "second";
    }
    const values: string[] = [];
    for await (const value of iterateWithAuthoredModelInputExposure(
      { status: "complete", dependencies: [source] },
      iterableSource(),
    )) values.push(value);
    expect(values).toEqual(["first", "second"]);
    expect(observed).toEqual([
      { status: "complete", dependencies: [source] },
      { status: "complete", dependencies: [source] },
    ]);
    expect(getAuthoredModelInputExposure()).toBeUndefined();
  });

  test("declares only the exact current-time producer as source-free", () => {
    expect(readDeclaredModelInputExposureProducer(
      createGetCurrentTimeTool({ userTimezone: "UTC" }),
    )).toEqual({ status: "complete", dependencies: [] });
  });
});
