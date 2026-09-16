import { describe, expect, test } from "bun:test";
import {
  HarnessControlPlane,
  HarnessControlPlaneError,
  HARNESS_MAX_REQUEST_OPTIONS,
  HARNESS_MAX_SUMMARY_ENTRIES,
  HARNESS_MAX_TEXT_BYTES,
  HARNESS_MAX_USAGE_DIMENSIONS,
  type HarnessAttribution,
  type HarnessCapability,
  type HarnessCapabilityState,
  type HarnessDescriptor,
  type HarnessDriver,
  type HarnessEvent,
  type HarnessExecutionAdmission,
  type HarnessItemAttribution,
  type HarnessRegistration,
  type HarnessRequest,
} from "../../src/harness";

const CAPABILITIES: readonly HarnessCapability[] = [
  "execution",
  "resume",
  "stop",
  "steer",
  "requests",
];

function descriptor(
  id: string,
  overrides: Partial<Record<HarnessCapability, HarnessCapabilityState>> = {},
): HarnessDescriptor {
  const declaredCapabilities = {} as Record<HarnessCapability, HarnessCapabilityState>;
  for (const capability of CAPABILITIES) {
    declaredCapabilities[capability] = overrides[capability] ?? "supported";
  }
  return {
    id,
    displayName: id,
    setup: { installation: "on_demand", activation: "user_initiated" },
    integration: { authentication: "existing_session", resume: "resume_existing_session" },
    declaredCapabilities,
  };
}

function driver(input: {
  probe?: Partial<Record<HarnessCapability, HarnessCapabilityState>>;
  steer?: boolean;
} = {}): HarnessDriver {
  return {
    execution: {
      async *start() {
        yield semanticEvents()[0]!;
      },
      ...(input.steer
        ? { steer: async () => undefined }
        : {}),
    },
    probeCapabilities: async () => input.probe ?? allSupported(),
  };
}

function attribution(overrides: Partial<HarnessAttribution> = {}): HarnessAttribution {
  return {
    bindingId: "binding-1",
    bindingGeneration: "binding-generation-1",
    taskId: "task-1",
    roomId: "room-1",
    vendorSessionId: "session-1",
    vendorTurnId: "turn-1",
    vendorItemId: null,
    ...overrides,
  };
}

function itemAttribution(vendorItemId: string): HarnessItemAttribution {
  return { ...attribution(), vendorItemId };
}

function semanticEvents(): readonly HarnessEvent[] {
  const item = itemAttribution("item-1");
  return [
    { kind: "output_delta", attribution: item, text: "preview" },
    { kind: "assistant_completed", attribution: item, text: "final answer" },
    { kind: "progress", attribution: attribution(), message: "Thinking" },
    {
      kind: "command_summary",
      attribution: attribution(),
      commands: [{ summary: "checked status", status: "completed" }],
    },
    {
      kind: "patch_summary",
      attribution: attribution(),
      files: [{ path: "src/example.ts", change: "modified" }],
      summary: "Updated one file",
    },
    {
      kind: "usage",
      attribution: attribution(),
      dimensions: [{ name: "input_tokens", value: 42 }],
    },
    { kind: "terminal", attribution: attribution(), status: "completed" },
    {
      kind: "terminal",
      attribution: attribution(),
      status: "failed",
      code: "upstream_failure",
      message: "The harness could not finish.",
    },
    {
      kind: "terminal",
      attribution: attribution(),
      status: "interrupted",
      code: "user_stop",
    },
  ];
}

function semanticRequests(): readonly HarnessRequest[] {
  return [
    {
      kind: "command_approval_required",
      requestId: "request-approval",
      vendorRequestId: "vendor-request-approval",
      attribution: attribution(),
      ownerId: "owner-1",
      expiresAt: "2026-07-29T12:00:00.000Z",
      options: ["approve", "approve_for_session", "deny", "cancel"],
      reason: "host_local_only",
      command: { detail: "host_local_only", actionKinds: ["read"] },
    },
    {
      kind: "permissions_approval_required",
      requestId: "request-permissions",
      vendorRequestId: "vendor-request-permissions",
      attribution: attribution(),
      ownerId: "owner-1",
      expiresAt: "2026-07-29T12:00:00.000Z",
      reason: "host_local_only",
      permissions: {
        network: { enabled: true },
        fileSystem: { readPathCount: 1, writePathCount: 0, entryCount: 0, pathDetail: "host_local_only" },
      },
    },
    {
      kind: "permission_selection_required",
      requestId: "request-acp-permission",
      vendorRequestId: null,
      attribution: attribution({ vendorSessionId: "acp-session", vendorTurnId: null, vendorItemId: "tool-1" }),
      ownerId: "owner-1",
      expiresAt: "2026-07-29T12:00:00.000Z",
      options: [
        { id: "allow_once", label: "Allow once", semanticHint: "allow_once" },
        { id: "reject_once", label: "Reject", semanticHint: "reject_once" },
      ],
      tool: { title: "Edit file", kind: "edit" },
    },
    {
      kind: "user_input_required",
      requestId: "request-input",
      vendorRequestId: "vendor-request-input",
      attribution: attribution(),
      ownerId: "owner-1",
      expiresAt: null,
      autoResolutionMs: null,
      questions: [{
        id: "next",
        header: "Next step",
        prompt: "Which option should continue?",
        secret: false,
        multiSelect: false,
        allowOther: false,
        options: [{ id: "continue", label: "Continue", description: "Proceed with the task." }],
      }],
    },
  ];
}

const EXAMPLE_ADMISSION: HarnessExecutionAdmission = {
  jobId: "job-1",
  taskId: "task-1",
  taskRunId: "task-run-1",
  ownerId: "owner-1",
  requesterId: "requester-1",
  roomId: "room-1",
  laneKey: "room:room-1",
  source: "room",
  parentTaskId: null,
  binding: { id: "binding-1", generation: "binding-generation-1" },
  workspace: {
    id: "workspace-1",
    currentFolderReceiptId: "folder-receipt-1",
    pairingGeneration: "pairing-generation-1",
  },
  profile: { id: "profile-1", generation: "profile-generation-1" },
  posture: { id: "full_access", generation: "posture-generation-1" },
  prompt: "Please inspect the repository.",
  abortSignal: new AbortController().signal,
};

function allSupported(): Record<HarnessCapability, HarnessCapabilityState> {
  return {
    execution: "supported",
    resume: "supported",
    stop: "supported",
    steer: "supported",
    requests: "supported",
  };
}

function registration(
  id: string,
  createDriver: HarnessRegistration["createDriver"] = () => driver(),
): HarnessRegistration {
  return { descriptor: descriptor(id), createDriver };
}

async function expectHarnessError(
  promise: Promise<unknown>,
  expected: Partial<HarnessControlPlaneError>,
): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(HarnessControlPlaneError);
  expect(thrown).toMatchObject(expected);
}

describe("HarnessControlPlane", () => {
  test("defines the full bounded semantic event/request contract over admitted facts", () => {
    const events = semanticEvents();
    const requests = semanticRequests();

    expect(events.map((event) => event.kind)).toEqual([
      "output_delta",
      "assistant_completed",
      "progress",
      "command_summary",
      "patch_summary",
      "usage",
      "terminal",
      "terminal",
      "terminal",
    ]);
    expect(events.filter((event) => event.kind === "terminal").map((event) => event.status)).toEqual([
      "completed",
      "failed",
      "interrupted",
    ]);
    for (const event of events) {
      expect(event.attribution).toMatchObject({
        bindingGeneration: "binding-generation-1",
        taskId: "task-1",
        roomId: "room-1",
        vendorSessionId: "session-1",
        vendorTurnId: "turn-1",
      });
    }

    expect(requests.map((request) => request.kind)).toEqual([
      "command_approval_required",
      "permissions_approval_required",
      "permission_selection_required",
      "user_input_required",
    ]);
    for (const request of requests) {
      expect(request.attribution.bindingGeneration).toBe("binding-generation-1");
      expect(request.attribution.taskId).toBe("task-1");
    }

    const delta = events[0];
    const completed = events[1];
    const commands = events[3];
    const patch = events[4];
    const usage = events[5];
    if (
      delta?.kind !== "output_delta" ||
      completed?.kind !== "assistant_completed" ||
      commands?.kind !== "command_summary" ||
      patch?.kind !== "patch_summary" ||
      usage?.kind !== "usage"
    ) {
      throw new Error("test fixtures must retain their declared discriminants");
    }
    expect(delta.attribution.vendorItemId).toBe("item-1");
    expect(completed.attribution.vendorItemId).toBe("item-1");
    expect(Buffer.byteLength(delta.text, "utf8")).toBeLessThanOrEqual(HARNESS_MAX_TEXT_BYTES);
    expect(Buffer.byteLength(completed.text, "utf8")).toBeLessThanOrEqual(HARNESS_MAX_TEXT_BYTES);
    expect(commands.commands.length).toBeLessThanOrEqual(HARNESS_MAX_SUMMARY_ENTRIES);
    expect(patch.files.length).toBeLessThanOrEqual(HARNESS_MAX_SUMMARY_ENTRIES);
    expect(usage.dimensions.length).toBeLessThanOrEqual(HARNESS_MAX_USAGE_DIMENSIONS);

    const permission = requests[2];
    if (permission?.kind !== "permission_selection_required") {
      throw new Error("test fixture must retain opaque ACP permission choices");
    }
    expect(permission.attribution).toMatchObject({ vendorSessionId: "acp-session", vendorTurnId: null, vendorItemId: "tool-1" });
    expect(permission.options).toEqual([
      { id: "allow_once", label: "Allow once", semanticHint: "allow_once" },
      { id: "reject_once", label: "Reject", semanticHint: "reject_once" },
    ]);

    const input = requests[3];
    if (input?.kind !== "user_input_required" || !input.questions[0]?.options) {
      throw new Error("test fixture must retain bounded questions");
    }
    expect(input.questions[0].options.length).toBeLessThanOrEqual(HARNESS_MAX_REQUEST_OPTIONS);

    expect(EXAMPLE_ADMISSION).toMatchObject({
      taskRunId: "task-run-1",
      requesterId: "requester-1",
      binding: { generation: "binding-generation-1" },
      workspace: { currentFolderReceiptId: "folder-receipt-1" },
      profile: { generation: "profile-generation-1" },
      posture: { id: "full_access" },
    });
  });

  test("keeps native user-input requests correlated on an admitted execution stream", async () => {
    const request = semanticRequests()[3]!;
    const fake: HarnessDriver = {
      execution: {
        async *start() {
          yield request;
        },
      },
    };

    const first = await fake.execution.start(EXAMPLE_ADMISSION)[Symbol.asyncIterator]().next();
    expect(first.value).toMatchObject({
      kind: "user_input_required",
      requestId: "request-input",
      attribution: { taskId: "task-1", bindingGeneration: "binding-generation-1" },
    });
  });

  test("keeps descriptors import-safe and constructs a driver only on selection", async () => {
    let calls = 0;
    const plane = new HarnessControlPlane([
      registration("fake", () => {
        calls += 1;
        return driver();
      }),
    ]);

    expect(plane.listDescriptors()).toEqual([descriptor("fake")]);
    expect(calls).toBe(0);

    await plane.driverFor("fake");
    await plane.driverFor("fake");
    expect(calls).toBe(1);
  });

  test("rejects duplicate and unknown ids with stable typed errors", async () => {
    let duplicate: unknown;
    try {
      new HarnessControlPlane([registration("same"), registration("same")]);
    } catch (error) {
      duplicate = error;
    }
    expect(duplicate).toBeInstanceOf(HarnessControlPlaneError);
    expect(duplicate).toMatchObject({ code: "harness_duplicate_id", harnessId: "same" });

    const plane = new HarnessControlPlane([]);
    await expectHarnessError(plane.driverFor("missing"), {
      code: "harness_unknown_id",
      harnessId: "missing",
    });
  });

  test("keeps unknown capability distinct from unsupported", async () => {
    const plane = new HarnessControlPlane([
      registration("unknown", () => driver({ probe: { execution: "unknown" } })),
      {
        descriptor: descriptor("unsupported", { steer: "unsupported" }),
        createDriver: () => {
          throw new Error("an unsupported operation must not initialize the driver");
        },
      },
    ]);

    await expectHarnessError(plane.requireCapability("unknown", "execution"), {
      code: "harness_capability_unknown",
      capability: "execution",
    });
    await expectHarnessError(plane.requireCapability("unsupported", "steer"), {
      code: "harness_capability_unsupported",
      capability: "steer",
    });
  });

  test("requires both a confirmed capability and its concrete operation", async () => {
    const plane = new HarnessControlPlane([registration("fake")]);

    await expectHarnessError(plane.requireOperation("fake", "steer"), {
      code: "harness_operation_unsupported",
      capability: "steer",
      operation: "steer",
    });
  });

  test("single-flights a selected driver and leaves a broken optional driver isolated", async () => {
    let goodCalls = 0;
    let brokenCalls = 0;
    let releaseGood: (() => void) | undefined;
    const goodCreated = new Promise<void>((resolve) => {
      releaseGood = resolve;
    });
    const plane = new HarnessControlPlane([
      registration("good", async () => {
        goodCalls += 1;
        await goodCreated;
        return driver();
      }),
      registration("broken", () => {
        brokenCalls += 1;
        throw new Error("not installed");
      }),
    ]);

    const first = plane.driverFor("good");
    const second = plane.driverFor("good");
    expect(goodCalls).toBe(1);
    releaseGood?.();
    expect(await first).toBe(await second);

    await expectHarnessError(plane.driverFor("broken"), {
      code: "harness_factory_failed",
      harnessId: "broken",
    });
    expect(brokenCalls).toBe(1);
    expect(await plane.driverFor("good")).toBe(await first);
  });

  test("does not cache a failed factory attempt", async () => {
    let attempts = 0;
    const plane = new HarnessControlPlane([
      registration("retryable", () => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return driver();
      }),
    ]);

    await expectHarnessError(plane.driverFor("retryable"), {
      code: "harness_factory_failed",
    });
    const retried = await plane.driverFor("retryable");
    expect(typeof retried.execution.start).toBe("function");
    expect(attempts).toBe(2);
  });
});
