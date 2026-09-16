import { describe, expect, test } from "bun:test";

import {
  createProtectedAuthorityRepublisherPort,
  type PreparedProtectedAuthorityPublication,
} from "../../src/server/protected-authority-republisher";

describe("protected authority republisher boundary", () => {
  test("rejects a caller-constructed publication handle before crypto completion", async () => {
    let completionCalls = 0;
    const forged: PreparedProtectedAuthorityPublication = Object.freeze({
      recordRef: "record",
      expectedRepresentationGeneration: 1,
      targetRepresentationGeneration: 2,
      objectId: "object",
      exactAccessNamespaceIds: Object.freeze(["namespace"]),
    });
    const republisher = createProtectedAuthorityRepublisherPort({
      resolvePrepared: () => forged,
      completion: {
        complete: () => {
          completionCalls += 1;
          return Promise.resolve("created" as const);
        },
        retire: () => Promise.resolve(),
      },
    });
    expect(await republisher.republishExact({
      recordRef: "record",
      expectedRepresentationGeneration: 1,
      targetRepresentationGeneration: 2,
      exactAccessNamespaceIds: ["namespace"],
      workBindingRef: "work",
      sourceChangeGeneration: 1, expectedProjectionGeneration: 1,
      attach: () => {throw new Error("Dormant Agent adapter must never attach");},
    })).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(completionCalls).toBe(0);
  });
});
