import { describe, expect, test } from "bun:test";
import { WorkspaceShareSession } from "./workspace-share-session";

const mara = { id: "mara", displayName: "Mara", handle: "mara" };
const jun = { id: "jun", displayName: "Jun", handle: "jun" };
describe("workspace sharing captured delivery", () => {
  test("captures artifact/Room and retries only failures; already_shared is success", async () => {
    const calls: unknown[][] = [];
    let fail = true;
    const session = new WorkspaceShareSession({ artifactId: "file", roomId: "source-room", isCurrent: () => true,
      client: { shareWorkspaceArtifact: async (...args) => { calls.push(args); if (args[1] === "jun" && fail) throw Error("offline"); return { status: "already_shared" }; } } });
    await session.deliver([mara, jun, mara], () => {});
    expect(session.deliveries.map(item => item.status)).toEqual(["shared", "failed"]);
    expect(calls[0]).toEqual(["file", "mara", { roomId: "source-room" }]);
    fail = false;
    await session.deliver([], () => {});
    expect(calls.map(call => call[1])).toEqual(["mara", "jun", "jun"]);
    expect(session.deliveries.every(item => item.status === "shared")).toBe(true);
  });
  test("rejects double-submit and stops undispatched work after identity changes", async () => {
    let current = true;
    let release!: () => void;
    const calls: string[] = [];
    const session = new WorkspaceShareSession({ artifactId: "file", isCurrent: () => current,
      client: { shareWorkspaceArtifact: async (_file, person) => { calls.push(person); await new Promise<void>(resolve => { release = resolve; }); return { status: "shared" }; } } });
    const first = session.deliver([mara, jun], () => {});
    await session.deliver([jun], () => {});
    current = false; release(); await first;
    expect(calls).toEqual(["mara"]);
    expect(session.busy).toBe(false);
  });
  test("unmount fences completion notifications and queued sends", async () => {
    let release!: () => void;
    let notifications = 0;
    const calls: string[] = [];
    const session = new WorkspaceShareSession({ artifactId: "file", isCurrent: () => true,
      client: { shareWorkspaceArtifact: async (_file, person) => { calls.push(person); await new Promise<void>(resolve => { release = resolve; }); return { status: "shared" }; } } });
    const pending = session.deliver([mara, jun], () => { notifications++; });
    session.dispose(); release(); await pending;
    await session.deliver([jun], () => { notifications++; });
    expect(calls).toEqual(["mara"]);
    expect(notifications).toBe(1);
  });
  test("empty selection does not begin a delivery", async () => {
    const session = new WorkspaceShareSession({ artifactId: "file", isCurrent: () => true, client: { shareWorkspaceArtifact: async () => { throw Error("unexpected"); } } });
    await session.deliver([], () => { throw Error("unexpected"); });
    expect(session.attempted).toBe(false);
  });
});
