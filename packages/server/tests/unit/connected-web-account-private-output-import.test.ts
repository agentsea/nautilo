import { describe, expect, test } from "bun:test";

import { publishConnectedWebPrivateOutput } from "../../src/connected-web-accounts/private-output-import";

const input = {
  actor: {
    userId: "user-id",
    agentId: "agent-id",
    roomId: "room-id",
    callingRoomId: null,
    memoryAccessEnvelope: {} as never,
  },
  output: {
    logicalPath: "connected-web/scope/report.csv",
    mimeType: "text/csv",
    bytes: new Uint8Array([1, 2, 3]),
  },
  publicationId: "connected-web:operation:0",
} as const;

describe("connected website private output publication", () => {
  test("classifies partial writes and escaping exceptions as unsafe to replay", async () => {
    expect(await publishConnectedWebPrivateOutput(input, async () => ({
      ok: false,
      code: "PARTIAL_WRITE",
      message: "metadata commit unknown",
      stateChanged: true,
      retrySafe: false,
    }))).toEqual({ kind: "unsafe_failure" });
    expect(await publishConnectedWebPrivateOutput(input, async () => {
      throw new Error("unknown writer state");
    })).toEqual({ kind: "unsafe_failure" });
    expect(await publishConnectedWebPrivateOutput(input, async () => ({
      ok: false,
      code: "NEW_UNCLASSIFIED_FAILURE",
      message: "mutation semantics unknown",
    }))).toEqual({ kind: "unsafe_failure" });
  });

  test("distinguishes permanent validation failures from retry-safe writer failures", async () => {
    expect(await publishConnectedWebPrivateOutput(input, async () => ({
      ok: false,
      code: "FORBIDDEN",
      message: "authority unavailable",
    }))).toEqual({ kind: "permanent_failure" });
    expect(await publishConnectedWebPrivateOutput(input, async () => ({
      ok: false,
      code: "WRITE_FAILED",
      message: "temporary filesystem failure",
    }))).toEqual({ kind: "retryable_failure" });
  });
});
