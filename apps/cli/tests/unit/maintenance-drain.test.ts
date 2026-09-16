import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComposeDriverProfile, MaintenanceDrainHandle } from "@nautilo/compose-driver";
import {
  MaintenanceApiError,
  parseMaintenanceStatus,
  maintenanceWorkIsIdle,
} from "../../src/lib/api-client.ts";
import {
  buildMaintenanceDrain,
  DEFAULT_MAINTENANCE_HARD_LEASE_MS,
  MAINTENANCE_POST_DEADLINE_BUFFER_MS,
  maintenanceHardLeaseMs,
} from "../../src/lib/compose-driver-factory.ts";

const localProfile: ComposeDriverProfile = {
  name: "local-drain",
  transport: "local",
  lifecycle: "compose",
  tag: "stable",
};

const remoteProfile: ComposeDriverProfile = {
  name: "remote-drain",
  transport: "remote",
  lifecycle: "compose",
  tag: "stable",
  ssh: { host: "1.2.3.4", user: "root" },
};

function statusBody(over: Partial<{
  state: string;
  operationId: string | null;
  leaseExpiresAt: string | null;
  hardExpiresAt: string | null;
  runningForegroundJobs: number;
  runningBackgroundJobs: number;
  queuedTurns: number;
  bufferedLanes: number;
  acceptedWork: number;
  runningTaskRuns: number;
  claimedTasks: number;
}> = {}) {
  return {
    state: over.state ?? "draining",
    operationId: over.operationId ?? "op-1",
    leaseExpiresAt: over.leaseExpiresAt ?? "2099-01-01T00:00:00.000Z",
    hardExpiresAt: over.hardExpiresAt ?? "2099-01-01T01:00:00.000Z",
    work: {
      runningForegroundJobs: over.runningForegroundJobs ?? 0,
      runningBackgroundJobs: over.runningBackgroundJobs ?? 0,
      queuedTurns: over.queuedTurns ?? 0,
      bufferedLanes: over.bufferedLanes ?? 0,
      acceptedWork: over.acceptedWork ?? 0,
      runningTaskRuns: over.runningTaskRuns ?? 0,
      claimedTasks: over.claimedTasks ?? 0,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseMaintenanceStatus + maintenanceWorkIsIdle", () => {
  test("parses a well-formed payload-free status", () => {
    const s = parseMaintenanceStatus(statusBody({ runningForegroundJobs: 1 }), "ctx");
    expect(s.state).toBe("draining");
    expect(s.operationId).toBe("op-1");
    expect(s.work).toEqual({
      runningForegroundJobs: 1,
      runningBackgroundJobs: 0,
      queuedTurns: 0,
      bufferedLanes: 0,
      acceptedWork: 0,
      runningTaskRuns: 0,
      claimedTasks: 0,
    });
  });

  test("throws a malformed error on a missing work object", () => {
    expect(() =>
      parseMaintenanceStatus({ state: "draining", operationId: "op", leaseExpiresAt: null, hardExpiresAt: null }, "ctx"),
    ).toThrow(/missing or invalid work counts/);
  });

  test("throws a malformed error on an invalid state", () => {
    expect(() => parseMaintenanceStatus({ ...statusBody(), state: "weird" }, "ctx")).toThrow(/invalid state/);
  });

  test("idle is true only when every executable-work category is zero", () => {
    expect(maintenanceWorkIsIdle(parseMaintenanceStatus(statusBody(), "ctx"))).toBe(true);
    for (const nonzero of [
      { runningForegroundJobs: 1 },
      { runningBackgroundJobs: 1 },
      { queuedTurns: 1 },
      { bufferedLanes: 1 },
      { acceptedWork: 1 },
      { runningTaskRuns: 1 },
      { claimedTasks: 1 },
    ]) {
      expect(maintenanceWorkIsIdle(parseMaintenanceStatus(statusBody(nonzero), "ctx"))).toBe(false);
    }
  });
});

describe("buildMaintenanceDrain transport + auth fail-closed", () => {
  test("local Compose uses the selected instance endpoint and bootstrap bearer", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-maintenance-drain-"));
    try {
      const profile: ComposeDriverProfile = {
        ...localProfile,
        name: "profile-scoped",
        instance_id: "profile-scoped",
      };
      const instanceRoot = join(home, ".nautilo-profile-scoped");
      mkdirSync(instanceRoot, { recursive: true });
      writeFileSync(
        join(instanceRoot, "instance.json"),
        JSON.stringify({ server: { url: "http://127.0.0.1:5501" } }),
      );

      let requestedUrl = "";
      let authorization = "";
      const fetchFn = (async (url: string, init?: RequestInit) => {
        requestedUrl = url;
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return jsonResponse(statusBody());
      }) as unknown as typeof fetch;
      const drain = buildMaintenanceDrain({
        home,
        fetchFn,
        readBootstrapTokenFn: () => "local-compose-token",
      });

      await drain(profile, 1_000);

      expect(requestedUrl).toBe("http://127.0.0.1:5501/api/operator/maintenance/enter");
      expect(authorization).toBe("Bearer local-compose-token");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("D427 3.1.1: remote drain no longer requires a bootstrap token (SSH-local authority)", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      return jsonResponse(statusBody());
    }) as unknown as typeof fetch;
    const drain = buildMaintenanceDrain({
      // SSH-local transport: loopback base URL, no bearer. The factory wires
      // buildSshLocalFetch here; a missing bootstrap token is NOT a failure.
      resolveServerUrl: () => "http://127.0.0.1:4001",
      readBootstrapTokenFn: () => null,
      fetchFn,
    });
    const handle = await drain(remoteProfile, 1_000);
    expect(calls).toEqual(["/api/operator/maintenance/enter"]);
    expect(handle.operationId).toBe("op-1");
  });

  test("fails closed on a 403 from enter without calling cancel", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/enter")) return new Response("forbidden", { status: 403 });
      return jsonResponse(statusBody());
    }) as unknown as typeof fetch;
    const drain = buildMaintenanceDrain({
      resolveServerUrl: () => "https://nautilo.example/",
      readBootstrapTokenFn: () => "tok",
      fetchFn,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(drain(remoteProfile, 1_000)).rejects.toThrow(/enter refused.*403/);
    expect(calls).toEqual(["/api/operator/maintenance/enter"]);
  });
});

describe("buildMaintenanceDrain hard-lease ceiling", () => {
  test("uses the safe 30-minute minimum for the default five-minute drain", async () => {
    let enterBody: unknown;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      enterBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return jsonResponse(statusBody());
    }) as unknown as typeof fetch;
    const drain = buildMaintenanceDrain({
      resolveServerUrl: () => "http://127.0.0.1:3201",
      fetchFn,
      log: () => undefined,
    });

    await drain(localProfile, 5 * 60_000);

    expect(maintenanceHardLeaseMs(5 * 60_000)).toBe(DEFAULT_MAINTENANCE_HARD_LEASE_MS);
    expect(enterBody).toEqual({ hardMs: DEFAULT_MAINTENANCE_HARD_LEASE_MS });
  });

  test("extends the hard lease past a wait duration exceeding 30 minutes", async () => {
    let enterBody: unknown;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      enterBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return jsonResponse(statusBody());
    }) as unknown as typeof fetch;
    const drain = buildMaintenanceDrain({
      resolveServerUrl: () => "http://127.0.0.1:3201",
      fetchFn,
      log: () => undefined,
    });
    const waitForMs = 45 * 60_000;

    await drain(localProfile, waitForMs);

    const expectedHardMs = waitForMs + MAINTENANCE_POST_DEADLINE_BUFFER_MS;
    expect(maintenanceHardLeaseMs(waitForMs)).toBe(expectedHardMs);
    expect(enterBody).toEqual({ hardMs: expectedHardMs });
  });
});

describe("buildMaintenanceDrain polling", () => {
  test("proceeds immediately on zero without sleeping and retains the lease (no complete)", async () => {
    const calls: string[] = [];
    let slept = 0;
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      return jsonResponse(statusBody({ runningForegroundJobs: 0, acceptedWork: 0 }));
    }) as unknown as typeof fetch;
    const drain = buildMaintenanceDrain({
      resolveServerUrl: () => "http://127.0.0.1:3201",
      fetchFn,
      sleepFn: async () => {
        slept += 1;
      },
      log: () => undefined,
    });
    const handle = await drain(localProfile, 5_000);
    expect(slept).toBe(0);
    // The lease is retained for the applying transition; complete is NOT
    // called as part of successful drain completion (Wave 3.1.3 fences it).
    expect(calls).toEqual(["/api/operator/maintenance/enter"]);
    expect(handle.operationId).toBe("op-1");
    expect(typeof handle.transitionApplying).toBe("function");
    expect(typeof handle.releaseLease).toBe("function");
  });

  test("polls until zero then returns a handle (no complete)", async () => {
    let statusCount = 0;
    let slept = 0;
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/enter")) {
        return jsonResponse(statusBody({ runningForegroundJobs: 2 }));
      }
      if (path.endsWith("/status")) {
        statusCount += 1;
        const done = statusCount >= 2;
        return jsonResponse(statusBody({ runningForegroundJobs: done ? 0 : 1 }));
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const drain = buildMaintenanceDrain({
      resolveServerUrl: () => "http://127.0.0.1:3201",
      fetchFn,
      sleepFn: async () => {
        slept += 1;
      },
      pollIntervalMs: 1,
      log: () => undefined,
    });
    const handle = await drain(localProfile, 5_000);
    expect(slept).toBe(2);
    expect(statusCount).toBe(2);
    expect(calls).not.toContain("/api/operator/maintenance/complete");
    expect(handle.operationId).toBe("op-1");
  });

  test("does not advance for any nonzero executable-work category, then advances at zero", async () => {
    const categories: Array<Parameters<typeof statusBody>[0]> = [
      { runningForegroundJobs: 1 },
      { runningBackgroundJobs: 1 },
      { queuedTurns: 1 },
      { bufferedLanes: 1 },
      { acceptedWork: 1 },
      { runningTaskRuns: 1 },
      { claimedTasks: 1 },
    ];

    for (const active of categories) {
      const calls: string[] = [];
      let statusReads = 0;
      const fetchFn = (async (url: string) => {
        const path = new URL(url).pathname;
        calls.push(path);
        if (path.endsWith("/enter")) return jsonResponse(statusBody(active));
        if (path.endsWith("/status")) {
          statusReads += 1;
          return jsonResponse(statusBody());
        }
        throw new Error(`unexpected ${path}`);
      }) as unknown as typeof fetch;
      const drain = buildMaintenanceDrain({
        resolveServerUrl: () => "http://127.0.0.1:3201",
        fetchFn,
        sleepFn: async () => {},
        pollIntervalMs: 1,
        log: () => undefined,
      });

      const handle = await drain(localProfile, 5_000);
      expect(statusReads).toBe(1);
      expect(handle.operationId).toBe("op-1");
      expect(calls).toEqual([
        "/api/operator/maintenance/enter",
        "/api/operator/maintenance/status",
      ]);
      expect(calls).not.toContain("/api/operator/maintenance/complete");
    }
  });

  test("at deadline, cancels executable work, reconciles to zero, and returns a handle (no complete)", async () => {
    const calls: string[] = [];
    let slept = 0;
    let now = 1_000;
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/enter")) return jsonResponse(statusBody({ runningForegroundJobs: 1 }));
      if (path.endsWith("/cancel-work")) return jsonResponse(statusBody());
      if (path.endsWith("/cancel"))
        return jsonResponse(statusBody({ state: "normal", operationId: null }));
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const drain = buildMaintenanceDrain({
      resolveServerUrl: () => "http://127.0.0.1:3201",
      fetchFn,
      sleepFn: async () => {
        slept += 1;
      },
      now: () => now,
      pollIntervalMs: 1,
      log: () => undefined,
    });
    // Advance the clock past the deadline before the first poll.
    const promise = drain(localProfile, 1_000);
    now = 100_000;
    const handle = await promise;
    // cancel-work terminalizes the work; the lease is retained (no complete).
    expect(calls).toEqual([
      "/api/operator/maintenance/enter",
      "/api/operator/maintenance/cancel-work",
    ]);
    expect(slept).toBe(0);
    expect(handle.operationId).toBe("op-1");
  });

  test("at deadline, a failed cancel-work request fails closed and clears the lease", async () => {
    let cancelled = false;
    let now = 1_000;
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/enter")) return jsonResponse(statusBody({ runningForegroundJobs: 1 }));
      if (path.endsWith("/cancel-work")) return new Response("forbidden", { status: 403 });
      if (path.endsWith("/cancel")) {
        cancelled = true;
        return jsonResponse(statusBody({ state: "normal", operationId: null }));
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const drain = buildMaintenanceDrain({
      resolveServerUrl: () => "http://127.0.0.1:3201",
      fetchFn,
      sleepFn: async () => {},
      now: () => now,
      pollIntervalMs: 1,
      log: () => undefined,
    });
    const promise = drain(localProfile, 1_000);
    now = 100_000;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(promise).rejects.toThrow(/cancel-work request failed.*403/);
    expect(cancelled).toBe(true);
  });

  test("at deadline, cancellation that does not reconcile to zero fails closed", async () => {
    let cancelled = false;
    let now = 1_000;
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/enter")) return jsonResponse(statusBody({ runningForegroundJobs: 1 }));
      if (path.endsWith("/cancel-work"))
        return jsonResponse(statusBody({ runningForegroundJobs: 1 }));
      if (path.endsWith("/status")) return jsonResponse(statusBody({ runningForegroundJobs: 1 }));
      if (path.endsWith("/cancel")) {
        cancelled = true;
        return jsonResponse(statusBody({ state: "normal", operationId: null }));
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const drain = buildMaintenanceDrain({
      resolveServerUrl: () => "http://127.0.0.1:3201",
      fetchFn,
      sleepFn: async () => {},
      now: () => now,
      pollIntervalMs: 1,
      reconcileBudgetMs: 10,
      log: () => undefined,
    });
    const promise = drain(localProfile, 1_000);
    now = 100_000;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(promise).rejects.toThrow(/did not reconcile to zero/);
    expect(cancelled).toBe(true);
  });

  test("network error during poll: cancels best-effort and throws fail-closed", async () => {
    let cancelled = false;
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/enter")) return jsonResponse(statusBody({ runningForegroundJobs: 1 }));
      if (path.endsWith("/status")) throw new TypeError("connection reset");
      if (path.endsWith("/cancel")) {
        cancelled = true;
        return jsonResponse(statusBody({ state: "normal", operationId: null }));
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const drain = buildMaintenanceDrain({
      resolveServerUrl: () => "http://127.0.0.1:3201",
      fetchFn,
      sleepFn: async () => {},
      pollIntervalMs: 1,
      log: () => undefined,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(drain(localProfile, 5_000)).rejects.toThrow(/failed closed.*connection reset.*lease cleared/);
    expect(cancelled).toBe(true);
  });

  test("malformed status body: cancels best-effort and throws fail-closed", async () => {
    let cancelled = false;
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/enter")) return jsonResponse(statusBody({ runningForegroundJobs: 1 }));
      if (path.endsWith("/status")) return jsonResponse({ state: "draining" });
      if (path.endsWith("/cancel")) {
        cancelled = true;
        return jsonResponse(statusBody({ state: "normal", operationId: null }));
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const drain = buildMaintenanceDrain({
      resolveServerUrl: () => "http://127.0.0.1:3201",
      fetchFn,
      sleepFn: async () => {},
      pollIntervalMs: 1,
      log: () => undefined,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(drain(localProfile, 5_000)).rejects.toThrow(/failed closed.*lease cleared/);
    expect(cancelled).toBe(true);
  });

  test("renews the lease when the soft window drops below the buffer", async () => {
    const calls: string[] = [];
    let statusCount = 0;
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/enter")) {
        // Lease expires almost immediately (within the 60s buffer).
        return jsonResponse(
          statusBody({ runningForegroundJobs: 1, leaseExpiresAt: "2026-07-14T12:00:30.000Z" }),
        );
      }
      if (path.endsWith("/renew")) {
        return jsonResponse(
          statusBody({ runningForegroundJobs: 1, leaseExpiresAt: "2026-07-14T13:00:00.000Z" }),
        );
      }
      if (path.endsWith("/status")) {
        statusCount += 1;
        return jsonResponse(statusBody({ runningForegroundJobs: statusCount >= 2 ? 0 : 1 }));
      }
      if (path.endsWith("/complete")) return jsonResponse(statusBody({ state: "normal", operationId: null }));
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const drain = buildMaintenanceDrain({
      resolveServerUrl: () => "http://127.0.0.1:3201",
      fetchFn,
      sleepFn: async () => {},
      now: () => Date.parse("2026-07-14T12:00:00.000Z"),
      pollIntervalMs: 1,
      renewBufferMs: 60_000,
      log: () => undefined,
    });
    await drain(localProfile, 60_000);
    expect(calls).toContain("/api/operator/maintenance/renew");
  });
});

describe("MaintenanceDrainHandle (Wave 2 task 2.2.5)", () => {
  function drainToHandle(
    fetchFn: typeof fetch,
    opts: { now?: () => number; waitForMs?: number } = {},
  ): Promise<MaintenanceDrainHandle> {
    const drain = buildMaintenanceDrain({
      resolveServerUrl: () => "http://127.0.0.1:3201",
      fetchFn,
      sleepFn: async () => {},
      pollIntervalMs: 1,
      log: () => undefined,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    return drain(localProfile, opts.waitForMs ?? 5_000);
  }

  test("transitionApplying posts /applying and succeeds when the server reports applying", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/enter"))
        return jsonResponse(statusBody({ runningForegroundJobs: 0 }));
      if (path.endsWith("/applying"))
        return jsonResponse(statusBody({ state: "applying", operationId: "op-1" }));
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const handle = await drainToHandle(fetchFn);
    await handle.transitionApplying();
    expect(calls).toEqual([
      "/api/operator/maintenance/enter",
      "/api/operator/maintenance/applying",
    ]);
  });

  test("transitionApplying fails closed on a 403 (auth) and never reaches a second call", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/enter"))
        return jsonResponse(statusBody({ runningForegroundJobs: 0 }));
      if (path.endsWith("/applying")) return new Response("forbidden", { status: 403 });
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const handle = await drainToHandle(fetchFn);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(handle.transitionApplying()).rejects.toThrow(/maintenance applying.*403/);
    expect(calls).toEqual([
      "/api/operator/maintenance/enter",
      "/api/operator/maintenance/applying",
    ]);
  });

  test("transitionApplying fails closed on a 409 transition refusal", async () => {
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/enter"))
        return jsonResponse(statusBody({ runningForegroundJobs: 0 }));
      if (path.endsWith("/applying"))
        return jsonResponse({ code: "not_owner" }, 409);
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const handle = await drainToHandle(fetchFn);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(handle.transitionApplying()).rejects.toThrow(/maintenance transition refused.*not_owner/);
  });

  test("transitionApplying fails closed on a network error", async () => {
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/enter"))
        return jsonResponse(statusBody({ runningForegroundJobs: 0 }));
      if (path.endsWith("/applying")) throw new TypeError("connection reset");
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const handle = await drainToHandle(fetchFn);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(handle.transitionApplying()).rejects.toThrow(/operator endpoint unavailable.*connection reset/);
  });

  test("transitionApplying fails closed when a 200 returns a non-applying state (malformed)", async () => {
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/enter"))
        return jsonResponse(statusBody({ runningForegroundJobs: 0 }));
      // Server returned 200 but did not move THIS operation to applying.
      if (path.endsWith("/applying"))
        return jsonResponse(statusBody({ state: "draining", operationId: "op-1" }));
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const handle = await drainToHandle(fetchFn);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(handle.transitionApplying()).rejects.toThrow(/failed closed: server reported state=draining/);
  });

  test("releaseLease posts /cancel and reports cancelled:true on success", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/enter"))
        return jsonResponse(statusBody({ runningForegroundJobs: 0 }));
      if (path.endsWith("/cancel"))
        return jsonResponse(statusBody({ state: "normal", operationId: null }));
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const handle = await drainToHandle(fetchFn);
    const outcome = await handle.releaseLease();
    expect(outcome).toEqual({ cancelled: true });
    expect(calls).toEqual([
      "/api/operator/maintenance/enter",
      "/api/operator/maintenance/cancel",
    ]);
  });

  test("releaseLease is best-effort: reports cancelled:false on error and never throws", async () => {
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/enter"))
        return jsonResponse(statusBody({ runningForegroundJobs: 0 }));
      if (path.endsWith("/cancel")) return new Response("forbidden", { status: 403 });
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const handle = await drainToHandle(fetchFn);
    const outcome = await handle.releaseLease();
    expect(outcome.cancelled).toBe(false);
    expect(outcome.error).toMatch(/403/);
  });
});

describe("MaintenanceDrainHandle.completeLease (Wave 3 task 3.1.3)", () => {
  function drainToHandle(
    fetchFn: typeof fetch,
  ): Promise<MaintenanceDrainHandle> {
    const drain = buildMaintenanceDrain({
      resolveServerUrl: () => "http://127.0.0.1:3201",
      fetchFn,
      sleepFn: async () => {},
      pollIntervalMs: 1,
      log: () => undefined,
    });
    return drain(localProfile, 5_000);
  }

  test("completeLease posts /complete and resolves completed when the server reports normal", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/enter"))
        return jsonResponse(statusBody({ runningForegroundJobs: 0 }));
      if (path.endsWith("/complete"))
        // statusBody() defaults operationId to "op-1" via `??`; override after
        // the spread so the cleared lease reports state=normal, operationId=null.
        return jsonResponse({ ...statusBody(), state: "normal", operationId: null });
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const handle = await drainToHandle(fetchFn);
    const outcome = await handle.completeLease();
    expect(outcome).toEqual({ completed: true });
    expect(calls).toEqual([
      "/api/operator/maintenance/enter",
      "/api/operator/maintenance/complete",
    ]);
  });

  test("completeLease fails closed on a 403 (auth) and never reports completed", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/enter"))
        return jsonResponse(statusBody({ runningForegroundJobs: 0 }));
      if (path.endsWith("/complete")) return new Response("forbidden", { status: 403 });
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const handle = await drainToHandle(fetchFn);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(handle.completeLease()).rejects.toThrow(/maintenance complete.*403/);
    expect(calls).toEqual([
      "/api/operator/maintenance/enter",
      "/api/operator/maintenance/complete",
    ]);
  });

  test("completeLease fails closed on a 409 transition refusal (not_owner)", async () => {
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/enter"))
        return jsonResponse(statusBody({ runningForegroundJobs: 0 }));
      if (path.endsWith("/complete"))
        return jsonResponse({ code: "not_owner" }, 409);
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const handle = await drainToHandle(fetchFn);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(handle.completeLease()).rejects.toThrow(/maintenance transition refused.*not_owner/);
  });

  test("completeLease fails closed on a network error", async () => {
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/enter"))
        return jsonResponse(statusBody({ runningForegroundJobs: 0 }));
      if (path.endsWith("/complete")) throw new TypeError("connection reset");
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const handle = await drainToHandle(fetchFn);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(handle.completeLease()).rejects.toThrow(/operator endpoint unavailable.*connection reset/);
  });

  test("completeLease fails closed when a 200 returns a non-normal state (still applying)", async () => {
    const fetchFn = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/enter"))
        return jsonResponse(statusBody({ runningForegroundJobs: 0 }));
      // Server returned 200 but did not clear THIS operation.
      if (path.endsWith("/complete"))
        return jsonResponse(statusBody({ state: "applying", operationId: "op-1" }));
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const handle = await drainToHandle(fetchFn);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(handle.completeLease()).rejects.toThrow(/completion failed closed: server reported state=applying/);
  });
});

describe("MaintenanceApiError classification", () => {
  test("carries kind + status + transitionCode", () => {
    const err = new MaintenanceApiError("transition", "nope", {
      status: 409,
      transitionCode: "not_owner",
    });
    expect(err.kind).toBe("transition");
    expect(err.status).toBe(409);
    expect(err.transitionCode).toBe("not_owner");
    expect(err.message).toBe("nope");
  });
});
