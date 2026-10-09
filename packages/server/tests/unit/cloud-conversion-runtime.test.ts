import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import type { CloudConversionExecutionRequest } from "@nautilo/agent";
import type { CloudConvertClient, CloudConvertJob } from "@nautilo/cloudconvert";
import type { ConversionOperation, CreateConversionOperationInput } from "@nautilo/db";
import type { DurableServiceFundingBinding } from "@nautilo/types";
import {
  createCloudConversionRuntime,
  type CloudConversionRuntimeDependencies,
} from "../../src/conversions/cloud-conversion-runtime";
import { ModelFundingError } from "../../src/lib/model-funding";

const originalFetch = globalThis.fetch;
const HUMAN_ID = "10000000-0000-4000-8000-000000000001";
const ROOM_ID = "10000000-0000-4000-8000-000000000002";
const AGENT_ID = "10000000-0000-4000-8000-000000000003";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000004";
const CREDENTIAL_ID = "10000000-0000-4000-8000-000000000005";

const FUNDING: DurableServiceFundingBinding = {
  humanUserId: HUMAN_ID,
  provider: "cloudconvert",
  binding: {
    kind: "personal",
    providerRoute: "cloudconvert",
    credentialId: CREDENTIAL_ID,
    credentialRevision: 3,
  },
  credentialFingerprint: "f".repeat(64),
};

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function request(
  bytes = Buffer.from("<p>hello</p>"),
  execution: Partial<CloudConversionExecutionRequest["execution"]> = {},
): CloudConversionExecutionRequest {
  return {
    execution: {
      toolCallId: "tool-call-1",
      turnId: "turn-1",
      causalHumanUserId: HUMAN_ID,
      roomId: ROOM_ID,
      agentId: AGENT_ID,
      ...execution,
    },
    source: {
      kind: "inline",
      sha256: sha(bytes),
      authorityDigest: "a".repeat(64),
    },
    destination: {
      namespaceId: NAMESPACE_ID,
      pathDigest: "b".repeat(64),
      authorityDigest: "c".repeat(64),
    },
    inputFormat: "html",
    outputFormat: "pdf",
    bytes,
    maxOutputBytes: 1024,
  };
}

function providerJob(overrides: Partial<CloudConvertJob> = {}): CloudConvertJob {
  return {
    id: "provider-job-1",
    tag: "",
    status: "finished",
    tasks: [{
      id: "task-1",
      name: "convert-file",
      operation: "convert",
      status: "finished",
      credits: 2,
    }],
    ...overrides,
  };
}

class MemoryConversionStore {
  row: ConversionOperation | null = null;
  queuedRow: ConversionOperation | null = null;

  private change(status: ConversionOperation["status"], values: Partial<ConversionOperation> = {}) {
    if (!this.row) return null;
    this.row = { ...this.row, ...values, status, version: this.row.version + 1, updatedAt: new Date() };
    return this.row;
  }

  seed(input: Partial<ConversionOperation>): ConversionOperation {
    this.row = {
      id: "10000000-0000-4000-8000-000000000010",
      operationKey: "d".repeat(64),
      recoveryHandle: `cvr_${"e".repeat(32)}`,
      causalHumanUserId: HUMAN_ID,
      roomId: ROOM_ID,
      agentId: AGENT_ID,
      taskId: null,
      runId: null,
      jobId: null,
      fundingKind: "personal",
      providerRoute: "cloudconvert",
      providerSandbox: true,
      providerRegion: "eu-central",
      credentialId: CREDENTIAL_ID,
      credentialRevision: 3,
      credentialFingerprint: "f".repeat(64),
      sourceKind: "inline",
      sourceArtifactId: null,
      sourceArtifactRevision: null,
      sourceSha256: "1".repeat(64),
      sourceAuthorityDigest: "a".repeat(64),
      destinationArtifactId: null,
      destinationArtifactRevision: null,
      destinationNamespaceId: NAMESPACE_ID,
      destinationPathDigest: "b".repeat(64),
      destinationAuthorityDigest: "c".repeat(64),
      inputFormat: "html",
      outputFormat: "pdf",
      maxOutputBytes: 1024,
      providerTag: `ntlo_cv_${"2".repeat(32)}`,
      providerJobId: "provider-job-1",
      submissionLeaseId: null,
      submissionLeaseExpiresAt: null,
      cancellationRequestedAt: null,
      status: "submitted",
      providerCredits: null,
      outputSha256: null,
      outputBytes: null,
      publicationRevisionId: null,
      publicationArtifactId: null,
      failureCode: null,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      submittedAt: new Date(),
      terminalAt: null,
      publishedAt: null,
      ...input,
    };
    return this.row;
  }

  async create(input: CreateConversionOperationInput) {
    if (this.row) return this.row;
    return this.seed({
      ...(input as unknown as Partial<ConversionOperation>),
      providerJobId: null,
      status: "prepared",
      submittedAt: null,
    });
  }
  async getByKey(key: string) { return this.row?.operationKey === key ? this.row : null; }
  async getByHandle(handle: string) { return this.row?.recoveryHandle === handle ? this.row : null; }
  async listRecoverable(limit: number) {
    return [this.row, this.queuedRow]
      .filter((row): row is ConversionOperation => row !== null)
      .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
      .slice(0, limit);
  }
  async touchRecovery(input: Pick<ConversionOperation, "operationKey" | "status" | "version">) {
    const selected = [this.row, this.queuedRow].find((row) =>
      row?.operationKey === input.operationKey
      && row.status === input.status
      && row.version === input.version);
    if (!selected) return null;
    const touched = { ...selected, updatedAt: new Date() };
    if (this.row?.operationKey === input.operationKey) this.row = touched;
    if (this.queuedRow?.operationKey === input.operationKey) {
      this.queuedRow = this.row;
      this.row = touched;
    }
    return touched;
  }
  async claimSubmission(input: { operationKey: string; leaseId: string; leaseExpiresAt: Date }) {
    return this.row?.status === "prepared"
      ? this.change("submitting", {
          submissionLeaseId: input.leaseId,
          submissionLeaseExpiresAt: input.leaseExpiresAt,
        })
      : null;
  }
  async expireSubmissionLease(input: { operationKey: string; now: Date }) {
    return this.row?.status === "submitting"
      && this.row.submissionLeaseExpiresAt !== null
      && this.row.submissionLeaseExpiresAt <= input.now
      ? this.change("submission_unknown", {
          submissionLeaseId: null,
          submissionLeaseExpiresAt: null,
        })
      : null;
  }
  async renewSubmissionLease(input: { operationKey: string; leaseId: string; leaseExpiresAt: Date }) {
    return this.row?.status === "submitting" && this.row.submissionLeaseId === input.leaseId
      ? this.change("submitting", { submissionLeaseExpiresAt: input.leaseExpiresAt })
      : null;
  }
  async submissionUnknown(_key: string, failureCode: string) {
    return this.row?.status === "submitting" ? this.change("submission_unknown", {
      failureCode,
      submissionLeaseId: null,
      submissionLeaseExpiresAt: null,
    }) : null;
  }
  async attachJob(input: { operationKey: string; providerJobId: string; submissionLeaseId?: string }) {
    const liveMatches = this.row?.status === "submitting"
      && input.submissionLeaseId === this.row.submissionLeaseId;
    const recoveryMatches = this.row?.status === "submission_unknown"
      && input.submissionLeaseId === undefined;
    return this.row && (liveMatches || recoveryMatches)
      ? this.change(this.row.cancellationRequestedAt ? "cancel_requested" : "submitted", {
          providerJobId: input.providerJobId,
          failureCode: null,
          submissionLeaseId: null,
          submissionLeaseExpiresAt: null,
        })
      : null;
  }
  async recoveryAmbiguous(_key: string, failureCode: "provider_job_missing" | "provider_job_ambiguous") {
    return this.change("recovery_ambiguous", { failureCode });
  }
  async processing() { return this.change("processing"); }
  async providerFinished(input: { operationKey: string; providerCredits: string | null }) {
    return this.row && ["submitted", "processing", "cancel_requested"].includes(this.row.status)
      ? this.change("provider_finished", { providerCredits: input.providerCredits })
      : null;
  }
  async ready(input: { operationKey: string; providerCredits: string | null; outputSha256: string; outputBytes: number }) {
    return this.row?.status === "provider_finished"
      ? this.change("ready_to_publish", input)
      : null;
  }
  async claimPublication() {
    return this.row?.status === "ready_to_publish" ? this.change("publication_committing") : null;
  }
  async published(input: { operationKey: string; publicationRevisionId: string; publicationArtifactId: string }) {
    return this.row?.status === "publication_committing"
      ? this.change("published", { ...input, publishedAt: new Date() })
      : null;
  }
  async failPublication(input: { operationKey: string; failureCode: string }) {
    return this.change("publication_failed", { failureCode: input.failureCode });
  }
  async requestCancel() {
    if (!this.row) return null;
    const status = ["submitted", "processing", "cancel_requested"].includes(this.row.status)
      ? "cancel_requested"
      : this.row.status;
    return this.change(status, { cancellationRequestedAt: this.row.cancellationRequestedAt ?? new Date() });
  }
  async cancelBeforeDispatch(input:
    | { operationKey: string; phase: "prepared" }
    | { operationKey: string; phase: "submitting"; submissionLeaseId: string }) {
    if (!this.row || this.row.operationKey !== input.operationKey || this.row.providerJobId !== null) return null;
    const matches = input.phase === "prepared"
      ? this.row.status === "prepared"
      : this.row.status === "submitting" && this.row.submissionLeaseId === input.submissionLeaseId;
    return matches ? this.change("cancelled", {
      providerCredits: "0",
      cancellationRequestedAt: this.row.cancellationRequestedAt ?? new Date(),
      failureCode: "cancelled_before_provider_dispatch",
      submissionLeaseId: null,
      submissionLeaseExpiresAt: null,
      terminalAt: new Date(),
    }) : null;
  }
  async terminal(input: { operationKey: string; status: "cancelled" | "failed" | "expired"; failureCode: string; providerCredits?: string | null }) {
    return this.change(input.status, { failureCode: input.failureCode, providerCredits: input.providerCredits ?? null });
  }
}

function fundingDependencies(): Pick<CloudConversionRuntimeDependencies, "admitFunding" | "runFunding"> {
  return {
    admitFunding: mock(async () => FUNDING),
    runFunding: async (_binding, _intent, callback) => callback({
      apiKey: "request-local-key",
      usageFunding: {
        kind: "personal",
        humanUserId: HUMAN_ID,
        payerHumanId: HUMAN_ID,
        providerRoute: "cloudconvert",
        credentialId: CREDENTIAL_ID,
        credentialRevision: 3,
      },
    }),
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("CloudConvert durable conversion runtime", () => {
  test("never persists or surfaces provider exception text in durable failure state", async () => {
    const store = new MemoryConversionStore();
    const sentinel = "SECRET api-key at https://provider.invalid/private response-body";
    const client: CloudConvertClient = {
      jobs: {
        create: mock(async () => { throw new Error(sentinel); }),
        all: mock(async () => []),
        get: mock(async () => providerJob()),
        wait: mock(async () => providerJob()),
        getExportUrls: mock(() => []),
      },
      tasks: {
        upload: mock(async () => undefined),
        cancel: mock(async () => providerJob().tasks[0]!),
      },
    };
    const runtime = createCloudConversionRuntime({
      store,
      ...fundingDependencies(),
      createClient: () => client,
      beginCost: mock(async () => undefined),
      settleCost: mock(async () => undefined),
    });

    const first = await runtime.execute(request());
    expect(first.status).toBe("error");
    expect(JSON.stringify(first)).not.toContain(sentinel);
    expect(JSON.stringify(store.row)).not.toContain(sentinel);

    store.row = { ...store.row!, submissionLeaseExpiresAt: new Date(0) };
    const recovered = await runtime.resume({
      recoveryHandle: store.row.recoveryHandle,
      causalHumanUserId: HUMAN_ID,
      destination: request().destination,
      maxOutputBytes: 1024,
    });
    expect(recovered.status).toBe("error");
    expect(store.row.failureCode).toBe("provider_job_missing");
    expect(JSON.stringify(recovered)).not.toContain(sentinel);
    expect(JSON.stringify(store.row)).not.toContain(sentinel);
  });

  test("reconciles a lost create response without a second paid submission and safely reapplies publication", async () => {
    const store = new MemoryConversionStore();
    const output = Buffer.from("%PDF-recovered");
    let createdJob: CloudConvertJob | null = null;
    const create = mock(async (config: { tag?: string }) => {
      createdJob = providerJob({
        ...(config.tag === undefined ? {} : { tag: config.tag }),
        status: "waiting",
      });
      throw new Error("response lost after provider accepted job");
    });
    const all = mock(async () => createdJob ? [createdJob] : []);
    const client: CloudConvertClient = {
      jobs: {
        create,
        all,
        get: mock(async () => providerJob({ tag: store.row!.providerTag })),
        wait: mock(async () => providerJob({ tag: store.row!.providerTag })),
        getExportUrls: mock(() => [{ url: "https://storage.cloudconvert.com/result.pdf" }]),
      },
      tasks: {
        upload: mock(async () => undefined),
        cancel: mock(async () => providerJob().tasks[0]!),
      },
    };
    globalThis.fetch = mock(async () => new Response(output, { status: 200 })) as unknown as typeof fetch;
    const settleCost = mock(async () => undefined);
    const runtime = createCloudConversionRuntime({
      store,
      ...fundingDependencies(),
      createClient: (_key, endpoint) => {
        expect(endpoint).toEqual({ sandbox: false, region: null });
        return client;
      },
      beginCost: mock(async () => undefined),
      settleCost,
    });

    const first = await runtime.execute(request());
    expect(first.status).toBe("error");
    if (first.status !== "error") throw new Error("expected uncertain submission");
    expect(first.code).toBe("provider_submit_response_unknown");
    expect(first.recoveryHandle).toBe(store.row!.recoveryHandle);

    const activeLease = await runtime.resume({
      recoveryHandle: store.row!.recoveryHandle,
      causalHumanUserId: HUMAN_ID,
      destination: request().destination,
      maxOutputBytes: 1024,
    });
    expect(activeLease.status).toBe("error");
    if (activeLease.status !== "error") throw new Error("expected live submission lease");
    expect(activeLease.code).toBe("conversion_submission_in_progress");
    expect(all).not.toHaveBeenCalled();

    store.row = { ...store.row!, submissionLeaseExpiresAt: new Date(0) };

    const recovered = await runtime.resume({
      recoveryHandle: store.row.recoveryHandle,
      causalHumanUserId: HUMAN_ID,
      destination: request().destination,
      maxOutputBytes: 1024,
    });
    expect(recovered.status).toBe("ready_to_publish");
    expect(create).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(1);
    expect(store.row.status).toBe("publication_committing");

    const reapplied = await runtime.resumePublication({
      recoveryHandle: store.row.recoveryHandle,
      causalHumanUserId: HUMAN_ID,
      destination: request().destination,
      maxOutputBytes: 1024,
    });
    expect(reapplied.status).toBe("ready_to_publish");
    expect(create).toHaveBeenCalledTimes(1);
    expect(settleCost).toHaveBeenCalledTimes(1);
    await runtime.confirmPublication({
      operationKey: store.row.operationKey,
      artifactId: "artifact-1",
      revisionId: "10000000-0000-4000-8000-000000000099",
    });
    await runtime.confirmPublication({
      operationKey: store.row.operationKey,
      artifactId: "artifact-1",
      revisionId: "10000000-0000-4000-8000-000000000099",
    });
    expect(store.row.status).toBe("published");

    const replayRequest = request();
    const advancedDestination: CloudConversionExecutionRequest = {
      ...replayRequest,
      destination: {
        ...replayRequest.destination,
        artifactInternalId: "10000000-0000-4000-8000-000000000020",
        revision: 2,
      },
    };
    const replayed = await runtime.execute(advancedDestination);
    expect(replayed.status).toBe("published");
    expect(create).toHaveBeenCalledTimes(1);

    const changedSource = await runtime.execute(request(Buffer.from("<p>changed</p>")));
    expect(changedSource.status).toBe("error");
    if (changedSource.status !== "error") throw new Error("expected source conflict");
    expect(changedSource.code).toBe("conversion_operation_conflict");

    const targetRequest = request();
    const changedDestination: CloudConversionExecutionRequest = {
      ...targetRequest,
      destination: {
        ...targetRequest.destination,
        pathDigest: sha("different-target.pdf"),
      },
    };
    const changedTarget = await runtime.execute(changedDestination);
    expect(changedTarget.status).toBe("error");
    if (changedTarget.status !== "error") throw new Error("expected target conflict");
    expect(changedTarget.code).toBe("conversion_operation_conflict");
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("binds separate durable operations to distinct turns and task runs", async () => {
    const keys = new Set<string>();
    for (const execution of [
      { turnId: "turn-a", runId: "10000000-0000-4000-8000-000000000010" },
      { turnId: "turn-b", runId: "10000000-0000-4000-8000-000000000010" },
      { turnId: "turn-a", runId: "10000000-0000-4000-8000-000000000011" },
    ]) {
      const store = new MemoryConversionStore();
      const runtime = createCloudConversionRuntime({
        store,
        admitFunding: mock(async (...args: unknown[]) => {
          if (args.length === 3) throw new ModelFundingError("personal_credential_stale");
          return FUNDING;
        }),
        runFunding: mock(async () => { throw new Error("must not dispatch"); }),
        beginCost: mock(async () => undefined),
        settleCost: mock(async () => undefined),
      });
      await runtime.execute(request(undefined, execution));
      keys.add(store.row!.operationKey);
    }
    expect(keys.size).toBe(3);
  });

  test("does not claim a submission or cost receipt when funding fails before its callback", async () => {
    const store = new MemoryConversionStore();
    const beginCost = mock(async () => undefined);
    const runtime = createCloudConversionRuntime({
      store,
      admitFunding: mock(async () => FUNDING),
      runFunding: mock(async () => { throw new ModelFundingError("personal_credential_unavailable"); }),
      beginCost,
      settleCost: mock(async () => undefined),
    });
    const result = await runtime.execute(request());
    expect(result.status).toBe("error");
    expect(store.row!.status).toBe("prepared");
    expect(beginCost).not.toHaveBeenCalled();
  });

  test("does not admit funding or dispatch when the request is already aborted", async () => {
    const store = new MemoryConversionStore();
    const controller = new AbortController();
    controller.abort(new Error("user stopped"));
    const admitFunding = mock(async () => FUNDING);
    const createClient = mock(() => { throw new Error("must not create a provider client"); });
    const runtime = createCloudConversionRuntime({
      store,
      ...fundingDependencies(),
      admitFunding,
      createClient,
      beginCost: mock(async () => undefined),
      settleCost: mock(async () => undefined),
    });
    const result = await runtime.execute({ ...request(), signal: controller.signal });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected pre-dispatch cancellation");
    expect(result.code).toBe("conversion_cancelled");
    expect(admitFunding).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(store.row).toBeNull();
  });

  test("cancels durably without dispatch when stopped while request-local funding waits", async () => {
    const store = new MemoryConversionStore();
    const controller = new AbortController();
    let releaseFunding!: () => void;
    const fundingGate = new Promise<void>((resolve) => { releaseFunding = resolve; });
    const create = mock(async () => providerJob());
    const runtime = createCloudConversionRuntime({
      store,
      admitFunding: mock(async () => FUNDING),
      runFunding: async (_binding, _intent, callback) => {
        await fundingGate;
        return callback({
          apiKey: "request-local-key",
          usageFunding: {
            kind: "personal",
            humanUserId: HUMAN_ID,
            payerHumanId: HUMAN_ID,
            providerRoute: "cloudconvert",
            credentialId: CREDENTIAL_ID,
            credentialRevision: 3,
          },
        });
      },
      createClient: () => ({
        jobs: {
          create,
          all: mock(async () => []),
          get: mock(async () => providerJob()),
          wait: mock(async () => providerJob()),
          getExportUrls: mock(() => []),
        },
        tasks: { upload: mock(async () => undefined), cancel: mock(async () => providerJob().tasks[0]!) },
      }),
      beginCost: mock(async () => undefined),
      settleCost: mock(async () => undefined),
    });
    const execution = runtime.execute({ ...request(), signal: controller.signal });
    while (store.row?.status !== "prepared") await Promise.resolve();
    controller.abort(new Error("user stopped"));
    releaseFunding();
    const result = await execution;
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected funding-wait cancellation");
    expect(result.code).toBe("conversion_cancelled");
    expect(create).not.toHaveBeenCalled();
    const finalRow = await store.getByKey(store.row.operationKey);
    expect(finalRow?.status).toBe("cancelled");
    expect(finalRow?.providerCredits).toBe("0");
  });

  test("settles known zero when stopped after the submission claim but before POST", async () => {
    const store = new MemoryConversionStore();
    const controller = new AbortController();
    const claim = store.claimSubmission.bind(store);
    store.claimSubmission = async (input) => {
      const claimed = await claim(input);
      controller.abort(new Error("user stopped"));
      return claimed;
    };
    const create = mock(async () => providerJob());
    const settlements: Array<Readonly<{ actualCostUsd?: string | null; measuredUnits?: number | null }>> = [];
    const runtime = createCloudConversionRuntime({
      store,
      ...fundingDependencies(),
      createClient: () => ({
        jobs: {
          create,
          all: mock(async () => []),
          get: mock(async () => providerJob()),
          wait: mock(async () => providerJob()),
          getExportUrls: mock(() => []),
        },
        tasks: { upload: mock(async () => undefined), cancel: mock(async () => providerJob().tasks[0]!) },
      }),
      beginCost: mock(async () => undefined),
      settleCost: async (receipt) => { settlements.push(receipt); },
    });
    const result = await runtime.execute({ ...request(), signal: controller.signal });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected claimed cancellation");
    expect(result.code).toBe("conversion_cancelled");
    expect(create).not.toHaveBeenCalled();
    expect(store.row!.status).toBe("cancelled");
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.actualCostUsd).toBe("0");
    expect(settlements[0]?.measuredUnits).toBe(0);
  });

  test("persists cancellation when stopped during POST and cancels a late accepted job after restart", async () => {
    const store = new MemoryConversionStore();
    const controller = new AbortController();
    let accepted: CloudConvertJob | null = null;
    const create = mock((config: { tag?: string }, options?: { signal?: AbortSignal }) => {
      accepted = providerJob({
        ...(config.tag === undefined ? {} : { tag: config.tag }),
        status: "waiting",
      });
      return new Promise<CloudConvertJob>((_resolve, reject) => {
        const abort = () => {
          const reason: unknown = options?.signal?.reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        };
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      });
    });
    let reads = 0;
    const cancelTask = mock(async () => providerJob().tasks[0]!);
    const client: CloudConvertClient = {
      jobs: {
        create,
        all: mock(async () => accepted ? [accepted] : []),
        get: mock(async () => {
          reads += 1;
          return providerJob({
            tag: store.row!.providerTag,
            status: reads === 1 ? "waiting" : "error",
            tasks: [{ ...providerJob().tasks[0]!, status: reads === 1 ? "processing" : "error" }],
          });
        }),
        wait: mock(async () => providerJob()),
        getExportUrls: mock(() => []),
      },
      tasks: { upload: mock(async () => undefined), cancel: cancelTask },
    };
    const runtime = createCloudConversionRuntime({
      store,
      ...fundingDependencies(),
      createClient: () => client,
      beginCost: mock(async () => undefined),
      settleCost: mock(async () => undefined),
    });
    const execution = runtime.execute({ ...request(), signal: controller.signal });
    while (create.mock.calls.length === 0) await Promise.resolve();
    controller.abort(new Error("user stopped"));
    const result = await execution;
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected live submission cancellation");
    expect(result.code).toBe("conversion_cancel_pending");
    expect(store.row!.status).toBe("submitting");
    expect(store.row!.cancellationRequestedAt).toBeInstanceOf(Date);

    store.row = { ...store.row!, submissionLeaseExpiresAt: new Date(0) };
    expect(await runtime.reconcilePending(4)).toEqual({ inspected: 1, changed: 2 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(cancelTask).toHaveBeenCalledTimes(1);
    expect(store.row.status).toBe("cancelled");
  });

  test("does not let a replacement personal key take over an existing job", async () => {
    const store = new MemoryConversionStore();
    const row = store.seed({ status: "submitted" });
    const createClient = mock(() => { throw new Error("must not fall back to another credential"); });
    const runtime = createCloudConversionRuntime({
      store,
      admitFunding: mock(async () => FUNDING),
      runFunding: mock(async () => { throw new ModelFundingError("personal_credential_stale"); }),
      createClient,
      beginCost: mock(async () => undefined),
      settleCost: mock(async () => undefined),
    });
    const result = await runtime.resume({
      recoveryHandle: row.recoveryHandle,
      causalHumanUserId: HUMAN_ID,
      destination: request().destination,
      maxOutputBytes: 1024,
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected key-change error");
    expect(result.code).toBe("creating_credential_changed");
    expect(result.message).toContain("new key revision cannot take over");
    expect(store.row!.status).toBe("submitted");
    expect(createClient).not.toHaveBeenCalled();
  });

  test("stops recovery on zero or duplicate tag matches without another POST", async () => {
    for (const matchCount of [0, 2]) {
      const store = new MemoryConversionStore();
      const row = store.seed({ status: "submission_unknown", providerJobId: null });
      const create = mock(async () => providerJob());
      const client: CloudConvertClient = {
        jobs: {
          create,
          all: mock(async () => Array.from({ length: matchCount }, (_, index) =>
            providerJob({ id: `job-${index}`, tag: row.providerTag }))),
          get: mock(async () => providerJob()),
          wait: mock(async () => providerJob()),
          getExportUrls: mock(() => []),
        },
        tasks: {
          upload: mock(async () => undefined),
          cancel: mock(async () => providerJob().tasks[0]!),
        },
      };
      const runtime = createCloudConversionRuntime({
        store,
        ...fundingDependencies(),
        createClient: () => client,
        beginCost: mock(async () => undefined),
        settleCost: mock(async () => undefined),
      });
      const result = await runtime.resume({
        recoveryHandle: row.recoveryHandle,
        causalHumanUserId: HUMAN_ID,
        destination: request().destination,
        maxOutputBytes: 1024,
      });
      expect(result.status).toBe("error");
      if (result.status !== "error") throw new Error("expected ambiguous recovery");
      expect(result.code).toBe(matchCount === 0 ? "provider_job_missing" : "provider_job_ambiguous");
      expect(create).not.toHaveBeenCalled();
      expect(store.row!.status).toBe("recovery_ambiguous");
    }
  });

  test("marks a provider 404 as expired without creating another conversion", async () => {
    const store = new MemoryConversionStore();
    const row = store.seed({ status: "submitted" });
    const create = mock(async () => providerJob());
    const client: CloudConvertClient = {
      jobs: {
        create,
        all: mock(async () => []),
        get: mock(async () => {
          throw new Error("Not Found", { cause: new Response(null, { status: 404 }) });
        }),
        wait: mock(async () => providerJob()),
        getExportUrls: mock(() => []),
      },
      tasks: {
        upload: mock(async () => undefined),
        cancel: mock(async () => providerJob().tasks[0]!),
      },
    };
    const runtime = createCloudConversionRuntime({
      store,
      ...fundingDependencies(),
      createClient: () => client,
      beginCost: mock(async () => undefined),
      settleCost: mock(async () => undefined),
    });
    const result = await runtime.resume({
      recoveryHandle: row.recoveryHandle,
      causalHumanUserId: HUMAN_ID,
      destination: request().destination,
      maxOutputBytes: 1024,
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected expiry");
    expect(result.code).toBe("conversion_result_expired");
    expect(store.row!.status).toBe("expired");
    expect(create).not.toHaveBeenCalled();
  });

  test("persists expiry when a finished job no longer has an export", async () => {
    const store = new MemoryConversionStore();
    const row = store.seed({ status: "provider_finished", providerCredits: "2.00000000" });
    const client: CloudConvertClient = {
      jobs: {
        create: mock(async () => providerJob()),
        all: mock(async () => []),
        get: mock(async () => providerJob({ tag: row.providerTag })),
        wait: mock(async () => providerJob({ tag: row.providerTag })),
        getExportUrls: mock(() => []),
      },
      tasks: {
        upload: mock(async () => undefined),
        cancel: mock(async () => providerJob().tasks[0]!),
      },
    };
    const runtime = createCloudConversionRuntime({
      store,
      ...fundingDependencies(),
      createClient: () => client,
      beginCost: mock(async () => undefined),
      settleCost: mock(async () => undefined),
    });
    const result = await runtime.resume({
      recoveryHandle: row.recoveryHandle,
      causalHumanUserId: HUMAN_ID,
      destination: request().destination,
      maxOutputBytes: 1024,
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected expired export");
    expect(result.code).toBe("conversion_result_expired");
    expect(store.row!.status).toBe("expired");
  });

  test("stop aborts a hung provider recovery read", async () => {
    const store = new MemoryConversionStore();
    store.seed({ status: "submitted" });
    const client: CloudConvertClient = {
      jobs: {
        create: mock(async () => providerJob()),
        all: mock(async () => []),
        get: mock(() => new Promise<CloudConvertJob>(() => undefined)),
        wait: mock(async () => providerJob()),
        getExportUrls: mock(() => []),
      },
      tasks: {
        upload: mock(async () => undefined),
        cancel: mock(async () => providerJob().tasks[0]!),
      },
    };
    const runtime = createCloudConversionRuntime({
      store,
      ...fundingDependencies(),
      createClient: () => client,
      beginCost: mock(async () => undefined),
      settleCost: mock(async () => undefined),
    });
    runtime.start({ intervalMs: 60_000, batchSize: 1 });
    await Promise.resolve();
    await runtime.stop();
  });

  test("cancels provider tasks and records cancellation without assuming a refund", async () => {
    const store = new MemoryConversionStore();
    const row = store.seed({ status: "submitted" });
    let reads = 0;
    const cancel = mock(async () => providerJob().tasks[0]!);
    const client: CloudConvertClient = {
      jobs: {
        create: mock(async () => providerJob()),
        all: mock(async () => []),
        get: mock(async () => {
          reads += 1;
          return providerJob({
            tag: row.providerTag,
            status: reads === 1 ? "waiting" : "error",
            tasks: [{ ...providerJob().tasks[0]!, status: reads === 1 ? "processing" : "error" }],
          });
        }),
        wait: mock(async () => providerJob()),
        getExportUrls: mock(() => []),
      },
      tasks: { upload: mock(async () => undefined), cancel },
    };
    const settled: Array<Readonly<{ attemptOutcome: string; failureCode: string | null }>> = [];
    const runtime = createCloudConversionRuntime({
      store,
      ...fundingDependencies(),
      createClient: () => client,
      beginCost: mock(async () => undefined),
      settleCost: async (receipt) => {
        settled.push({
          attemptOutcome: receipt.attemptOutcome ?? "unknown",
          failureCode: receipt.failureCode ?? null,
        });
      },
    });
    const result = await runtime.cancel({ operationKey: row.recoveryHandle, causalHumanUserId: HUMAN_ID });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected cancellation result");
    expect(result.code).toBe("conversion_cancelled");
    expect(result.message).toContain("does not prove a refund");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(settled.some((receipt) => receipt.attemptOutcome === "cancelled"
      && receipt.failureCode === "provider_cancelled")).toBe(true);
    expect(store.row!.status).toBe("cancelled");
  });

  test("persists cancellation while create is in flight and attaches the provider job as cancel-requested", async () => {
    const store = new MemoryConversionStore();
    let finishCreate!: (job: CloudConvertJob) => void;
    const create = mock((config: { tag?: string }) => new Promise<CloudConvertJob>((resolve) => {
      finishCreate = (job) => resolve({
        ...job,
        ...(config.tag === undefined ? {} : { tag: config.tag }),
      });
    }));
    let providerReads = 0;
    const cancelTask = mock(async () => providerJob().tasks[0]!);
    const tagLookup = mock(async () => [] as CloudConvertJob[]);
    const client: CloudConvertClient = {
      jobs: {
        create,
        all: tagLookup,
        get: mock(async () => {
          providerReads += 1;
          return providerJob({
            tag: store.row!.providerTag,
            status: providerReads === 1 ? "waiting" : "error",
            tasks: [{
              ...providerJob().tasks[0]!,
              status: providerReads === 1 ? "processing" : "error",
            }],
          });
        }),
        wait: mock(async () => providerJob()),
        getExportUrls: mock(() => []),
      },
      tasks: {
        upload: mock(async () => undefined),
        cancel: cancelTask,
      },
    };
    const settleCost = mock(async () => undefined);
    const runtime = createCloudConversionRuntime({
      store,
      ...fundingDependencies(),
      createClient: () => client,
      beginCost: mock(async () => undefined),
      settleCost,
    });
    const execution = runtime.execute(request());
    while (create.mock.calls.length === 0) await Promise.resolve();
    const activeLease = await runtime.reconcilePending(4);
    expect(activeLease).toEqual({ inspected: 1, changed: 0 });
    expect(tagLookup).not.toHaveBeenCalled();
    const handle = store.row!.recoveryHandle;
    const cancellation = await runtime.cancel({ operationKey: handle, causalHumanUserId: HUMAN_ID });
    expect(cancellation.status).toBe("error");
    if (cancellation.status !== "error") throw new Error("expected pending cancellation");
    expect(cancellation.code).toBe("conversion_cancel_waiting_for_submission");
    expect(store.row!.status).toBe("submitting");
    expect(store.row!.cancellationRequestedAt).toBeInstanceOf(Date);

    finishCreate(providerJob({ status: "waiting" }));
    const submitted = await execution;
    expect(submitted.status).toBe("error");
    if (submitted.status !== "error") throw new Error("expected cancellation handoff");
    expect(submitted.code).toBe("conversion_cancel_pending");
    expect(store.row!.status).toBe("cancel_requested");

    const restarted = createCloudConversionRuntime({
      store,
      ...fundingDependencies(),
      createClient: () => client,
      beginCost: mock(async () => undefined),
      settleCost,
    });
    expect(await restarted.reconcilePending(4)).toEqual({ inspected: 1, changed: 1 });
    expect(cancelTask).toHaveBeenCalledTimes(1);
    expect(store.row!.status).toBe("cancelled");
  });

  test("requires the original destination authority for a published receipt and keeps cancellation content-free", async () => {
    const store = new MemoryConversionStore();
    const row = store.seed({
      status: "published",
      destinationArtifactId: "10000000-0000-4000-8000-000000000020",
      destinationArtifactRevision: 1,
      publicationArtifactId: "artifact-secret",
      publicationRevisionId: "10000000-0000-4000-8000-000000000099",
      publishedAt: new Date(),
    });
    const runtime = createCloudConversionRuntime({ store, ...fundingDependencies() });
    const afterRevisionChange = await runtime.resume({
      recoveryHandle: row.recoveryHandle,
      causalHumanUserId: HUMAN_ID,
      destination: {
        ...request().destination,
        artifactInternalId: "10000000-0000-4000-8000-000000000020",
        revision: 2,
      },
      maxOutputBytes: 1024,
    });
    expect(afterRevisionChange.status).toBe("published");

    const resumed = await runtime.resume({
      recoveryHandle: row.recoveryHandle,
      causalHumanUserId: HUMAN_ID,
      destination: {
        ...request().destination,
        authorityDigest: sha("different-room-authority"),
      },
      maxOutputBytes: 1024,
    });
    expect(resumed.status).toBe("error");
    if (resumed.status !== "error") throw new Error("expected authority rejection");
    expect(resumed.code).toBe("conversion_destination_authority_changed");
    expect(JSON.stringify(resumed)).not.toContain("artifact-secret");

    const cancelled = await runtime.cancel({
      operationKey: row.recoveryHandle,
      causalHumanUserId: HUMAN_ID,
    });
    expect(cancelled.status).toBe("error");
    if (cancelled.status !== "error") throw new Error("expected completed conversion response");
    expect(cancelled.code).toBe("conversion_already_completed");
    expect(JSON.stringify(cancelled)).not.toContain("artifact-secret");
  });

  test("keeps a finished cancellation race content-free and leaves output for authorized resume", async () => {
    const store = new MemoryConversionStore();
    const row = store.seed({ status: "submitted" });
    const download = mock(async () => new Response(Buffer.from("secret-output")));
    globalThis.fetch = download as unknown as typeof fetch;
    const finished = providerJob({ tag: row.providerTag, status: "finished" });
    const client: CloudConvertClient = {
      jobs: {
        create: mock(async () => finished),
        all: mock(async () => []),
        get: mock(async () => finished),
        wait: mock(async () => finished),
        getExportUrls: mock(() => [{ url: "https://storage.cloudconvert.com/result.pdf" }]),
      },
      tasks: {
        upload: mock(async () => undefined),
        cancel: mock(async () => finished.tasks[0]!),
      },
    };
    const runtime = createCloudConversionRuntime({
      store,
      ...fundingDependencies(),
      createClient: () => client,
      settleCost: mock(async () => undefined),
    });
    const result = await runtime.cancel({ operationKey: row.recoveryHandle, causalHumanUserId: HUMAN_ID });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected finished cancellation race");
    expect(result.code).toBe("conversion_already_completed");
    expect(JSON.stringify(result)).not.toContain("secret-output");
    expect(download).not.toHaveBeenCalled();
    expect(store.row!.status).toBe("provider_finished");
  });

  test("rotates an unrecoverable receipt so later jobs are reconciled", async () => {
    const store = new MemoryConversionStore();
    const blocked = store.seed({
      operationKey: "a".repeat(64),
      recoveryHandle: `cvr_${"a".repeat(32)}`,
      credentialFingerprint: "a".repeat(64),
      status: "submitted",
      updatedAt: new Date(0),
    });
    store.queuedRow = {
      ...blocked,
      operationKey: "b".repeat(64),
      recoveryHandle: `cvr_${"b".repeat(32)}`,
      credentialFingerprint: "b".repeat(64),
      providerJobId: "job-later",
      providerTag: `ntlo_cv_${"b".repeat(32)}`,
      updatedAt: new Date(1),
    };
    const finished = providerJob({ id: "job-later", tag: store.queuedRow.providerTag, status: "finished" });
    const client: CloudConvertClient = {
      jobs: {
        create: mock(async () => finished),
        all: mock(async () => []),
        get: mock(async () => finished),
        wait: mock(async () => finished),
        getExportUrls: mock(() => []),
      },
      tasks: { upload: mock(async () => undefined), cancel: mock(async () => finished.tasks[0]!) },
    };
    const runtime = createCloudConversionRuntime({
      store,
      admitFunding: mock(async () => FUNDING),
      runFunding: async (binding, _intent, callback) => {
        if (binding.credentialFingerprint === blocked.credentialFingerprint) {
          throw new ModelFundingError("personal_credential_stale");
        }
        return callback({
          apiKey: "request-local-key",
          usageFunding: {
            kind: "personal",
            humanUserId: HUMAN_ID,
            payerHumanId: HUMAN_ID,
            providerRoute: "cloudconvert",
            credentialId: CREDENTIAL_ID,
            credentialRevision: 3,
          },
        });
      },
      createClient: () => client,
      settleCost: mock(async () => undefined),
    });
    expect(await runtime.reconcilePending(1)).toEqual({ inspected: 1, changed: 0 });
    expect(await runtime.reconcilePending(1)).toEqual({ inspected: 1, changed: 1 });
    expect(store.row!.operationKey).toBe("b".repeat(64));
    expect(store.row!.status).toBe("provider_finished");
  });
});
