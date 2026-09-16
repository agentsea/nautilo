import { describe, expect, test } from "bun:test";
import {
  createVideoHostSessionManager,
  type VideoHostBinding,
  type VideoHostProject,
} from "./video-host-session";

const binding: VideoHostBinding = {
  targetKey: "artifact:one",
  userId: "user-one",
  sourceHash: "source-one",
  roomId: "room-one",
};
const project = (projectRevision: number): VideoHostProject => ({
  projectArtifactId: "artifact-one",
  projectRevision,
});
const expiry = (milliseconds: number): string => new Date(milliseconds).toISOString();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("createVideoHostSessionManager", () => {
  test("reuses an unexpired session when the saved project revision is unchanged", async () => {
    let reads = 0;
    let issues = 0;
    const revoked: string[] = [];
    const manager = createVideoHostSessionManager({
      readProject: async () => { reads += 1; return project(1); },
      issue: async () => { issues += 1; return { attestationToken: "token-one", expiresAt: expiry(10_000) }; },
      revoke: async token => { revoked.push(token); },
      now: () => 1_000,
    });

    const first = await manager.get(binding);
    const second = await manager.get(binding);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(reads).toBe(3);
    expect(issues).toBe(1);
    expect(revoked).toEqual([]);
  });

  test("keeps the resolved project room and fences room changes during issuance", async () => {
    let roomId = "project-room";
    const revoked: string[] = [];
    const manager = createVideoHostSessionManager({
      readProject: async () => ({ ...project(1), roomId }),
      issue: async () => ({ attestationToken: roomId, expiresAt: expiry(10_000) }),
      revoke: async token => { revoked.push(token); }, now: () => 1000,
    });
    expect((await manager.get(binding))?.roomId).toBe("project-room");
    roomId = "moved-room";
    expect((await manager.get(binding))?.roomId).toBe("moved-room");
    expect(revoked).toEqual(["project-room"]);
    const racing = createVideoHostSessionManager({
      readProject: async () => ({ ...project(1), roomId }),
      issue: async () => { roomId = "changed-during-issue"; return { attestationToken: "raced", expiresAt: expiry(10_000) }; },
      revoke: async token => { revoked.push(token); }, now: () => 1000,
    });
    expect(await racing.get(binding)).toBeNull();
    expect(revoked).toContain("raced");
  });

  test("renews on revision change and revokes the superseded token", async () => {
    let revision = 1;
    let issues = 0;
    const revoked: string[] = [];
    const manager = createVideoHostSessionManager({
      readProject: async () => project(revision),
      issue: async () => ({ attestationToken: `token-${++issues}`, expiresAt: expiry(10_000) }),
      revoke: async token => { revoked.push(token); },
      now: () => 1_000,
    });
    expect((await manager.get(binding))?.token).toBe("token-1");

    revision = 2;
    const renewed = await manager.get(binding);

    expect(renewed).toMatchObject({ token: "token-2", projectRevision: 2 });
    expect(revoked).toEqual(["token-1"]);
  });

  test("renews an expired session and revokes its old token", async () => {
    let now = 1_000;
    let issues = 0;
    const revoked: string[] = [];
    const manager = createVideoHostSessionManager({
      readProject: async () => project(1),
      issue: async () => ({ attestationToken: `token-${++issues}`, expiresAt: expiry(now + 100) }),
      revoke: async token => { revoked.push(token); },
      now: () => now,
    });
    expect((await manager.get(binding))?.token).toBe("token-1");

    now += 100;
    expect((await manager.get(binding))?.token).toBe("token-2");
    expect(revoked).toEqual(["token-1"]);
  });

  test("shares one issuance across concurrent gets for the same binding", async () => {
    const issued = deferred<{ attestationToken: string; expiresAt: string }>();
    let issues = 0;
    const manager = createVideoHostSessionManager({
      readProject: async () => project(1),
      issue: () => { issues += 1; return issued.promise; },
      revoke: async () => undefined,
      now: () => 1_000,
    });

    const first = manager.get(binding);
    const second = manager.get(binding);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(issues).toBe(1);
    issued.resolve({ attestationToken: "shared-token", expiresAt: expiry(10_000) });

    expect((await first)?.token).toBe("shared-token");
    expect((await second)?.token).toBe("shared-token");
    expect(issues).toBe(1);
  });

  test.each([
    ["target", { ...binding, targetKey: "artifact:two" }],
    ["source", { ...binding, sourceHash: "source-two" }],
    ["user", { ...binding, userId: "user-two" }],
  ] as const)("a %s switch revokes a late token from the prior issuance", async (_case, nextBinding) => {
    const firstIssue = deferred<{ attestationToken: string; expiresAt: string }>();
    let issues = 0;
    const revoked: string[] = [];
    const manager = createVideoHostSessionManager({
      readProject: async candidate => ({
        projectArtifactId: candidate.targetKey === binding.targetKey ? "artifact-one" : "artifact-two",
        projectRevision: 1,
      }),
      issue: async () => {
        issues += 1;
        return issues === 1
          ? firstIssue.promise
          : { attestationToken: "next-token", expiresAt: expiry(10_000) };
      },
      revoke: async token => { revoked.push(token); },
      now: () => 1_000,
    });

    const stale = manager.get(binding);
    await Promise.resolve();
    const current = manager.get(nextBinding);
    firstIssue.resolve({ attestationToken: "late-token", expiresAt: expiry(10_000) });

    expect(await stale).toBeNull();
    expect((await current)?.token).toBe("next-token");
    expect(revoked).toContain("late-token");
  });

  test("clear during issuance revokes the late token and leaves no reusable session", async () => {
    const issued = deferred<{ attestationToken: string; expiresAt: string }>();
    let issues = 0;
    const revoked: string[] = [];
    const manager = createVideoHostSessionManager({
      readProject: async () => project(1),
      issue: () => { issues += 1; return issues === 1 ? issued.promise : Promise.resolve({ attestationToken: "fresh-token", expiresAt: expiry(10_000) }); },
      revoke: async token => { revoked.push(token); },
      now: () => 1_000,
    });

    const stale = manager.get(binding);
    await Promise.resolve();
    manager.clear();
    issued.resolve({ attestationToken: "late-token", expiresAt: expiry(10_000) });

    expect(await stale).toBeNull();
    expect(revoked).toEqual(["late-token"]);
    expect((await manager.get(binding))?.token).toBe("fresh-token");
  });

  test("fails closed and revokes the issued token when the revision changes while minting", async () => {
    let reads = 0;
    const revoked: string[] = [];
    const manager = createVideoHostSessionManager({
      readProject: async () => project(++reads),
      issue: async () => ({ attestationToken: "raced-token", expiresAt: expiry(10_000) }),
      revoke: async token => { revoked.push(token); },
      now: () => 1_000,
    });

    expect(await manager.get(binding)).toBeNull();
    expect(revoked).toEqual(["raced-token"]);
  });

  test("propagates an initial project read error and permits a later retry", async () => {
    let reads = 0;
    const manager = createVideoHostSessionManager({
      readProject: async () => { if (++reads === 1) throw new Error("read failed"); return project(1); },
      issue: async () => ({ attestationToken: "retry-token", expiresAt: expiry(10_000) }),
      revoke: async () => undefined,
      now: () => 1_000,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(manager.get(binding)).rejects.toThrow("read failed");
    expect((await manager.get(binding))?.token).toBe("retry-token");
  });

  test("propagates issuance errors without creating a session", async () => {
    let issues = 0;
    const manager = createVideoHostSessionManager({
      readProject: async () => project(1),
      issue: async () => { issues += 1; throw new Error("issue failed"); },
      revoke: async () => undefined,
      now: () => 1_000,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(manager.get(binding)).rejects.toThrow("issue failed");
    // A rejection clears the shared pending promise, so a later get retries.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(manager.get(binding)).rejects.toThrow("issue failed");
    expect(issues).toBe(2);
  });

  test("revokes a minted token when the validation read fails", async () => {
    let reads = 0;
    const revoked: string[] = [];
    const manager = createVideoHostSessionManager({
      readProject: async () => { if (++reads === 2) throw new Error("validation read failed"); return project(1); },
      issue: async () => ({ attestationToken: "unvalidated-token", expiresAt: expiry(10_000) }),
      revoke: async token => { revoked.push(token); },
      now: () => 1_000,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(manager.get(binding)).rejects.toThrow("validation read failed");
    expect(revoked).toEqual(["unvalidated-token"]);
  });
});
