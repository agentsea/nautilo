import { beforeAll, expect, mock, test } from "bun:test";
import { createWorkspaceGuard, type RelayDispatchRequest } from "@nautilo/relay";
import { RunShellOutputArtifactStore } from "../../electron/run-shell-output-continuity";
mock.module("electron", () => ({ app: { getPath: () => "/tmp/synthetic-desktop" } }));
let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;
beforeAll(async () => { ({ makeDispatchHandler } = await import("../../electron/relay")); });
const owner = { instanceId: "instance-fixture", userId: "human-fixture", relayId: "relay-fixture", desktopSessionId: "desktop-fixture" };
const request = (toolName: string, args: Record<string, unknown>): RelayDispatchRequest => ({ correlationId: "request-fixture", toolName, args, impact: "read-only", approvalObtained: false });
test("retained output is read before filesystem, profile, or sandbox preparation", async () => {
  const store = new RunShellOutputArtifactStore();
  const draft = store.createDraft(owner); draft.append("stdout", Buffer.from("retained output"), 15); const reference = draft.commit().reference;
  const forbidden = async () => { throw new Error("Read must not prepare execution"); };
  const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
    runShellOutputArtifactStore: store, workstationShellBindingAuthority: forbidden, createSandbox: forbidden,
  });
  try {
    expect(await handler({ ...request("read_shell_output", { operation: "search", reference, query: "retained" }), runShellOwnerBinding: owner }))
      .toMatchObject({ status: "ok", result: { reference } });
    expect(await handler({ ...request("read_shell_output", { operation: "page", reference }), runShellOwnerBinding: { ...owner, userId: "foreign" } }))
      .toMatchObject({ status: "error", errorCode: "RUN_SHELL_OUTPUT_ARTIFACT_NOT_FOUND" });
  } finally { store.clear(); }
});
