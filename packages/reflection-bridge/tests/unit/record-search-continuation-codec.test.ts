import { describe, expect, test } from "bun:test";

import {
  RECORD_SEARCH_POLICY_V1,
  type RecordEvidenceContinuationStateV1,
  type RecordSearchContinuationStateV1,
} from "@nautilo/reflection/search";

import { createRecordSearchContinuationCodec } from "../../src/server/record-search-continuation-codec";

const searchState: RecordSearchContinuationStateV1 = {
  version: 1,
  policyVersion: 1,
  queryCommitment: "query",
  invocationAudienceCommitment: "audience",
  repositorySelectionCommitment: "repository",
  corpusStateCommitment: "corpus",
  lastEligiblePosition: {
    recordRef: "record-one",
    score: 0.5,
    structuralHeight: 2,
  },
};

const evidenceState: RecordEvidenceContinuationStateV1 = {
  version: 1,
  policyVersion: 1,
  rootCommitment: "root",
  invocationAudienceCommitment: "audience",
  repositorySelectionCommitment: "repository",
  graphStateCommitment: "graph",
  traversalCheckpointRef: "checkpoint",
};

describe("Record search continuation codec", () => {
  test("authenticates search state and rejects tampering", () => {
    const codec = createRecordSearchContinuationCodec(new Uint8Array(32).fill(0x41));
    const token = codec.authenticateSearch(searchState);
    expect(codec.verifySearch(token)).toEqual(searchState);
    const replacement = token.endsWith("A") ? "B" : "A";
    expect(() => codec.verifySearch(`${token.slice(0, -1)}${replacement}`)).toThrow(
      "Record search continuation is invalid",
    );
    expect(Buffer.byteLength(token)).toBeLessThanOrEqual(
      RECORD_SEARCH_POLICY_V1.searchContinuationBytesMaximum,
    );
  });

  test("seals evidence state and rejects tampering", () => {
    const codec = createRecordSearchContinuationCodec(new Uint8Array(32).fill(0x42));
    const token = codec.sealEvidence(evidenceState);
    expect(token).not.toContain("checkpoint");
    expect(codec.openEvidence(token)).toEqual(evidenceState);
    const replacement = token.endsWith("A") ? "B" : "A";
    expect(() => codec.openEvidence(`${token.slice(0, -1)}${replacement}`)).toThrow(
      "Record evidence continuation is invalid",
    );
    expect(Buffer.byteLength(token)).toBeLessThanOrEqual(
      RECORD_SEARCH_POLICY_V1.evidenceContinuationBytesMaximum,
    );
  });

  test("enforces key and token byte bounds", () => {
    expect(() => createRecordSearchContinuationCodec(new Uint8Array(31))).toThrow();
    const codec = createRecordSearchContinuationCodec(new Uint8Array(32).fill(0x43));
    expect(() => codec.verifySearch("x".repeat(4_097))).toThrow(
      "Record search continuation is invalid",
    );
    expect(() => codec.openEvidence("x".repeat(65_537))).toThrow(
      "Record evidence continuation is invalid",
    );
  });
});
