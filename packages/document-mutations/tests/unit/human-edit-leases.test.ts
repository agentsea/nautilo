import { describe, expect, test } from "bun:test";
import type {
  AnchoredTextPatch,
  DocumentIdentity,
  DocumentVersion,
} from "@nautilo/types";
import {
  HumanEditLeaseRegistry,
  type RegisterHumanEditLeaseInput,
} from "../../src/human-edit-leases";

const workspaceIdentity = {
  kind: "workspace_artifact",
  artifactId: "7d3bef58-16f0-4c6f-8ee7-137b28d8bfd6",
  logicalPath: "notes/a.md",
} as const;
const sameArtifactDifferentPath = {
  ...workspaceIdentity,
  logicalPath: "notes/b.md",
} as const;
const differentArtifactSamePath = {
  ...workspaceIdentity,
  artifactId: "bb4d92f7-6686-4e72-9cea-3b344206dd44",
} as const;
const localIdentity = {
  kind: "local_file",
  relayId: "relay-1",
  canonicalPath: "/Users/test/notes/a.md",
} as const;
const draftPatch: AnchoredTextPatch = {
  kind: "anchored_text",
  oldString: "old",
  newString: "new",
};

function version(
  identity: DocumentIdentity = workspaceIdentity,
  revision = 1,
): DocumentVersion {
  return identity.kind === "workspace_artifact"
    ? {
        identity,
        backendVersion: { kind: "artifact_revision", revision },
        sha256: "a".repeat(64),
      }
    : {
        identity,
        backendVersion: { kind: "local_sha", sha256: "a".repeat(64) },
        sha256: "a".repeat(64),
      };
}

function registration(
  overrides: Omit<Partial<RegisterHumanEditLeaseInput>, "draftPatch"> & {
    draftPatch?: AnchoredTextPatch | undefined;
  } = {},
): RegisterHumanEditLeaseInput {
  const { draftPatch: overriddenDraftPatch, ...rest } = overrides;
  const hasDraftOverride = Object.prototype.hasOwnProperty.call(
    overrides,
    "draftPatch",
  );
  return {
    sessionId: "session-1",
    humanId: "human-1",
    identity: workspaceIdentity,
    baseVersion: version(),
    state: "dirty",
    ...rest,
    ...(!hasDraftOverride
      ? { draftPatch }
      : overriddenDraftPatch === undefined
        ? {}
        : { draftPatch: overriddenDraftPatch }),
  };
}

function registryHarness(ttlMs = 100) {
  let now = 1_000;
  let sequence = 0;
  const registry = new HumanEditLeaseRegistry({
    ttlMs,
    now: () => now,
    newLeaseId: () => `lease-${++sequence}`,
  });
  return {
    registry,
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

function registeredLease(
  registry: HumanEditLeaseRegistry,
  input: RegisterHumanEditLeaseInput = registration(),
) {
  const result = registry.register(input);
  if (result.status !== "ok") throw new Error(`registration failed: ${result.status}`);
  return result.record;
}

describe("D448 human edit lease registry", () => {
  test("registers generation zero and preserves an optional dirty draft patch", () => {
    const { registry, now } = registryHarness();
    const record = registeredLease(registry);

    expect(record).toEqual({
      lease: {
        leaseId: "lease-1",
        sessionId: "session-1",
        humanId: "human-1",
        identity: workspaceIdentity,
        baseVersion: version(),
        generation: 0,
        state: "dirty",
        draftPatch,
      },
      expiresAtMs: now() + 100,
    });
  });

  test("makes lost-response registration retries idempotent without overwriting truth", () => {
    const { registry, advance } = registryHarness();
    const original = registeredLease(registry);
    advance(25);
    const changedRetryVersion = {
      ...version(workspaceIdentity, 2),
      sha256: "b".repeat(64),
    } as DocumentVersion;

    const retry = registry.register(
      registration({
        baseVersion: changedRetryVersion,
        state: "conflict",
        draftPatch: {
          ...draftPatch,
          newString: "a different reconnect draft",
        },
      }),
    );

    expect(retry).toEqual({ status: "ok", record: original });
    expect(registry.getForIdentity(workspaceIdentity)).toEqual([original]);

    // The retry did not consume another id or create an orphan. A different
    // editor session remains an independent lease and receives lease-2.
    const otherSession = registeredLease(
      registry,
      registration({ sessionId: "session-2" }),
    );
    expect(otherSession.lease.leaseId).toBe("lease-2");

    expect(
      registry.release({
        leaseId: original.lease.leaseId,
        sessionId: original.lease.sessionId,
        humanId: original.lease.humanId,
        expectedGeneration: original.lease.generation,
      }).status,
    ).toBe("ok");
    expect(
      registry.getForIdentity(workspaceIdentity).map((record) => record.lease.leaseId),
    ).toEqual(["lease-2"]);
  });

  test("a retried sole registration releases without leaving an orphan", () => {
    const { registry } = registryHarness();
    const original = registeredLease(registry);
    expect(registry.register(registration())).toEqual({
      status: "ok",
      record: original,
    });

    expect(
      registry.release({
        leaseId: original.lease.leaseId,
        sessionId: original.lease.sessionId,
        humanId: original.lease.humanId,
        expectedGeneration: 0,
      }).status,
    ).toBe("ok");
    expect(registry.getForIdentity(workspaceIdentity)).toEqual([]);
    expect(
      registry.register(registration()).status,
    ).toBe("ok");
    expect(
      registry.getForIdentity(workspaceIdentity).map((record) => record.lease.leaseId),
    ).toEqual(["lease-2"]);
  });

  test("rejects a clean lease carrying a draft and accepts clean without one", () => {
    const { registry } = registryHarness();
    expect(
      registry.register(registration({ state: "clean", draftPatch })),
    ).toEqual({
      status: "invalid",
      reason: "a clean lease cannot carry a draft patch",
    });

    const clean = registry.register(
      registration({ state: "clean", draftPatch: undefined }),
    );
    expect(clean.status).toBe("ok");
    if (clean.status === "ok") {
      expect(clean.record.lease.draftPatch).toBeUndefined();
    }
  });

  test("updates through server-owned generation CAS and may advance the base version", () => {
    const { registry } = registryHarness();
    const initial = registeredLease(registry);
    const nextVersion = {
      ...version(workspaceIdentity, 2),
      sha256: "b".repeat(64),
    } as DocumentVersion;

    const updated = registry.update({
      leaseId: initial.lease.leaseId,
      sessionId: "session-1",
      humanId: "human-1",
      expectedGeneration: 0,
      baseVersion: nextVersion,
      state: "saving",
      draftPatch,
    });

    expect(updated.status).toBe("ok");
    if (updated.status === "ok") {
      expect(updated.record.lease.generation).toBe(1);
      expect(updated.record.lease.baseVersion).toEqual(nextVersion);
    }
  });

  test("rejects stale updates without changing state or extending expiry", () => {
    const { registry, advance } = registryHarness();
    const initial = registeredLease(registry);
    advance(20);

    const stale = registry.update({
      leaseId: initial.lease.leaseId,
      sessionId: "session-1",
      humanId: "human-1",
      expectedGeneration: 7,
      baseVersion: version(),
      state: "conflict",
      draftPatch,
    });

    expect(stale).toEqual({
      status: "stale_generation",
      record: initial,
    });
    expect(registry.getForIdentity(workspaceIdentity)).toEqual([initial]);
  });

  test("owner and session mismatches cannot update, renew, or release", () => {
    const { registry, advance } = registryHarness();
    const initial = registeredLease(registry);
    const foreignBindings = [
      { humanId: "human-2", sessionId: "session-1" },
      { humanId: "human-1", sessionId: "session-2" },
    ] as const;

    for (const binding of foreignBindings) {
      expect(
        registry.update({
          leaseId: initial.lease.leaseId,
          ...binding,
          expectedGeneration: 0,
          baseVersion: version(),
          state: "conflict",
          draftPatch,
        }),
      ).toEqual({ status: "not_found" });
      expect(
        registry.renew({
          leaseId: initial.lease.leaseId,
          ...binding,
          expectedGeneration: 0,
        }),
      ).toEqual({ status: "not_found" });
      expect(
        registry.release({
          leaseId: initial.lease.leaseId,
          ...binding,
          expectedGeneration: 0,
        }),
      ).toEqual({ status: "not_found" });
    }

    advance(20);
    expect(registry.getForIdentity(workspaceIdentity)).toEqual([initial]);
  });

  test("rejects an update that changes identity through base version", () => {
    const { registry } = registryHarness();
    const initial = registeredLease(registry);

    const result = registry.update({
      leaseId: initial.lease.leaseId,
      sessionId: "session-1",
      humanId: "human-1",
      expectedGeneration: 0,
      baseVersion: version(sameArtifactDifferentPath),
      state: "dirty",
      draftPatch,
    });

    expect(result).toEqual({
      status: "invalid",
      reason: "lease identity must equal base-version identity",
    });
    expect(registry.getForIdentity(workspaceIdentity)[0]?.lease.generation).toBe(0);
  });

  test("renew extends expiry without changing generation", () => {
    const { registry, advance, now } = registryHarness();
    const initial = registeredLease(registry);
    advance(80);

    const renewed = registry.renew({
      leaseId: initial.lease.leaseId,
      sessionId: "session-1",
      humanId: "human-1",
      expectedGeneration: 0,
    });

    expect(renewed.status).toBe("ok");
    if (renewed.status === "ok") {
      expect(renewed.record.lease.generation).toBe(0);
      expect(renewed.record.expiresAtMs).toBe(now() + 100);
    }
    advance(21);
    expect(registry.getForIdentity(workspaceIdentity)).toHaveLength(1);
  });

  test("expires lazily at the exact deadline and explicit sweep reports removals", () => {
    const { registry, advance } = registryHarness();
    registeredLease(registry);
    advance(100);
    expect(registry.getForIdentity(workspaceIdentity)).toEqual([]);

    registeredLease(registry);
    advance(100);
    expect(registry.sweepExpired()).toBe(1);
    expect(registry.sweepExpired()).toBe(0);
  });

  test("release is generation-guarded and removes only the bound lease", () => {
    const { registry } = registryHarness();
    const initial = registeredLease(registry);
    expect(
      registry.release({
        leaseId: initial.lease.leaseId,
        sessionId: "session-1",
        humanId: "human-1",
        expectedGeneration: 1,
      }).status,
    ).toBe("stale_generation");

    expect(
      registry.release({
        leaseId: initial.lease.leaseId,
        sessionId: "session-1",
        humanId: "human-1",
        expectedGeneration: 0,
      }).status,
    ).toBe("ok");
    expect(registry.getForIdentity(workspaceIdentity)).toEqual([]);
  });

  test("retains multiple independently bound sessions for one exact identity", () => {
    const { registry } = registryHarness();
    registeredLease(registry, registration());
    registeredLease(
      registry,
      registration({ sessionId: "session-2", humanId: "human-2" }),
    );

    expect(
      registry.getForIdentity(workspaceIdentity).map((record) => ({
        leaseId: record.lease.leaseId,
        sessionId: record.lease.sessionId,
      })),
    ).toEqual([
      { leaseId: "lease-1", sessionId: "session-1" },
      { leaseId: "lease-2", sessionId: "session-2" },
    ]);
  });

  test("isolates artifact, path, backend, relay, and local path exactly", () => {
    const { registry } = registryHarness();
    registeredLease(registry);
    registeredLease(
      registry,
      registration({
        identity: localIdentity,
        baseVersion: version(localIdentity),
        sessionId: "local-session",
      }),
    );

    expect(registry.getForIdentity(workspaceIdentity)).toHaveLength(1);
    expect(registry.getForIdentity(sameArtifactDifferentPath)).toEqual([]);
    expect(registry.getForIdentity(differentArtifactSamePath)).toEqual([]);
    expect(registry.getForIdentity(localIdentity)).toHaveLength(1);
    expect(registry.getForIdentity({ ...localIdentity, relayId: "relay-2" })).toEqual([]);
    expect(
      registry.getForIdentity({
        ...localIdentity,
        canonicalPath: "/Users/test/notes/b.md",
      }),
    ).toEqual([]);
  });

  test("does not impose a count or draft-size ceiling", () => {
    const { registry } = registryHarness();
    const largePatch = {
      ...draftPatch,
      newString: "x".repeat(2 * 1024 * 1024),
    };

    for (let index = 0; index < 128; index += 1) {
      expect(
        registry.register(
          registration({
            sessionId: `session-${index}`,
            draftPatch: index === 0 ? largePatch : draftPatch,
          }),
        ).status,
      ).toBe("ok");
    }
    expect(registry.getForIdentity(workspaceIdentity)).toHaveLength(128);
  });

  test("rejects invalid factories and clocks rather than fabricating records", () => {
    expect(
      () =>
        new HumanEditLeaseRegistry({
          ttlMs: 0,
          newLeaseId: () => "lease",
        }),
    ).toThrow("positive safe integer");

    const invalidId = new HumanEditLeaseRegistry({
      ttlMs: 10,
      now: () => 0,
      newLeaseId: () => "",
    });
    expect(invalidId.register(registration())).toEqual({
      status: "invalid",
      reason: "newLeaseId returned an empty identifier",
    });

    const invalidClock = new HumanEditLeaseRegistry({
      ttlMs: 10,
      now: () => -1,
      newLeaseId: () => "lease",
    });
    expect(() => invalidClock.register(registration())).toThrow(
      "non-negative epoch milliseconds",
    );
  });
});
