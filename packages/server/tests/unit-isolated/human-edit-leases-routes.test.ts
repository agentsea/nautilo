import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  deriveDocumentIdentityLockKeys,
  HumanEditLeaseRegistry,
  InMemoryDocumentLockManager,
} from "@nautilo/document-mutations";
import { humanEditLeaseRoutes } from "../../src/routes/human-edit-leases";

const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(64);
const apps: FastifyInstance[] = [];

function target(artifactId = ARTIFACT_ID, logicalPath = "docs/report.md") {
  const identity = { kind: "workspace_artifact" as const, artifactId, logicalPath };
  return {
    ok: true as const,
    target: {
      identity,
      baseVersion: {
        identity,
        backendVersion: { kind: "artifact_revision" as const, revision: 7 },
        sha256: SHA,
      },
      bytes: Buffer.from("alpha\nbeta\n", "utf8"),
    },
  };
}

function makeApp(
  registry = new HumanEditLeaseRegistry({ ttlMs: 60_000, newLeaseId: randomUUID }),
  options: {
    readonly workspaceLockManager?: InMemoryDocumentLockManager;
    readonly resolveWorkspaceTarget?: () => ReturnType<typeof target>;
  } = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", (request, _reply, done) => {
    Object.assign(request as object, {
      sessionUserId: request.headers["x-test-user"] === "none"
        ? null
        : typeof request.headers["x-test-user"] === "string"
          ? request.headers["x-test-user"]
          : "human-1",
      memoryEnvelope: null,
    });
    done();
  });
  humanEditLeaseRoutes(app, {
    registry,
    assertCanWriteArtifacts: async () => {},
    workspaceLockManager: options.workspaceLockManager ??
      new InMemoryDocumentLockManager(),
    resolveTarget: async ({ candidate }) => {
      if (candidate.artifactInternalId === OTHER_ARTIFACT_ID) return target(OTHER_ARTIFACT_ID, "docs/other.md");
      if (candidate.artifactInternalId === "33333333-3333-4333-8333-333333333333") {
        return { ok: false as const, code: "forbidden" as const };
      }
      return options.resolveWorkspaceTarget?.() ?? target();
    },
  });
  apps.push(app);
  return app;
}

function registerBody(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "editor-session-1",
    target: {
      kind: "workspace_artifact",
      artifactInternalId: ARTIFACT_ID,
      logicalPath: "docs/report.md",
    },
    state: "clean",
    ...overrides,
  };
}

function renewBody(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "editor-session-1",
    expectedGeneration: 0,
    target: {
      kind: "workspace_artifact",
      artifactInternalId: ARTIFACT_ID,
      logicalPath: "docs/report.md",
    },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("human edit lease HTTP routes", () => {
  test("requires an authenticated session and rejects client authority fields", async () => {
    const app = makeApp();
    expect((await app.inject({
      method: "POST",
      url: "/api/document-mutations/human-edit-leases",
      headers: { "x-test-user": "none" },
      payload: registerBody(),
    })).statusCode).toBe(401);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/document-mutations/human-edit-leases",
      payload: registerBody({ humanId: "forged-owner", baseVersion: { sha256: "b".repeat(64) } }),
    });
    expect(rejected.statusCode).toBe(400);
  });

  test("derives a lease, makes registration retry-idempotent, and enforces target binding", async () => {
    const app = makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/document-mutations/human-edit-leases",
      payload: registerBody(),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body) as { status: string; record: { lease: { leaseId: string; humanId: string; generation: number; baseVersion: { sha256: string } } } };
    expect(firstBody).toMatchObject({
      status: "ok",
      record: { lease: { humanId: "human-1", generation: 0, baseVersion: { sha256: SHA } } },
    });

    const retry = await app.inject({
      method: "POST",
      url: "/api/document-mutations/human-edit-leases",
      payload: registerBody(),
    });
    expect(retry.statusCode).toBe(200);
    const retryBody = JSON.parse(retry.body) as { record: { lease: { leaseId: string } } };
    expect(retryBody.record.lease.leaseId).toBe(firstBody.record.lease.leaseId);

    const mismatch = await app.inject({
      method: "PATCH",
      url: `/api/document-mutations/human-edit-leases/${firstBody.record.lease.leaseId}`,
      payload: {
        ...registerBody({
          target: { kind: "workspace_artifact", artifactInternalId: OTHER_ARTIFACT_ID, logicalPath: "docs/other.md" },
        }),
        expectedGeneration: 0,
      },
    });
    expect(mismatch.statusCode).toBe(404);
  });

  test("waits for an in-flight Workspace mutation and registers its post-commit version", async () => {
    const workspaceLockManager = new InMemoryDocumentLockManager();
    const identity = target().target.identity;
    const mutationLease = await workspaceLockManager.acquire(
      deriveDocumentIdentityLockKeys(identity),
    );
    let revision = 7;
    let resolutions = 0;
    const app = makeApp(undefined, {
      workspaceLockManager,
      resolveWorkspaceTarget: () => {
        resolutions += 1;
        const resolved = target();
        return {
          ...resolved,
          target: {
            ...resolved.target,
            baseVersion: {
              ...resolved.target.baseVersion,
              backendVersion: {
                kind: "artifact_revision" as const,
                revision,
              },
            },
          },
        };
      },
    });
    await app.ready();
    let settled = false;
    const registering = app.inject({
      method: "POST",
      url: "/api/document-mutations/human-edit-leases",
      payload: registerBody(),
    }).then((response) => {
      settled = true;
      return response;
    });
    for (let attempt = 0; attempt < 20 && resolutions === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(resolutions).toBe(1);
    expect(settled).toBe(false);

    revision = 8;
    mutationLease.release();
    const response = await registering;
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      status: "ok",
      record: {
        lease: {
          baseVersion: {
            backendVersion: { kind: "artifact_revision", revision: 8 },
          },
        },
      },
    });
    expect(resolutions).toBe(2);
  });

  test("serializes semantic update and release with the Workspace mutation lock", async () => {
    const workspaceLockManager = new InMemoryDocumentLockManager();
    const registry = new HumanEditLeaseRegistry({
      ttlMs: 60_000,
      newLeaseId: randomUUID,
    });
    const identity = target().target.identity;
    let resolutions = 0;
    const app = makeApp(registry, {
      workspaceLockManager,
      resolveWorkspaceTarget: () => {
        resolutions += 1;
        return target();
      },
    });
    await app.ready();
    const registered = JSON.parse((await app.inject({
      method: "POST",
      url: "/api/document-mutations/human-edit-leases",
      payload: registerBody(),
    })).body) as { record: { lease: { leaseId: string } } };
    const leaseId = registered.record.lease.leaseId;

    const updateLock = await workspaceLockManager.acquire(
      deriveDocumentIdentityLockKeys(identity),
    );
    let updateSettled = false;
    const updating = app.inject({
      method: "PATCH",
      url: `/api/document-mutations/human-edit-leases/${leaseId}`,
      payload: {
        ...registerBody({
          state: "dirty",
          draftPatch: {
            kind: "anchored_text",
            oldString: "beta",
            newString: "human beta",
          },
        }),
        expectedGeneration: 0,
      },
    }).then((response) => {
      updateSettled = true;
      return response;
    });
    const resolutionsBeforeUpdate = resolutions;
    for (
      let attempt = 0;
      attempt < 20 && resolutions === resolutionsBeforeUpdate;
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(resolutions).toBe(resolutionsBeforeUpdate + 1);
    expect(updateSettled).toBe(false);
    updateLock.release();
    const updated = await updating;
    expect(updated.statusCode).toBe(200);
    expect(JSON.parse(updated.body)).toMatchObject({
      status: "ok",
      record: { lease: { state: "dirty", generation: 1 } },
    });
    expect(resolutions).toBe(resolutionsBeforeUpdate + 2);

    const releaseLock = await workspaceLockManager.acquire(
      deriveDocumentIdentityLockKeys(identity),
    );
    let releaseSettled = false;
    const releasing = app.inject({
      method: "POST",
      url: `/api/document-mutations/human-edit-leases/${leaseId}/release`,
      payload: {
        sessionId: "editor-session-1",
        expectedGeneration: 1,
      },
    }).then((response) => {
      releaseSettled = true;
      return response;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(releaseSettled).toBe(false);
    releaseLock.release();
    expect((await releasing).statusCode).toBe(200);
    expect(registry.getForIdentity(identity)).toEqual([]);
  });

  test("maps Workspace-only admission, forbidden, stale generation, draft-rebase failure, renew, and release", async () => {
    const app = makeApp();
    expect((await app.inject({
      method: "POST",
      url: "/api/document-mutations/human-edit-leases",
      payload: registerBody({
        target: { kind: "workspace_artifact", artifactInternalId: "33333333-3333-4333-8333-333333333333", logicalPath: "docs/nope.md" },
      }),
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST",
      url: "/api/document-mutations/human-edit-leases",
      payload: registerBody({
        target: { kind: "local_file", relayId: "relay-offline", candidatePath: "/allowed/report.md" },
      }),
    })).statusCode).toBe(400);

    const draftFailure = await app.inject({
      method: "POST",
      url: "/api/document-mutations/human-edit-leases",
      payload: registerBody({
        state: "dirty",
        draftPatch: { kind: "anchored_text", oldString: "missing", newString: "new" },
      }),
    });
    expect(draftFailure.statusCode).toBe(409);

    const registered = JSON.parse((await app.inject({
      method: "POST",
      url: "/api/document-mutations/human-edit-leases",
      payload: registerBody(),
    })).body) as { record: { lease: { leaseId: string } } };
    const leaseId = registered.record.lease.leaseId;
    const stale = await app.inject({
      method: "POST",
      url: `/api/document-mutations/human-edit-leases/${leaseId}/renew`,
      payload: renewBody({ expectedGeneration: 99 }),
    });
    expect(stale.statusCode).toBe(409);
    const staleBody = JSON.parse(stale.body) as { status: string };
    expect(staleBody.status).toBe("stale_generation");

    expect((await app.inject({
      method: "POST",
      url: `/api/document-mutations/human-edit-leases/${leaseId}/renew`,
      payload: renewBody(),
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/api/document-mutations/human-edit-leases/${leaseId}/release`,
      payload: { sessionId: "editor-session-1", expectedGeneration: 0 },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/api/document-mutations/human-edit-leases/${leaseId}/renew`,
      payload: renewBody(),
    })).statusCode).toBe(404);
  });

  test("hides another human's lease as absent", async () => {
    const app = makeApp();
    const registered = JSON.parse((await app.inject({
      method: "POST",
      url: "/api/document-mutations/human-edit-leases",
      payload: registerBody(),
    })).body) as { record: { lease: { leaseId: string } } };
    expect((await app.inject({
      method: "POST",
      url: `/api/document-mutations/human-edit-leases/${registered.record.lease.leaseId}/renew`,
      headers: { "x-test-user": "human-2" },
      payload: renewBody(),
    })).statusCode).toBe(404);
  });

  test("records an unrebaseable draft as conflict truth but rejects it while dirty", async () => {
    const app = makeApp();
    const registered = JSON.parse((await app.inject({
      method: "POST",
      url: "/api/document-mutations/human-edit-leases",
      payload: registerBody(),
    })).body) as { record: { lease: { leaseId: string } } };
    const leaseId = registered.record.lease.leaseId;
    const draftPatch = { kind: "anchored_text", oldString: "missing", newString: "new" };

    const conflict = await app.inject({
      method: "PATCH",
      url: `/api/document-mutations/human-edit-leases/${leaseId}`,
      payload: {
        ...registerBody({ state: "conflict", draftPatch }),
        expectedGeneration: 0,
      },
    });
    expect(conflict.statusCode).toBe(200);
    const conflictBody = JSON.parse(conflict.body) as {
      status: string;
      record: { lease: { state: string; draftPatch: unknown; generation: number } };
    };
    expect(conflictBody).toMatchObject({
      status: "ok",
      record: { lease: { state: "conflict", draftPatch, generation: 1 } },
    });

    const dirty = await app.inject({
      method: "PATCH",
      url: `/api/document-mutations/human-edit-leases/${leaseId}`,
      payload: {
        ...registerBody({ state: "dirty", draftPatch }),
        expectedGeneration: 1,
      },
    });
    expect(dirty.statusCode).toBe(409);
    expect((JSON.parse(dirty.body) as { status: string }).status).toBe("invalid");
  });

  test("reauthorizes renew without extending a revoked or target-mismatched lease", async () => {
    let now = 10_000;
    const registry = new HumanEditLeaseRegistry({
      ttlMs: 60_000,
      now: () => now,
      newLeaseId: randomUUID,
    });
    const app = makeApp(registry);
    const registered = JSON.parse((await app.inject({
      method: "POST",
      url: "/api/document-mutations/human-edit-leases",
      payload: registerBody(),
    })).body) as { record: { lease: { leaseId: string } } };
    const leaseId = registered.record.lease.leaseId;
    const identity = {
      kind: "workspace_artifact" as const,
      artifactId: ARTIFACT_ID,
      logicalPath: "docs/report.md",
    };
    const initial = registry.getForIdentity(identity)[0]!;
    now += 1_000;

    const revoked = await app.inject({
      method: "POST",
      url: `/api/document-mutations/human-edit-leases/${leaseId}/renew`,
      payload: renewBody({
        target: {
          kind: "workspace_artifact",
          artifactInternalId: "33333333-3333-4333-8333-333333333333",
          logicalPath: "docs/nope.md",
        },
      }),
    });
    expect(revoked.statusCode).toBe(403);
    expect(registry.getForIdentity(identity)[0]).toEqual(initial);

    const mismatch = await app.inject({
      method: "POST",
      url: `/api/document-mutations/human-edit-leases/${leaseId}/renew`,
      payload: renewBody({
        target: {
          kind: "workspace_artifact",
          artifactInternalId: OTHER_ARTIFACT_ID,
          logicalPath: "docs/other.md",
        },
      }),
    });
    expect(mismatch.statusCode).toBe(404);
    expect(registry.getForIdentity(identity)[0]).toEqual(initial);
  });
});
