import { describe, expect, test } from "bun:test";

import {
  NautiloApiClient,
  type NautiloApiFetch,
} from "../../src/client";
import {
  protectedTaskTranscriptReadRequestV1Schema,
  protectedTaskTranscriptReadResponseV1Schema,
} from "../../src/schemas/protected-task-transcript-read";

const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";

describe("protected Task transcript read contract", () => {
  test("pins the signed-history page bound and rejects plaintext additions", () => {
    const request = {
      readVersion: 1 as const,
      agentId: AGENT,
      limit: 50,
      historyRead: {
        requestVersion: 1 as const,
        clientRequestKey: "task-transcript-page:one",
        readerDeviceId: "device:one",
      },
    };
    expect(protectedTaskTranscriptReadRequestV1Schema.parse(request))
      .toEqual(request);
    expect(() => protectedTaskTranscriptReadRequestV1Schema.parse({
      ...request,
      limit: 51,
    })).toThrow();
    expect(() => protectedTaskTranscriptReadRequestV1Schema.parse({
      ...request,
      prompt: "must never cross the transcript read transport",
    })).toThrow();
    expect(() => protectedTaskTranscriptReadResponseV1Schema.parse({
      readVersion: 1,
      status: "waiting",
      taskId: TASK,
      taskRunId: RUN,
      agentId: AGENT,
      reason: "transcript_not_mapped",
      transcript: [{ content: "plaintext" }],
    })).toThrow();
  });

  test("uses the exact content-v1 TaskRun endpoint and strict response schema", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl: NautiloApiFetch = async (target, init) => {
      const url = typeof target === "string" ? target
        : target instanceof URL ? target.href : target.url;
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return new Response(JSON.stringify({
        readVersion: 1,
        status: "waiting",
        taskId: TASK,
        taskRunId: RUN,
        agentId: AGENT,
        reason: "transcript_not_mapped",
      }), { headers: { "content-type": "application/json" } });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("session-token");
    expect(await client.readProtectedTaskRunTranscriptV1({
      readVersion: 1,
      taskId: TASK,
      taskRunId: RUN,
      agentId: AGENT,
      limit: 7,
      historyRead: {
        requestVersion: 1,
        clientRequestKey: "task-transcript-page:one",
        readerDeviceId: "device:one",
      },
    })).toMatchObject({ status: "waiting", taskRunId: RUN });
    expect(calls).toEqual([{
      url: `https://nautilo.test/api/tasks/${TASK}/runs/${RUN}/transcript-v1`,
      method: "POST",
      body: {
        readVersion: 1,
        agentId: AGENT,
        limit: 7,
        historyRead: {
          requestVersion: 1,
          clientRequestKey: "task-transcript-page:one",
          readerDeviceId: "device:one",
        },
      },
    }]);
  });
});
