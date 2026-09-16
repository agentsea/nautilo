import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../../.env") });

import { describe, test, expect } from "bun:test";
import { setupOwnerAppFixture } from "../helpers/app-fixture";
import { withListeningServer } from "../helpers/request-helpers";
import {
  connectWsTestClient,
  httpBaseToWsUrl,
  openWsAwaitingAuth,
} from "./helpers/ws-test-client";

type MaintenanceFrame = {
  type: "maintenance.status";
  state: "normal" | "draining" | "applying";
  operationId: string | null;
  leaseExpiresAt: string | null;
  hardExpiresAt: string | null;
};

function isMaintenanceFrame(e: unknown): e is MaintenanceFrame {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { type?: unknown }).type === "maintenance.status"
  );
}

async function operatorPost(
  base: string,
  verb: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(`${base}/api/operator/maintenance/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/ws maintenance.status (D420 3.2.1 integration)", () => {
  test("authenticated connect delivers a snapshot; enter/applying/complete broadcast live", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsm1" });
    const operationId = randomUUID();
    try {
      await withListeningServer(fx.app, async (base) => {
        const token = await fx.mintOwnerBearer();
        const client = await connectWsTestClient({
          url: httpBaseToWsUrl(base, "/ws"),
          token,
        });
        try {
          // Connect snapshot — a client that missed prior events starts truthful.
          const snap = await client.waitForEvent(isMaintenanceFrame, 10_000);
          expect(snap.state).toBe("normal");
          expect(snap.operationId).toBeNull();
          expect(snap.leaseExpiresAt).toBeNull();
          expect(snap.hardExpiresAt).toBeNull();

          // Enter draining → live broadcast (no health poll needed).
          const enterRes = await operatorPost(base, "enter", { operationId });
          expect(enterRes.status).toBe(200);
          const draining = await client.waitForEvent(
            (e): e is MaintenanceFrame => isMaintenanceFrame(e) && e.state === "draining",
            10_000,
          );
          expect(draining.operationId).toBe(operationId);
          expect(draining.leaseExpiresAt).not.toBeNull();
          expect(draining.hardExpiresAt).not.toBeNull();

          // Applying → live broadcast.
          const applyingRes = await operatorPost(base, "applying", { operationId });
          expect(applyingRes.status).toBe(200);
          const applying = await client.waitForEvent(
            (e): e is MaintenanceFrame => isMaintenanceFrame(e) && e.state === "applying",
            10_000,
          );
          expect(applying.operationId).toBe(operationId);

          // Complete → returns to normal, broadcast live.
          const completeRes = await operatorPost(base, "complete", { operationId });
          expect(completeRes.status).toBe(200);
          const normal = await client.waitForEvent(
            (e): e is MaintenanceFrame => isMaintenanceFrame(e) && e.state === "normal",
            10_000,
          );
          expect(normal.operationId).toBeNull();
          expect(normal.leaseExpiresAt).toBeNull();
        } finally {
          await client.close();
          await new Promise((r) => setTimeout(r, 50));
        }
      });
    } finally {
      await fx.cleanup();
    }
  });

  test("maintenance.status frames carry no sensitive payload (no work/job/prompt/user)", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsm2" });
    const operationId = randomUUID();
    try {
      await withListeningServer(fx.app, async (base) => {
        const token = await fx.mintOwnerBearer();
        const client = await connectWsTestClient({
          url: httpBaseToWsUrl(base, "/ws"),
          token,
        });
        try {
          await client.waitForEvent(isMaintenanceFrame, 10_000);
          await operatorPost(base, "enter", { operationId });
          const draining = await client.waitForEvent(
            (e): e is MaintenanceFrame => isMaintenanceFrame(e) && e.state === "draining",
            10_000,
          );
          const wire = JSON.stringify(draining);
          for (const forbidden of [
            "work",
            "runningForegroundJobs",
            "queuedTurns",
            "acceptedWork",
            "runningTaskRuns",
            "claimedTasks",
            "jobId",
            "prompt",
            "laneKey",
            "roomId",
            "userId",
            "actorId",
          ]) {
            expect(wire).not.toContain(forbidden);
          }
          // Clean up the lease so the next suite starts normal.
          await operatorPost(base, "complete", { operationId });
        } finally {
          await client.close();
          await new Promise((r) => setTimeout(r, 50));
        }
      });
    } finally {
      await fx.cleanup();
    }
  });

  test("pre-auth socket receives no maintenance.status frame during a drain", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsm3" });
    const operationId = randomUUID();
    try {
      await withListeningServer(fx.app, async (base) => {
        const raw = await openWsAwaitingAuth(httpBaseToWsUrl(base, "/ws"));
        try {
          await operatorPost(base, "enter", { operationId });
          // Give the broadcast a chance to (incorrectly) reach the pre-auth socket.
          await new Promise((r) => setTimeout(r, 250));
          const maint = raw.events.filter(isMaintenanceFrame);
          expect(maint).toHaveLength(0);
          // Pre-auth socket must also have received nothing else.
          expect(raw.events.length).toBe(0);
        } finally {
          // Best-effort lease cleanup before tearing down.
          await operatorPost(base, "complete", { operationId }).catch(() => undefined);
          await raw.close();
          await new Promise((r) => setTimeout(r, 50));
        }
      });
    } finally {
      await fx.cleanup();
    }
  });
});
