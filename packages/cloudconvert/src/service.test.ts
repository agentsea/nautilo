import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CloudConvertClient, CloudConvertJob } from "./client.ts";
import { convert, convertWithClient } from "./service.ts";
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
      getExportUrls: mock(() => [{ url: "https://example.com/out.pdf", filename: "out.pdf" }]),
    },
    tasks: {
      upload: mock(async () => undefined),
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

describe("verifyJobOwnership", () => {
  test("accepts tags created by createJobTag", () => {
    const tag = createJobTag("usr:123", "doc:456");
    expect(verifyJobOwnership(tag, "usr:123")).toBe(true);
    expect(verifyJobOwnership(tag, "usr_other")).toBe(false);
  });
});
