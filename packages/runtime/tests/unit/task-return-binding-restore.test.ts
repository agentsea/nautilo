import { beforeEach, expect, test } from "bun:test";
import type { RelayCapabilities } from "@nautilo/relay";
import { parseTaskReportBackContinuation } from "@nautilo/agent";
import { registerTaskReturnBinding, resolveTaskReturnBinding, restoreTaskReturnBindingFromCheckpoint,
  resolveTaskLiveMiniAppBinding, taskReturnBindingRegistryForTests } from "../../src/tasks/task-return-binding";

const createdAt = 1_000_000;
const context = { ownerId: "owner", relayId: "relay", relaySessionId: "old-socket", desktopSessionId: "desktop",
  pairingGeneration: "pair", currentFolder: "/repo", workspacePath: "/workspace", browserSessionId: "browser" };
function live(overrides: Partial<{ owner: string; desktop: string; pairing: string; socket: string; fresh: boolean; caps: RelayCapabilities | null }> = {}) {
  const fields = { owner: "owner", desktop: "desktop", pairing: "pair", socket: "new-socket", fresh: true,
    caps: { profile: "desktop-agent", canReadWorkspace: true, canControlBrowser: true, browserSessionId: "browser",
      currentFolderRoot: "/repo", workspaceRoot: "/workspace" } as RelayCapabilities | null, ...overrides };
  return { getUserId: () => fields.owner, getDesktopSessionId: () => fields.desktop, getPairingGeneration: () => fields.pairing,
    getRelaySessionId: () => fields.socket, getCapabilities: () => fields.caps, isRelayHeartbeatFresh: () => fields.fresh };
}
function fixture() {
  registerTaskReturnBinding("task", context, live({ socket: "old-socket" }), createdAt);
  const continuation = parseTaskReportBackContinuation(JSON.parse(JSON.stringify(
    resolveTaskReturnBinding("task", "owner", live({ socket: "old-socket" }), createdAt),
  )) as unknown);
  return { taskId: "task", taskRunId: "run", ownerId: "owner", graphThreadId: "graph", taskCreatedAt: new Date(createdAt - 100),
    checkpointState: { taskRun: true, userId: "owner", currentTaskId: "task", currentTaskRunId: "run", langgraphThreadId: "graph",
      taskReportBackContinuation: continuation } };
}
beforeEach(() => taskReturnBindingRegistryForTests.clear());

test("a fresh process restores the exact Desktop grant with a new socket and original expiry", () => {
  const input = fixture();
  taskReturnBindingRegistryForTests.clear();
  const canonical = JSON.stringify(input.checkpointState);
  expect(restoreTaskReturnBindingFromCheckpoint(input, null, createdAt + 400)).toEqual({ status: "relay_disconnected" });
  expect(JSON.stringify(input.checkpointState)).toBe(canonical);
  const restored = restoreTaskReturnBindingFromCheckpoint(input, live(), createdAt + 500);
  expect(restored).toEqual({ ...input.checkpointState.taskReportBackContinuation, relaySessionId: "new-socket" });
  expect(resolveTaskReturnBinding("task", "owner", live(), createdAt + 501)).toEqual(restored);
  expect(taskReturnBindingRegistryForTests.writerReviewSize()).toBe(0);
  expect(resolveTaskLiveMiniAppBinding("task", "owner").status).toBe("not_captured");
  expect(resolveTaskReturnBinding("task", "owner", live(), createdAt + 24 * 60 * 60 * 1000 + 1).status).toBe("not_captured");
});

test.each([
  ["different owner", { owner: "foreign" }, "relay_owner_mismatch"],
  ["new Desktop launch", { desktop: "replacement" }, "relay_replaced"],
  ["new pairing", { pairing: "replacement" }, "relay_replaced"],
  ["stale heartbeat", { fresh: false }, "relay_disconnected"],
  ["missing capabilities", { caps: null }, "relay_disconnected"],
  ["changed folder", { caps: { ...live().getCapabilities()!, currentFolderRoot: "/other" } }, "folder_changed"],
  ["changed workspace", { caps: { ...live().getCapabilities()!, workspaceRoot: "/other" } }, "folder_invalid"],
  ["revoked capabilities", { caps: { ...live().getCapabilities()!, canReadWorkspace: false, canControlBrowser: false } }, "capability_revoked"],
] as const)("checkpoint recovery denies %s", (_label, override, status) => {
  const input = fixture(); taskReturnBindingRegistryForTests.clear();
  expect(restoreTaskReturnBindingFromCheckpoint(input, live(override), createdAt + 500)).toEqual({ status });
  expect(taskReturnBindingRegistryForTests.size()).toBe(0);
});

test.each(["userId", "currentTaskId", "currentTaskRunId", "langgraphThreadId"] as const)("foreign checkpoint %s cannot restore authority", (field) => {
  const input = fixture(); taskReturnBindingRegistryForTests.clear();
  input.checkpointState[field] = "foreign";
  expect(restoreTaskReturnBindingFromCheckpoint(input, live(), createdAt + 500).status).toBe("not_captured");
});

test("legacy checkpoints use the earlier Task creation time; expired or future captures never revive", () => {
  const input = fixture(); taskReturnBindingRegistryForTests.clear();
  const legacy = { ...input.checkpointState.taskReportBackContinuation };
  delete legacy.bindingCapturedAt;
  input.checkpointState.taskReportBackContinuation = legacy;
  expect(restoreTaskReturnBindingFromCheckpoint(input, live(), createdAt + 500).bindingCapturedAt).toBe(createdAt - 100);
  taskReturnBindingRegistryForTests.clear();
  expect(restoreTaskReturnBindingFromCheckpoint(input, live(), createdAt + 24 * 60 * 60 * 1000).status).toBe("not_captured");
  input.checkpointState.taskReportBackContinuation = { ...input.checkpointState.taskReportBackContinuation, bindingCapturedAt: createdAt + 1000 };
  expect(restoreTaskReturnBindingFromCheckpoint(input, live(), createdAt).status).toBe("not_captured");
});

test("browser replacement does not substitute a browser or prevent exact file continuation", () => {
  const input = fixture(); taskReturnBindingRegistryForTests.clear();
  const restored = restoreTaskReturnBindingFromCheckpoint(input, live({ caps: { ...live().getCapabilities()!, browserSessionId: "new-browser" } }), createdAt + 500);
  expect(restored.status).toBe("available");
  expect(restored.browserStatus).toBe("browser_session_expired");
  expect(restored.browserSessionId).toBeUndefined();
});
