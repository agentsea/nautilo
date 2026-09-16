import { describe, expect, test } from "bun:test";
import {
  parsePlatformLiveAppProposal,
  publishLiveAppProposal,
  subscribeLiveAppProposal,
} from "./live-app-proposal-bus";

const LOCAL_SHA = "a".repeat(64);

describe("live app proposal bus", () => {
  test("accepts only server-stamped proposal-ready envelopes", () => {
    const valid = JSON.stringify({
      ok: true,
      status: "proposal_ready",
      operations: [{ type: "replace" }],
      __nautiloLiveReview: {
        kind: "proposal_ready",
        appId: "notes",
        sessionId: "s",
        proposalId: "server-proposal-1",
        documentVersion: { kind: "artifact_revision", revision: 2 },
      },
    });
    expect(parsePlatformLiveAppProposal(valid)).toEqual({
      proposalId: "server-proposal-1",
      appId: "notes",
      sessionId: "s",
      documentVersion: { kind: "artifact_revision", revision: 2 },
      operations: [{ type: "replace" }],
    });
    for (const value of [
      "not json",
      JSON.stringify({ ok: true, status: "proposal_ready", operations: [] }),
      JSON.stringify({
        ok: true,
        status: "proposal_ready",
        operations: [],
        __nautiloLiveReview: {
          kind: "proposal_ready",
          appId: "x",
          sessionId: "s",
          proposalId: "p",
          documentVersion: { kind: "artifact_revision", revision: -1 },
        },
      }),
      JSON.stringify({
        ok: true,
        status: "other",
        operations: [],
        __nautiloLiveReview: {
          kind: "proposal_ready",
          appId: "x",
          sessionId: "s",
          proposalId: "p",
          documentVersion: { kind: "artifact_revision", revision: 1 },
        },
      }),
    ]) {
      expect(parsePlatformLiveAppProposal(value)).toBeNull();
    }
  });

  test("dedupes published IDs and replays proposals published before a listener existed", () => {
    const early = {
      proposalId: "early",
      appId: "notes",
      sessionId: "s",
      documentVersion: { kind: "local_sha" as const, sha256: LOCAL_SHA },
      operations: [],
    };
    expect(publishLiveAppProposal(early)).toBe(true);
    const received: string[] = [];
    const unsubscribe = subscribeLiveAppProposal((item) => received.push(item.proposalId));
    expect(received).toEqual(["early"]);
    const proposal = {
      proposalId: "once",
      appId: "notes",
      sessionId: "s",
      documentVersion: { kind: "local_sha" as const, sha256: LOCAL_SHA },
      operations: [],
    };
    expect(publishLiveAppProposal(proposal)).toBe(true);
    expect(publishLiveAppProposal(proposal)).toBe(false);
    expect(publishLiveAppProposal({ ...proposal, proposalId: "distinct" })).toBe(true);
    expect(received).toEqual(["early", "once", "distinct"]);
    unsubscribe();
  });
});
