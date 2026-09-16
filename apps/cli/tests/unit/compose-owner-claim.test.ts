import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { composeProjectName, type ComposeDriverProfile } from "@nautilo/compose-driver";
import { OwnerClaimAmbiguousWriteError, OwnerClaimApiError } from "@nautilo/api-client";

import {
  composeOwnerConfigIdentity,
  continueComposeOwnerConfig,
  continueComposeOwnerClaim,
  composeOwnerResumeCommand,
  prepareComposeOwnerClaim,
  prepareComposeOwnerConfig,
  type PreparedComposeOwnerClaim,
} from "../../src/lib/compose-owner-claim.ts";
import { OWNER_SEED_RESULT_SCHEMA, type OwnerSeedResult } from "../../src/lib/owner-seed-result.ts";
import {
  composeOwnerClaimControlFingerprint,
  KeyringComposeOwnerClaimStore,
} from "../../src/lib/compose-owner-claim-store.ts";
import { OwnerClaimControllerError, hashOwnerClaim, type OwnerClaimTarget } from "../../src/lib/owner-claim-target.ts";

const claim = `inv_${"a".repeat(32)}`;
const profile: ComposeDriverProfile = {
  name: "test-profile",
  transport: "local",
  lifecycle: "compose",
  instance_id: "test",
};

class MemoryEntry {
  value: string | null = null;
  async getPassword(): Promise<string | null> { return this.value; }
  async setPassword(value: string): Promise<void> { this.value = value; }
  async deleteCredential(): Promise<boolean> { this.value = null; return true; }
}

async function prepared(entry = new MemoryEntry()): Promise<PreparedComposeOwnerClaim> {
  const identity = {
    profileName: profile.name,
    instanceId: "test",
    controlFingerprint: composeOwnerClaimControlFingerprint({
      transport: "local",
      instanceId: "test",
      projectName: composeProjectName(profile),
    }),
    mode: "claim" as const,
  };
  const store = new KeyringComposeOwnerClaimStore(entry);
  await store.getOrCreate(identity, () => claim);
  return prepareComposeOwnerClaim(profile, { createStore: async () => store });
}

const control = {
  targetUrl: "http://127.0.0.1:3001",
  fetchImpl: fetch,
  transport: { validateTargetUrl: (value: string) => new URL(value) },
};

function dependencies(target: OwnerClaimTarget) {
  return {
    createTarget: () => target,
    resolveControlPlane: () => control,
    resolveServerUrl: () => "http://127.0.0.1:3001",
    readBootstrapToken: () => "b".repeat(32),
    now: () => Date.parse("2026-08-09T00:00:00.000Z"),
  };
}

describe("Compose owner claim continuation", () => {
  test("fresh deploy installs the exact capability persisted before Docker", async () => {
    const beforeDocker = await prepared();
    let installedHash = "";
    const target: OwnerClaimTarget = {
      status: async () => ({ schemaVersion: 1, state: "awaiting-owner" }),
      install: async (input) => {
        installedHash = input.claimHash;
        expect(input.authorization).toEqual({ kind: "bearer", token: "b".repeat(32) });
        return { schemaVersion: 1, state: "claim-active" };
      },
    };
    const result = await continueComposeOwnerClaim({
      profile,
      prepared: beforeDocker,
      finish: "guide",
      openBrowser: false,
      dependencies: dependencies(target),
    });
    expect(installedHash).toBe(hashOwnerClaim(claim));
    expect(result.outcome).toBe("claim-active");
  });

  test("ambiguous install re-observes then retries the byte-identical write before handoff", async () => {
    const beforeDocker = await prepared();
    const writes: unknown[] = [];
    let statusCalls = 0;
    const target: OwnerClaimTarget = {
      status: async () => ({
        schemaVersion: 1,
        state: statusCalls++ === 0 ? "awaiting-owner" : "claim-active",
      }),
      install: async (input) => {
        writes.push(input);
        if (writes.length === 1) throw new OwnerClaimControllerError("ambiguous-write");
        return { schemaVersion: 1, state: "claim-active" };
      },
    };
    const result = await continueComposeOwnerClaim({
      profile,
      prepared: beforeDocker,
      finish: "guide",
      openBrowser: false,
      dependencies: dependencies(target),
    });
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(result.outcome).toBe("claim-active");
  });

  test("never calls owner-bound complete until exact custody is cleared", async () => {
    const entry = new MemoryEntry();
    const beforeDocker = await prepared(entry);
    const target: OwnerClaimTarget = {
      status: async () => ({ schemaVersion: 1, state: "owner-bound" }),
      install: async () => { throw new Error("must not install"); },
    };
    const result = await continueComposeOwnerClaim({
      profile,
      prepared: beforeDocker,
      finish: "guide",
      openBrowser: false,
      dependencies: dependencies(target),
    });
    expect(result.outcome).toBe("owner-bound");
    expect(entry.value).toBeNull();
  });

  test("interactive expiry is reported as awaiting-owner and retains custody", async () => {
    const entry = new MemoryEntry();
    const beforeDocker = await prepared(entry);
    let statusCalls = 0;
    let closed = false;
    const target: OwnerClaimTarget = {
      status: async () => ({
        schemaVersion: 1,
        state: statusCalls++ === 0 ? "awaiting-owner" : "awaiting-owner",
      }),
      install: async () => ({ schemaVersion: 1, state: "claim-active" }),
    };
    const result = await continueComposeOwnerClaim({
      profile,
      prepared: beforeDocker,
      finish: "guide",
      openBrowser: true,
      dependencies: {
        ...dependencies(target),
        createHandoff: async () => ({
          localUrl: "http://127.0.0.1:4444/handoff/test",
          close: async () => { closed = true; },
        }),
        openBrowser: async () => undefined,
        pollAttempts: 1,
      },
    });
    expect(result.outcome).toBe("awaiting-owner");
    expect(entry.value).not.toBeNull();
    expect(closed).toBe(true);
  });

  test("explicit browser handoff works without a TTY", async () => {
    const entry = new MemoryEntry();
    const beforeDocker = await prepared(entry);
    let statusCalls = 0;
    let opened = false;
    const target: OwnerClaimTarget = {
      status: async () => ({
        schemaVersion: 1,
        state: statusCalls++ === 0 ? "awaiting-owner" : "owner-bound",
      }),
      install: async () => ({ schemaVersion: 1, state: "claim-active" }),
    };
    const result = await continueComposeOwnerClaim({
      profile,
      prepared: beforeDocker,
      finish: "guide",
      openBrowser: true,
      dependencies: {
        ...dependencies(target),
        createHandoff: async () => ({ localUrl: "http://127.0.0.1:4444/handoff/test", close: async () => undefined }),
        openBrowser: async () => { opened = true; },
        pollAttempts: 1,
      },
    });
    expect(opened).toBe(true);
    expect(result.outcome).toBe("owner-bound");
    expect(entry.value).toBeNull();
  });

  test("claim-active with lost custody persists a replacement and PUTs it before handoff", async () => {
    const entry = new MemoryEntry();
    const order: string[] = [];
    let statusCalls = 0;
    const target: OwnerClaimTarget = {
      status: async () => ({
        schemaVersion: 1,
        state: statusCalls++ === 0 ? "claim-active" : "owner-bound",
      }),
      install: async () => {
        expect(entry.value).not.toBeNull();
        order.push("replacement-put");
        return { schemaVersion: 1, state: "claim-active" };
      },
    };
    const result = await continueComposeOwnerClaim({
      profile,
      finish: "guide",
      openBrowser: true,
      dependencies: {
        ...dependencies(target),
        createStore: async () => new KeyringComposeOwnerClaimStore(entry),
        createHandoff: async () => {
          order.push("handoff");
          return { localUrl: "http://127.0.0.1:4444/handoff/test", close: async () => undefined };
        },
        openBrowser: async () => undefined,
        pollAttempts: 1,
      },
    });
    expect(order).toEqual(["replacement-put", "handoff"]);
    expect(result.outcome).toBe("owner-bound");
    expect(entry.value).toBeNull();
  });

  test("the hosted path has no legacy invite mint/read/redeem fallback", () => {
    const deploy = readFileSync(fileURLToPath(new URL("../../src/commands/deploy.ts", import.meta.url)), "utf8");
    const claimFlow = readFileSync(fileURLToPath(new URL("../../src/lib/compose-owner-claim.ts", import.meta.url)), "utf8");
    for (const forbidden of ["mintClaimInvite", "readClaimInviteToken", "redeemInvite"]) {
      expect(`${deploy}\n${claimFlow}`).not.toContain(forbidden);
    }
  });

  test("remote continuation needs no local instance bytes, uses SSH-loopback authority, and never reads a bearer", async () => {
    const remoteProfile: ComposeDriverProfile = {
      name: "remote",
      transport: "remote",
      lifecycle: "compose",
      instance_id: "prod",
      https: "letsencrypt",
      domain: "nautilo.example",
      ssh: { host: "203.0.113.4", user: "root" },
    };
    const remoteEntry = new MemoryEntry();
    const beforeDocker = await prepareComposeOwnerClaim(remoteProfile, {
      createStore: async () => new KeyringComposeOwnerClaimStore(remoteEntry),
    });
    const target: OwnerClaimTarget = {
      status: async () => ({ schemaVersion: 1, state: "awaiting-owner" }),
      install: async (input) => {
        expect(input.authorization).toEqual({ kind: "trusted-loopback" });
        return { schemaVersion: 1, state: "claim-active" };
      },
    };
    const result = await continueComposeOwnerClaim({
      profile: remoteProfile,
      prepared: beforeDocker,
      finish: "product",
      openBrowser: false,
      dependencies: {
        createTarget: () => target,
        resolveServerUrl: () => "https://nautilo.example",
        readBootstrapToken: () => { throw new Error("remote must not read a bearer"); },
      },
    });
    expect(result.outcome).toBe("claim-active");
  });

  test("unobservable target retains custody and reports target-unavailable", async () => {
    const entry = new MemoryEntry();
    const beforeDocker = await prepared(entry);
    const target: OwnerClaimTarget = {
      status: async () => { throw new OwnerClaimControllerError("unreachable"); },
      install: async () => { throw new Error("must not install"); },
    };
    const result = await continueComposeOwnerClaim({
      profile,
      prepared: beforeDocker,
      finish: "guide",
      openBrowser: false,
      dependencies: dependencies(target),
    });
    expect(result).toMatchObject({ outcome: "target-unavailable", controllerFailure: "unreachable" });
    expect(entry.value).not.toBeNull();
  });

  test("mismatched prepared control identity fails before any target I/O", async () => {
    const beforeDocker = await prepared();
    let targetIo = false;
    try {
      await continueComposeOwnerClaim({
        profile: { ...profile, instance_id: "other" },
        prepared: beforeDocker,
        finish: "guide",
        openBrowser: false,
        dependencies: {
          ...dependencies({
            status: async () => { targetIo = true; throw new Error("must not observe"); },
            install: async () => { targetIo = true; throw new Error("must not install"); },
          }),
          resolveServerUrl: () => { targetIo = true; return "http://localhost:3001"; },
        },
      });
      throw new Error("expected custody mismatch");
    } catch (error) {
      expect(error).toHaveProperty("message", "Compose owner claim custody failed");
    }
    expect(targetIo).toBe(false);
  });

  test("exact resume shell-quotes the profile and preserves finish", () => {
    expect(composeOwnerResumeCommand("customer prod's", "product"))
      .toBe("nautilo claim resume --profile 'customer prod'\\''s' --finish product");
  });
});

describe("Compose protected owner config continuation", () => {
  const resultPath = "/tmp/operator-owned-result.json";
  const owner = {
    handle: "operator",
    displayName: "Server Operator",
    password: "permanent-password",
    pin: "123456",
  };
  const codes = Array.from({ length: 8 }, (_, index) => index.toString(16).padStart(24, "0"));

  async function configPrepared(entry = new MemoryEntry()): Promise<PreparedComposeOwnerClaim> {
    return prepareComposeOwnerConfig(profile, resultPath, {
      createStore: async () => new KeyringComposeOwnerClaimStore(entry),
    });
  }

  function existingResult(): OwnerSeedResult {
    return {
      schema: OWNER_SEED_RESULT_SCHEMA,
      profile: profile.name,
      targetFingerprint: composeOwnerConfigIdentity(profile, resultPath).controlFingerprint,
      handle: owner.handle,
      recoveryCodes: codes,
    };
  }

  test("publishes recovery codes before clearing custody or reporting owner-bound", async () => {
    const entry = new MemoryEntry();
    const beforeDocker = await configPrepared(entry);
    const order: string[] = [];
    let statusCalls = 0;
    const target: OwnerClaimTarget = {
      status: async () => ({
        schemaVersion: 1,
        state: statusCalls++ === 0 ? "awaiting-owner" : "owner-bound",
      }),
      install: async () => ({ schemaVersion: 1, state: "claim-active" }),
    };
    const result = await continueComposeOwnerConfig({
      profile,
      prepared: beforeDocker,
      owner,
      resultPath,
      dependencies: {
        ...dependencies(target),
        redeemOwner: async (_url, actualClaim, actualOwner) => {
          expect(actualClaim).toMatch(/^inv_[A-Za-z0-9_-]{32}$/);
          const stored = JSON.parse(entry.value ?? "{}") as unknown;
          expect(
            typeof stored === "object" && stored !== null && "claim" in stored
              ? (stored as { claim: unknown }).claim
              : undefined,
          ).toBe(actualClaim);
          expect(actualOwner).toEqual(owner);
          order.push("redeem");
          return { schemaVersion: 1, state: "owner-bound", recoveryCodes: codes };
        },
        publishOwnerResult: async ({ result: published }) => {
          expect(entry.value).not.toBeNull();
          expect(published.recoveryCodes).toEqual(codes);
          order.push("publish");
          return { kind: "published", path: resultPath, result: published };
        },
      },
    });
    order.push(entry.value === null ? "cleared" : "retained");
    expect(order).toEqual(["redeem", "publish", "cleared"]);
    expect(result).toMatchObject({ outcome: "owner-bound", ownerResultPath: resultPath });
  });

  test("existing durable result with non-owner-bound target stops before every mutation", async () => {
    const beforeDocker = await configPrepared();
    let mutations = 0;
    const target: OwnerClaimTarget = {
      status: async () => ({ schemaVersion: 1, state: "claim-active" }),
      install: async () => { mutations += 1; throw new Error("must not install"); },
    };
    const result = await continueComposeOwnerConfig({
      profile, prepared: beforeDocker, owner, resultPath,
      existingResult: existingResult(),
      dependencies: {
        ...dependencies(target),
        redeemOwner: async () => { mutations += 1; throw new Error("must not redeem"); },
        publishOwnerResult: async () => { mutations += 1; throw new Error("must not publish"); },
      },
    });
    expect(mutations).toBe(0);
    expect(result).toMatchObject({
      outcome: "install-unknown",
      controllerFailure: "owner-state-result-inconsistent",
    });
  });

  test("a definite install rejection is not observed or retried", async () => {
    const beforeDocker = await configPrepared();
    let statusCalls = 0;
    let installs = 0;
    const target: OwnerClaimTarget = {
      status: async () => { statusCalls += 1; return { schemaVersion: 1, state: "awaiting-owner" }; },
      install: async () => { installs += 1; throw new OwnerClaimControllerError("authorization-rejected"); },
    };
    const result = await continueComposeOwnerConfig({
      profile, prepared: beforeDocker, owner, resultPath,
      dependencies: dependencies(target),
    });
    expect({ statusCalls, installs }).toEqual({ statusCalls: 1, installs: 1 });
    expect(result).toMatchObject({ outcome: "install-unknown", controllerFailure: "authorization-rejected" });
  });

  test("lost redeem response followed by owner-bound without result is recovery-required", async () => {
    const entry = new MemoryEntry();
    const beforeDocker = await configPrepared(entry);
    let statusCalls = 0;
    let redeems = 0;
    const target: OwnerClaimTarget = {
      status: async () => ({
        schemaVersion: 1,
        state: statusCalls++ === 0 ? "awaiting-owner" : "owner-bound",
      }),
      install: async () => ({ schemaVersion: 1, state: "claim-active" }),
    };
    const result = await continueComposeOwnerConfig({
      profile, prepared: beforeDocker, owner, resultPath,
      dependencies: {
        ...dependencies(target),
        redeemOwner: async () => { redeems += 1; throw new OwnerClaimAmbiguousWriteError("redeem"); },
      },
    });
    expect(redeems).toBe(1);
    expect(result).toMatchObject({ outcome: "recovery-required", controllerFailure: "recovery-result-missing" });
    expect(entry.value).not.toBeNull();
  });

  test("durable publication failure is structured and retains custody", async () => {
    const entry = new MemoryEntry();
    const beforeDocker = await configPrepared(entry);
    const target: OwnerClaimTarget = {
      status: async () => ({ schemaVersion: 1, state: "awaiting-owner" }),
      install: async () => ({ schemaVersion: 1, state: "claim-active" }),
    };
    const result = await continueComposeOwnerConfig({
      profile, prepared: beforeDocker, owner, resultPath,
      dependencies: {
        ...dependencies(target),
        redeemOwner: async () => ({ schemaVersion: 1, state: "owner-bound", recoveryCodes: codes }),
        publishOwnerResult: async () => { throw new Error("disk full"); },
      },
    });
    expect(result).toMatchObject({
      outcome: "recovery-required",
      controllerFailure: "recovery-result-publish-failed",
    });
    expect(entry.value).not.toBeNull();
  });

  test("definite redeem error preserves its code without reobserve or retry", async () => {
    const beforeDocker = await configPrepared();
    let statuses = 0;
    let redeems = 0;
    const target: OwnerClaimTarget = {
      status: async () => { statuses += 1; return { schemaVersion: 1, state: "awaiting-owner" }; },
      install: async () => ({ schemaVersion: 1, state: "claim-active" }),
    };
    const result = await continueComposeOwnerConfig({
      profile, prepared: beforeDocker, owner, resultPath,
      dependencies: {
        ...dependencies(target),
        redeemOwner: async () => { redeems += 1; throw new OwnerClaimApiError(409, "handle_conflict"); },
      },
    });
    expect({ statuses, redeems }).toEqual({ statuses: 1, redeems: 1 });
    expect(result).toMatchObject({ outcome: "claim-active", controllerFailure: "handle_conflict" });
  });

  test("local direct seed carries bootstrap authority without putting secrets in the URL", async () => {
    const beforeDocker = await configPrepared();
    const calls: Array<{ url: string; method: string; authorization: string | null; body: string }> = [];
    let statusCalls = 0;
    const bootstrapToken = "b".repeat(32);
    const transport = async (request: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = request instanceof Request ? request.url : String(request);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
        body: typeof init?.body === "string" ? init.body : "",
      });
      if (url.endsWith("/api/setup/owner-claim/status")) {
        return Response.json({
          schemaVersion: 1,
          state: statusCalls++ === 0 ? "awaiting-owner" : "owner-bound",
        });
      }
      if (url.endsWith("/api/setup/owner-claim")) {
        return Response.json({ schemaVersion: 1, state: "claim-active" });
      }
      if (url.endsWith("/api/setup/owner-claim/redeem")) {
        return Response.json({ schemaVersion: 1, state: "owner-bound", recoveryCodes: codes });
      }
      return new Response(null, { status: 404 });
    };
    const result = await continueComposeOwnerConfig({
      profile,
      prepared: beforeDocker,
      owner,
      resultPath,
      dependencies: {
        resolveControlPlane: () => ({
          targetUrl: "http://127.0.0.1:3001",
          fetchImpl: transport,
          transport: { validateTargetUrl: (value) => new URL(value) },
        }),
        resolveServerUrl: () => "http://127.0.0.1:3001",
        readBootstrapToken: () => bootstrapToken,
        now: () => Date.parse("2026-08-09T00:00:00.000Z"),
        publishOwnerResult: async ({ path, result: published }) => ({ kind: "published", path, result: published }),
      },
    });
    expect(result.outcome).toBe("owner-bound");
    const install = calls.find((call) => call.url.endsWith("/api/setup/owner-claim"));
    const redeem = calls.find((call) => call.url.endsWith("/api/setup/owner-claim/redeem"));
    const redeemBody = JSON.parse(redeem?.body ?? "{}") as Record<string, unknown>;
    const redeemedClaim = typeof redeemBody["claim"] === "string"
      ? redeemBody["claim"]
      : "";
    expect(install?.authorization).toBe(`Bearer ${bootstrapToken}`);
    expect(redeem?.authorization).toBe(`Bearer ${bootstrapToken}`);
    expect(redeemedClaim).toMatch(/^inv_[A-Za-z0-9_-]{32}$/);
    expect(redeem?.url).not.toContain(redeemedClaim);
    expect(redeem?.url).not.toContain(owner.password);
    expect(redeem?.url).not.toContain(owner.pin);
    expect(redeemBody).toEqual({
      schemaVersion: 1,
      claim: redeemedClaim,
      handle: owner.handle,
      displayName: owner.displayName,
      password: owner.password,
      pin: owner.pin,
    });
  });

  test("remote direct seed stays on trusted SSH-loopback without reading or sending a bearer", async () => {
    const remoteProfile: ComposeDriverProfile = {
      name: "remote-config",
      transport: "remote",
      lifecycle: "compose",
      instance_id: "prod",
      https: "letsencrypt",
      domain: "nautilo.example",
      ssh: { host: "203.0.113.4", user: "root" },
    };
    const beforeDocker = await prepareComposeOwnerConfig(remoteProfile, resultPath, {
      createStore: async () => new KeyringComposeOwnerClaimStore(new MemoryEntry()),
    });
    const calls: Array<{ url: string; authorization: string | null }> = [];
    let statusCalls = 0;
    const transport = async (request: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = request instanceof Request ? request.url : String(request);
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/api/setup/owner-claim/status")) {
        return Response.json({
          schemaVersion: 1,
          state: statusCalls++ === 0 ? "awaiting-owner" : "owner-bound",
        });
      }
      if (url.endsWith("/api/setup/owner-claim")) {
        return Response.json({ schemaVersion: 1, state: "claim-active" });
      }
      if (url.endsWith("/api/setup/owner-claim/redeem")) {
        return Response.json({ schemaVersion: 1, state: "owner-bound", recoveryCodes: codes });
      }
      return new Response(null, { status: 404 });
    };
    const result = await continueComposeOwnerConfig({
      profile: remoteProfile,
      prepared: beforeDocker,
      owner,
      resultPath,
      dependencies: {
        resolveControlPlane: () => ({
          targetUrl: "http://127.0.0.1:3001",
          fetchImpl: transport,
          transport: { validateTargetUrl: (value) => new URL(value) },
        }),
        resolveServerUrl: () => "https://nautilo.example",
        readBootstrapToken: () => { throw new Error("remote must not read a bearer"); },
        now: () => Date.parse("2026-08-09T00:00:00.000Z"),
        publishOwnerResult: async ({ path, result: published }) => ({ kind: "published", path, result: published }),
      },
    });
    expect(result.outcome).toBe("owner-bound");
    expect(calls.some((call) => call.url.endsWith("/api/setup/owner-claim/redeem"))).toBe(true);
    expect(calls.every((call) => call.authorization === null)).toBe(true);
  });

  test("ambiguous redeem with claim-active retries the exact body and claim once", async () => {
    const beforeDocker = await configPrepared();
    let statusCalls = 0;
    const calls: unknown[] = [];
    const target: OwnerClaimTarget = {
      status: async () => ({
        schemaVersion: 1,
        state: statusCalls++ < 2 ? (statusCalls === 1 ? "awaiting-owner" : "claim-active") : "owner-bound",
      }),
      install: async () => ({ schemaVersion: 1, state: "claim-active" }),
    };
    const result = await continueComposeOwnerConfig({
      profile, prepared: beforeDocker, owner, resultPath,
      dependencies: {
        ...dependencies(target),
        redeemOwner: async (_url, actualClaim, actualOwner) => {
          calls.push({ actualClaim, actualOwner });
          if (calls.length === 1) throw new OwnerClaimAmbiguousWriteError("redeem");
          return { schemaVersion: 1, state: "owner-bound", recoveryCodes: codes };
        },
        publishOwnerResult: async ({ result: published }) => ({ kind: "published", path: resultPath, result: published }),
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(result.outcome).toBe("owner-bound");
  });

  test("existing owner-bound result is re-synced before custody clears", async () => {
    const entry = new MemoryEntry();
    const beforeDocker = await configPrepared(entry);
    let synced = false;
    const target: OwnerClaimTarget = {
      status: async () => ({ schemaVersion: 1, state: "owner-bound" }),
      install: async () => { throw new Error("must not install"); },
    };
    const result = await continueComposeOwnerConfig({
      profile, prepared: beforeDocker, owner, resultPath,
      existingResult: existingResult(),
      dependencies: {
        ...dependencies(target),
        durabilizeOwnerResult: async () => { synced = true; return existingResult(); },
      },
    });
    expect(synced).toBe(true);
    expect(result.outcome).toBe("owner-bound");
    expect(entry.value).toBeNull();
  });

  test("existing result sync failure retains custody and never reports complete", async () => {
    const entry = new MemoryEntry();
    const beforeDocker = await configPrepared(entry);
    const target: OwnerClaimTarget = {
      status: async () => ({ schemaVersion: 1, state: "owner-bound" }),
      install: async () => { throw new Error("must not install"); },
    };
    const result = await continueComposeOwnerConfig({
      profile, prepared: beforeDocker, owner, resultPath,
      existingResult: existingResult(),
      dependencies: {
        ...dependencies(target),
        durabilizeOwnerResult: async () => { throw new Error("fsync failed"); },
      },
    });
    expect(result).toMatchObject({ outcome: "recovery-required", controllerFailure: "recovery-result-sync-failed" });
    expect(entry.value).not.toBeNull();
  });
});
