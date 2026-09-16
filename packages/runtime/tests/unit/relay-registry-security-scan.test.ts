import { describe, expect, test, spyOn } from "bun:test";
import type { RelayServerMessage } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

const args = {
  expectedCurrentFolder: "/projects",
  operation: { version: "security-scan-v1", operation: "start", mode: "deep_research", targetDirectory: "repo" },
  trustedContext: { taskId: "00000000-0000-4000-8000-000000000001", taskRunId: "00000000-0000-4000-8000-000000000002", toolCallId: "start", modelId: "openai:test" },
};
function setup() {
  const registry = new InMemoryRelayRegistry();
  const messages: RelayServerMessage[] = [];
  registry.register("desktop", "owner", { profile: "desktop-agent", canReadWorkspace: true }, message => messages.push(message), 4);
  return { registry, messages };
}
describe("Task-owned security scanner lifetime", () => {
  test("keeps startup owned by Task cancellation instead of the generic 60s timer", async () => {
    const { registry, messages } = setup();
    const controller = new AbortController();
    const timer = spyOn(globalThis, "setTimeout");
    let outcome: Promise<unknown>;
    try {
      outcome = registry.dispatch("desktop", { toolName: "security_scan", impact: "read-only", approvalObtained: false, args, signal: controller.signal }).catch((error: unknown) => error);
      expect(timer).not.toHaveBeenCalled();
    } finally { timer.mockRestore(); }
    expect(messages[0]?.type).toBe("relay:dispatch");
    controller.abort();
    expect(messages.some(message => message.type === "relay:cancel")).toBe(true);
    expect(await outcome!).toBeInstanceOf(Error);
  });
  test("retains explicit deadlines and sends cancellation before abandoning local probes", async () => {
    const { registry, messages } = setup();
    const outcome = registry.dispatch("desktop", { toolName: "security_scan", impact: "read-only", approvalObtained: false, args, timeout: 1, signal: new AbortController().signal });
    expect(outcome).rejects.toThrow("timed out");
    expect(messages.map(message => message.type)).toEqual(["relay:dispatch", "relay:cancel"]);
  });
  test("relay loss requests cleanup on the exact original connection", async () => {
    const { registry, messages } = setup();
    const outcome = registry.dispatch("desktop", { toolName: "security_scan", impact: "read-only", approvalObtained: false, args, signal: new AbortController().signal }).catch((error: unknown) => error);
    await registry.unregister("desktop");
    expect(messages.map(message => message.type)).toEqual(["relay:dispatch", "relay:cancel"]);
    expect(await outcome).toBeInstanceOf(Error);
  });

  test("malformed or unowned scan calls do not opt out of the ordinary deadline", async () => {
    for (const request of [{ args }, { args: {}, signal: new AbortController().signal }]) {
      const { registry } = setup();
      const timer = spyOn(globalThis, "setTimeout");
      const outcome = registry.dispatch("desktop", { toolName: "security_scan", impact: "read-only", approvalObtained: false, ...request }).catch((error: unknown) => error);
      try { expect(timer).toHaveBeenCalled(); } finally { timer.mockRestore(); }
      await registry.unregister("desktop");
      expect(await outcome).toBeInstanceOf(Error);
    }
  });
});


test("security progress is confined to the active correlated scanner call", async () => {
  const { registry, messages } = setup();
  const seen: unknown[] = [];
  const controller = new AbortController();
  const outcome = registry.dispatch("desktop", { toolName: "security_scan", impact: "read-only",
    approvalObtained: false, args, signal: controller.signal,
    onSecurityScanProgress: (progress) => seen.push(progress),
  }).catch((error: unknown) => error);
  const dispatched = messages.find((message) => message.type === "relay:dispatch");
  if (!dispatched || dispatched.type !== "relay:dispatch") throw new Error("missing dispatch");
  const progress = { type: "relay:security-scan-progress" as const,
    correlationId: dispatched.correlationId, stage: "preparing_scanners" as const };
  registry.acceptSecurityScanProgress({ ...progress, correlationId: "another-relay:unknown" });
  expect(seen).toHaveLength(0);
  registry.acceptSecurityScanProgress(progress);
  expect(seen).toEqual([progress]);
  controller.abort();
  await outcome;
  registry.acceptSecurityScanProgress(progress);
  expect(seen).toHaveLength(1);
});
