import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { createCloudConvertClient, type CloudConvertClient, type CloudConvertJob } from "./client.ts";
import { convert, convertWithClient, fetchExportBuffer, submitConversionWithClient } from "./service.ts";
import { createJobTag, verifyJobOwnership } from "./tags.ts";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env["CLOUDCONVERT_API_KEY"];

function makeCompletedJob(overrides: Partial<CloudConvertJob> = {}): CloudConvertJob {
  return {
    id: "job-123",
    status: "finished",
    tag: "user:usr_1:doc:doc_1",
    tasks: [],
    ...overrides,
  };
}

function makeMockClient(handlers?: {
  onCreate?: (config: { tag?: string; tasks: Record<string, unknown> }) => CloudConvertJob;
  onWait?: (jobId: string) => CloudConvertJob;
}): CloudConvertClient {
  return {
    jobs: {
      create: mock(async (config: { tag?: string; tasks: Record<string, unknown> }) => {
        if (handlers?.onCreate) {
          return handlers.onCreate(config);
        }
        return makeCompletedJob({
          id: "job-created",
          status: "waiting",
          ...(config.tag !== undefined ? { tag: config.tag } : {}),
        });
      }),
      wait: mock(async (jobId: string) => {
        if (handlers?.onWait) {
          return handlers.onWait(jobId);
        }
        return makeCompletedJob({ id: jobId });
      }),
      get: mock(async (jobId: string) => makeCompletedJob({ id: jobId })),
      all: mock(async () => []),
      getExportUrls: mock(() => [{ url: "https://storage.cloudconvert.com/out.pdf", filename: "out.pdf" }]),
    },
    tasks: {
      upload: mock(async () => undefined),
      cancel: mock(async (taskId: string) => ({
        id: taskId,
        name: "convert-file",
        operation: "convert",
        status: "canceled",
      })),
    },
  };
}

beforeEach(() => {
  process.env["CLOUDCONVERT_API_KEY"] = "test-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalApiKey === undefined) {
    delete process.env["CLOUDCONVERT_API_KEY"];
  } else {
    process.env["CLOUDCONVERT_API_KEY"] = originalApiKey;
  }
});

describe("convertWithClient", () => {
  test("uses one abortable request for durable provider submission", async () => {
    const controller = new AbortController();
    const calls: RequestInit[] = [];
    globalThis.fetch = mock(async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({
        data: makeCompletedJob({ id: "job-once", tag: "durable-tag", status: "waiting" }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = createCloudConvertClient("request-local-key", false);

    const submitted = await submitConversionWithClient(
      client,
      Buffer.from("source"),
      "html",
      "pdf",
      "durable-tag",
      controller.signal,
    );

    expect(submitted.job.id).toBe("job-once");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  test("builds a 3-task import/base64 → convert → export/url job", async () => {
    const input = Buffer.from("<p>hello</p>", "utf8");
    let capturedTasks: Record<string, unknown> | undefined;
    const completedReceipts: string[] = [];

    const client = makeMockClient({
      onCreate: (config) => {
        capturedTasks = config.tasks;
        return makeCompletedJob({
          id: "job-1",
          ...(config.tag !== undefined ? { tag: config.tag } : {}),
          status: "waiting",
        });
      },
    });

    globalThis.fetch = mock(async () =>
      new Response(Buffer.from("pdf-bytes"), { status: 200 }),
    ) as unknown as typeof fetch;

    const tag = createJobTag("usr_1", "doc_1");
    const result = await convertWithClient(client, input, "html", "pdf", {
      tag,
      onCompleted: ({ jobId }) => { completedReceipts.push(jobId); },
    });

    expect(capturedTasks).toBeDefined();
    expect(capturedTasks).toMatchObject({
      "import-input": {
        operation: "import/base64",
        filename: "input.html",
      },
      "convert-file": {
        operation: "convert",
        input: "import-input",
        input_format: "html",
        output_format: "pdf",
        engine: "chrome",
      },
      "export-result": {
        operation: "export/url",
        input: "convert-file",
      },
    });

    const importTask = capturedTasks!["import-input"] as { file: string };
    expect(importTask.file).toBe(input.toString("base64"));
    expect(result.toString()).toBe("pdf-bytes");
    expect(client.jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({ tag }),
    );
    expect(completedReceipts).toEqual(["job-1"]);
  });

  test("rejects jobs whose tag does not match the requested tag", async () => {
    const client = makeMockClient({
      onWait: () => makeCompletedJob({ tag: "user:other:doc:other" }),
    });

    const tag = createJobTag("usr_1", "doc_1");

    expect(
      convertWithClient(client, Buffer.from("data"), "html", "docx", { tag }),
    ).rejects.toThrow("Job ownership verification failed");
  });

  test("throws on CloudConvert job error status", async () => {
    const client = makeMockClient({
      onWait: () =>
        makeCompletedJob({
          status: "error",
          tasks: [
            {
              id: "t1",
              name: "convert-file",
              operation: "convert",
              status: "error",
              message: "Unsupported format",
            },
          ],
        }),
    });

    expect(
      convertWithClient(client, Buffer.from("data"), "html", "docx"),
    ).rejects.toThrow("CloudConvert error: Unsupported format");
  });
});

describe("convert", () => {
  test("fail-closed when CLOUDCONVERT_API_KEY is absent", async () => {
    delete process.env["CLOUDCONVERT_API_KEY"];

    expect(convert(Buffer.from("x"), "html", "pdf")).rejects.toThrow(
      "CLOUDCONVERT_API_KEY environment variable is required",
    );
  });
});

describe("fetchExportBuffer", () => {
  test("rejects multiple outputs instead of silently dropping files", async () => {
    const client = makeMockClient();
    client.jobs.getExportUrls = mock(() => [
      { url: "https://storage.cloudconvert.com/page-1.png" },
      { url: "https://storage.cloudconvert.com/page-2.png" },
    ]);
    expect(fetchExportBuffer(client, makeCompletedJob())).rejects.toThrow(
      "multiple output files",
    );
  });

  test("rejects redirects outside CloudConvert's HTTPS download boundary", async () => {
    const client = makeMockClient();
    globalThis.fetch = mock(async () => new Response(null, {
      status: 302,
      headers: { location: "https://example.com/result.pdf" },
    })) as unknown as typeof fetch;
    expect(fetchExportBuffer(client, makeCompletedJob())).rejects.toThrow(
      "outside the trusted download boundary",
    );
  });

  test("rejects an advertised output larger than the caller's bound", async () => {
    const client = makeMockClient();
    globalThis.fetch = mock(async () => new Response("too large", {
      status: 200,
      headers: { "content-length": "9" },
    })) as unknown as typeof fetch;
    expect(fetchExportBuffer(client, makeCompletedJob(), 8)).rejects.toThrow(
      "exceeds the permitted result size",
    );
  });
});

describe("verifyJobOwnership", () => {
  test("accepts tags created by createJobTag", () => {
    const tag = createJobTag("usr:123", "doc:456");
    expect(verifyJobOwnership(tag, "usr:123")).toBe(true);
    expect(verifyJobOwnership(tag, "usr_other")).toBe(false);
  });
});
