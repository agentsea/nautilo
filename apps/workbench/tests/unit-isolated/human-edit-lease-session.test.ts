import { describe, expect, test } from "bun:test";
import type {
  HumanEditLeaseRecord,
  HumanEditLeaseStoreResult,
} from "@nautilo/types";
import {
  HumanEditLeaseSession,
  type HumanEditLeaseTransport,
} from "../../src/editors/human-edit-lease-session";

const sha = "a".repeat(64);
const target = {
  kind: "workspace_artifact" as const,
  artifactInternalId: "11111111-1111-4111-8111-111111111111",
  logicalPath: "notes/today.md",
};

function record(generation: number, state: "clean" | "dirty" = "clean"): HumanEditLeaseRecord {
  return {
    lease: {
      leaseId: "lease-1",
      sessionId: "session-1",
      humanId: "human-1",
      identity: {
        kind: "workspace_artifact",
        artifactId: "11111111-1111-4111-8111-111111111111",
        logicalPath: "notes/today.md",
      },
      baseVersion: {
        identity: {
          kind: "workspace_artifact",
          artifactId: "11111111-1111-4111-8111-111111111111",
          logicalPath: "notes/today.md",
        },
        backendVersion: { kind: "artifact_revision", revision: 1 },
        sha256: sha,
      },
      generation,
      state,
    },
    expiresAtMs: 1000,
  };
}

function ok(value: HumanEditLeaseRecord): HumanEditLeaseStoreResult {
  return { status: "ok", record: value };
}

function desired(state: "clean" | "dirty") {
  return { target, state } as const;
}

describe("HumanEditLeaseSession", () => {
  test("coalesces a newer desired state into one CAS update after register", async () => {
    const calls: string[] = [];
    let resolveRegister: ((result: HumanEditLeaseStoreResult) => void) | null = null;
    const transport: HumanEditLeaseTransport = {
      registerHumanEditLease: async () => {
        calls.push("register");
        return new Promise((resolve) => { resolveRegister = resolve; });
      },
      updateHumanEditLease: async (_id, input) => {
        calls.push(`update:${input.expectedGeneration}:${input.state}`);
        return ok(record(1, "dirty"));
      },
      renewHumanEditLease: async () => ok(record(2)),
      releaseHumanEditLease: async () => ({ status: "not_found" }),
    };
    const session = new HumanEditLeaseSession({ transport, sessionId: "session-1" });
    session.setDesired(desired("clean"));
    session.setDesired(desired("dirty"));
    await Promise.resolve();
    if (resolveRegister === null) throw new Error("register was not started");
    resolveRegister(ok(record(0)));
    await session.whenIdle();

    expect(calls).toEqual(["register", "update:0:dirty"]);
    expect(session.getRecord()?.lease.state).toBe("dirty");
  });

  test("not_found is re-registered, while stale generation is adopted then CAS-updated", async () => {
    const calls: string[] = [];
    let updateCount = 0;
    const transport: HumanEditLeaseTransport = {
      registerHumanEditLease: async () => {
        calls.push("register");
        return ok(record(calls.length === 1 ? 0 : 4));
      },
      updateHumanEditLease: async () => {
        updateCount += 1;
        calls.push(`update:${updateCount}`);
        if (updateCount === 1) return { status: "not_found" };
        if (updateCount === 2) return { status: "stale_generation", record: record(3, "clean") };
        return ok(record(5, "dirty"));
      },
      renewHumanEditLease: async () => ok(record(6, "dirty")),
      releaseHumanEditLease: async () => ({ status: "not_found" }),
    };
    const session = new HumanEditLeaseSession({ transport, sessionId: "session-1" });
    session.setDesired(desired("clean"));
    await session.whenIdle();
    session.setDesired(desired("dirty"));
    await session.whenIdle();

    expect(calls).toEqual(["register", "update:1", "register", "update:2", "update:3"]);
    expect(session.getRecord()?.lease.generation).toBe(5);
    expect(session.getRecord()?.lease.state).toBe("dirty");
  });

  test("heartbeat renews an already-matching held record", async () => {
    let renews = 0;
    const transport: HumanEditLeaseTransport = {
      registerHumanEditLease: async () => ok(record(0)),
      updateHumanEditLease: async () => ok(record(1)),
      renewHumanEditLease: async (_id, input) => {
        renews += 1;
        expect(input).toEqual({ sessionId: "session-1", target, expectedGeneration: 0 });
        return ok(record(1));
      },
      releaseHumanEditLease: async () => ({ status: "not_found" }),
    };
    const session = new HumanEditLeaseSession({ transport, sessionId: "session-1" });
    session.setDesired(desired("clean"));
    await session.whenIdle();
    session.heartbeat();
    await session.whenIdle();

    expect(renews).toBe(1);
    expect(session.getRecord()?.lease.generation).toBe(1);
  });

  test("preserves local-file routing scope across register and release", async () => {
    const localTarget = {
      kind: "local_file" as const,
      relayId: "relay-1",
      candidatePath: "/allowed/report.md",
    };
    const localRecord: HumanEditLeaseRecord = {
      lease: {
        leaseId: "local-lease-1",
        sessionId: "session-1",
        humanId: "human-1",
        identity: { kind: "local_file", relayId: "relay-1", canonicalPath: "/allowed/report.md" },
        baseVersion: {
          identity: { kind: "local_file", relayId: "relay-1", canonicalPath: "/allowed/report.md" },
          backendVersion: { kind: "local_sha", sha256: sha },
          sha256: sha,
        },
        generation: 0,
        state: "clean",
      },
      expiresAtMs: 1_000,
    };
    const scopes: Array<"workspace_artifact" | "local_file" | undefined> = [];
    const transport: HumanEditLeaseTransport = {
      registerHumanEditLease: async (_input, opts) => {
        scopes.push(opts?.targetKind);
        return ok(localRecord);
      },
      updateHumanEditLease: async () => ok(localRecord),
      renewHumanEditLease: async () => ok(localRecord),
      releaseHumanEditLease: async (_id, _input, opts) => {
        scopes.push(opts?.targetKind);
        return { status: "not_found" };
      },
    };
    const session = new HumanEditLeaseSession({ transport, sessionId: "session-1" });
    session.setDesired({ target: localTarget, state: "clean" });
    await session.whenIdle();
    session.release();
    await session.whenIdle();
    expect(scopes).toEqual(["local_file", "local_file"]);
  });

  test("a failed CAS update waits for an explicit wake instead of tight-looping", async () => {
    let updates = 0;
    const transport: HumanEditLeaseTransport = {
      registerHumanEditLease: async () => ok(record(0)),
      updateHumanEditLease: async () => {
        updates += 1;
        throw new TypeError("network unavailable");
      },
      renewHumanEditLease: async () => ok(record(1)),
      releaseHumanEditLease: async () => ({ status: "not_found" }),
    };
    const session = new HumanEditLeaseSession({ transport, sessionId: "session-1" });
    session.setDesired(desired("clean"));
    await session.whenIdle();
    session.setDesired(desired("dirty"));
    await session.whenIdle();
    expect(updates).toBe(1);

    session.wake();
    await session.whenIdle();
    expect(updates).toBe(2);
  });

  test("release retries once with stale registry truth", async () => {
    const releasedGenerations: number[] = [];
    const releaseScopes: Array<"workspace_artifact" | "local_file" | undefined> = [];
    const transport: HumanEditLeaseTransport = {
      registerHumanEditLease: async () => ok(record(0)),
      updateHumanEditLease: async () => ok(record(1)),
      renewHumanEditLease: async () => ok(record(1)),
      releaseHumanEditLease: async (_leaseId, input, opts) => {
        releasedGenerations.push(input.expectedGeneration);
        releaseScopes.push(opts?.targetKind);
        return releasedGenerations.length === 1
          ? { status: "stale_generation", record: record(3) }
          : { status: "ok", record: record(4) };
      },
    };
    const session = new HumanEditLeaseSession({ transport, sessionId: "session-1" });
    session.setDesired(desired("clean"));
    await session.whenIdle();
    session.release();
    await session.whenIdle();

    expect(releasedGenerations).toEqual([0, 3]);
    expect(releaseScopes).toEqual(["workspace_artifact", "workspace_artifact"]);
    expect(session.getRecord()).toBeNull();
  });
});
