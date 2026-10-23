import { describe, expect, test } from "bun:test";
import type { CodexRequestEvent, CodexRequestResponse } from "@nautilo/types";

import {
  respondFreshProtectedTaskExternalRequest,
  type ProtectedTaskExternalRequestClient,
} from "./protected-task-external-request-response";

const SESSION = "foreground-action-session";
const CAPABILITY = "fresh-response-capability";

function event(
  overrides: Partial<CodexRequestEvent> = {},
): CodexRequestEvent {
  return {
    type: "codex.request",
    ownerId: "owner-a",
    requestId: "request-a",
    taskId: "task-a",
    jobId: "job-a",
    roomId: "room-a",
    expiresAt: "2026-10-13T12:00:00.000Z",
    request: {
      kind: "user_input_required",
      questions: [{
        id: "choice",
        header: "Choice",
        prompt: "Choose the exact action",
        secret: false,
        allowOther: false,
        options: [{ label: "Continue", description: "Continue this task" }],
      }],
      autoResolutionMs: null,
    },
    ...overrides,
  };
}

const RESPONSE: CodexRequestResponse = {
  kind: "user_input_required",
  answers: { choice: "Continue" },
};

function readyClient(input: Readonly<{
  recoveredEvent?: CodexRequestEvent;
  respond?: ProtectedTaskExternalRequestClient["respondProtectedTaskExternalRequest"];
  onRecover?: (input: Parameters<
    ProtectedTaskExternalRequestClient["recoverProtectedTaskExternalRequests"]
  >[0]) => void;
}> = {}): ProtectedTaskExternalRequestClient {
  return {
    recoverProtectedTaskExternalRequests: async (request) => {
      input.onRecover?.(request);
      return {
        status: "ready",
        entries: [{
          event: input.recoveredEvent ?? event(),
          responseCapability: CAPABILITY,
        }],
      };
    },
    respondProtectedTaskExternalRequest: input.respond ?? (async () => ({
      status: "responded",
    })),
  };
}

describe("protected Task external request response", () => {
  test("refreshes one capability on the explicit Human click and sends the exact displayed response", async () => {
    const displayed = event();
    const calls: string[] = [];
    const client = readyClient({
      onRecover: request => {
        calls.push(`recover:${request.clientActionSessionId}`);
        expect(request.requestId).toBe(displayed.requestId);
        expect(request.isCurrent()).toBe(true);
      },
      respond: async request => {
        calls.push(`respond:${request.requestId}`);
        expect(request.clientActionSessionId).toBe(SESSION);
        expect(request.responseCapability).toBe(CAPABILITY);
        expect(request.response).toEqual(RESPONSE);
        expect(request.isCurrent()).toBe(true);
        return { status: "responded" };
      },
    });

    expect(await respondFreshProtectedTaskExternalRequest({
      client,
      clientActionSessionId: SESSION,
      expectedEvent: displayed,
      response: RESPONSE,
      isCurrent: () => true,
    })).toBe("responded");
    expect(calls).toEqual([`recover:${SESSION}`, "respond:request-a"]);
  });

  test.each([
    ["request", event({ requestId: "request-b" }), RESPONSE],
    ["owner", event({ ownerId: "owner-b" }), RESPONSE],
    ["Room", event({ roomId: "room-b" }), RESPONSE],
    ["Task", event({ taskId: "task-b" }), RESPONSE],
    ["Job", event({ jobId: "job-b" }), RESPONSE],
    ["displayed payload", event({ request: {
      kind: "user_input_required",
      questions: [{ id: "choice", header: "Choice", prompt: "A changed question",
        secret: false, allowOther: false, options: null }],
      autoResolutionMs: null,
    } }), RESPONSE],
    ["response kind", event(), {
      kind: "command_approval_required",
      decision: "deny",
    } satisfies CodexRequestResponse],
  ] as const)("does not send after a fresh %s mismatch", async (
    _kind,
    recoveredEvent,
    response,
  ) => {
    let responds = 0;
    const client = readyClient({
      recoveredEvent,
      respond: async () => {
        responds += 1;
        return { status: "responded" };
      },
    });

    expect(await respondFreshProtectedTaskExternalRequest({
      client,
      clientActionSessionId: SESSION,
      expectedEvent: event(),
      response,
      isCurrent: () => true,
    })).toBe("not_sent");
    expect(responds).toBe(0);
  });

  test("does not respond when fresh recovery is unavailable", async () => {
    let responds = 0;
    const client: ProtectedTaskExternalRequestClient = {
      recoverProtectedTaskExternalRequests: async () => ({
        status: "unavailable",
        entries: [],
      }),
      respondProtectedTaskExternalRequest: async () => {
        responds += 1;
        return { status: "responded" };
      },
    };

    expect(await respondFreshProtectedTaskExternalRequest({
      client,
      clientActionSessionId: SESSION,
      expectedEvent: event(),
      response: RESPONSE,
      isCurrent: () => true,
    })).toBe("not_sent");
    expect(responds).toBe(0);
  });

  test.each(["unavailable", "throw"] as const)(
    "makes no automatic retry after an unconfirmed %s response",
    async (outcome) => {
      let recovers = 0;
      let responds = 0;
      const client = readyClient({
        onRecover: () => { recovers += 1; },
        respond: async () => {
          responds += 1;
          if (outcome === "throw") throw new Error("response outcome unknown");
          return { status: "unavailable" };
        },
      });

      expect(await respondFreshProtectedTaskExternalRequest({
        client,
        clientActionSessionId: SESSION,
        expectedEvent: event(),
        response: RESPONSE,
        isCurrent: () => true,
      })).toBe("unconfirmed");
      expect({ recovers, responds }).toEqual({ recovers: 1, responds: 1 });
    },
  );

  test("rejects stale frontend custody before recovery", async () => {
    let recovers = 0;
    const client = readyClient({ onRecover: () => { recovers += 1; } });
    expect(await respondFreshProtectedTaskExternalRequest({
      client,
      clientActionSessionId: SESSION,
      expectedEvent: event(),
      response: RESPONSE,
      isCurrent: () => false,
    })).toBe("not_sent");
    expect(recovers).toBe(0);
  });

  test("rejects stale frontend custody after recovery and before response", async () => {
    let current = true;
    let responds = 0;
    const client = readyClient({
      onRecover: () => { current = false; },
      respond: async () => {
        responds += 1;
        return { status: "responded" };
      },
    });
    expect(await respondFreshProtectedTaskExternalRequest({
      client,
      clientActionSessionId: SESSION,
      expectedEvent: event(),
      response: RESPONSE,
      isCurrent: () => current,
    })).toBe("not_sent");
    expect(responds).toBe(0);
  });

  test("does not confirm a response after frontend custody becomes stale", async () => {
    let current = true;
    let responds = 0;
    const client = readyClient({
      respond: async () => {
        responds += 1;
        current = false;
        return { status: "responded" };
      },
    });
    expect(await respondFreshProtectedTaskExternalRequest({
      client,
      clientActionSessionId: SESSION,
      expectedEvent: event(),
      response: RESPONSE,
      isCurrent: () => current,
    })).toBe("unconfirmed");
    expect(responds).toBe(1);
  });
});
