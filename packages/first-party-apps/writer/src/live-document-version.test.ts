import { describe, expect, test } from "bun:test";
import {
  liveDocumentVersionEquals,
  parseLiveReviewDocumentVersion,
  parseProposalIngressVersion,
} from "./live-document-version";

describe("live-document-version ingress", () => {
  test("parses artifact and local SHA unions", () => {
    expect(parseLiveReviewDocumentVersion({ kind: "artifact_revision", revision: 3 })).toEqual({
      kind: "artifact_revision",
      revision: 3,
    });
    expect(parseLiveReviewDocumentVersion({
      kind: "local_sha",
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    })).toEqual({
      kind: "local_sha",
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
  });

  test("maps legacy numeric revision ingress only at the boundary", () => {
    expect(parseLiveReviewDocumentVersion(4)).toEqual({ kind: "artifact_revision", revision: 4 });
    expect(parseProposalIngressVersion({ baseRevision: 5 })).toEqual({ kind: "artifact_revision", revision: 5 });
  });

  test("compares versions by kind and payload", () => {
    const left = { kind: "artifact_revision" as const, revision: 2 };
    const right = { kind: "artifact_revision" as const, revision: 2 };
    expect(liveDocumentVersionEquals(left, right)).toBe(true);
    expect(liveDocumentVersionEquals(left, { kind: "artifact_revision", revision: 3 })).toBe(false);
  });
});
