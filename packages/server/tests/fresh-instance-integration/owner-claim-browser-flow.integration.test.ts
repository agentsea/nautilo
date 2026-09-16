/**
 * D488 0B.6A.4 — exercise the hosted first-owner handoff across its actual
 * browser custody seam, API client, Fastify routes, Logto bind, and profile
 * completion. This intentionally uses the ordinary app fixture; it converts
 * that fixture's seeded owner back to the production bootstrap shape instead
 * of introducing a second database/concurrency harness.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ApiError, NautiloApiClient } from "@nautilo/api-client";
import {
  channelIdentities,
  credentials,
  eq,
  groups,
  inArray,
  invites,
  profiles,
  users,
} from "@nautilo/db";
import type { LogtoAdminClient } from "@nautilo/trust";
import {
  consumeOwnerClaimFragment,
  readOwnerClaimHandoff,
} from "../../../../apps/workbench/src/lib/owner-claim-handoff";
import { _setLogtoAdminClientForTests } from "../../../trust/src/logto-admin";
import {
  readSecurityAuditLog,
  type InviteBindLogtoUserSucceededAuditEvent,
  type InviteRedeemedAuditEvent,
  type SecurityAuditEvent,
} from "../../src/lib/security-audit-log";
import { setupOwnerAppFixture, type AppFixture } from "../integration/helpers/app-fixture";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function newToken(): string {
  return `inv_${randomBytes(24).toString("base64url")}`;
}

function storage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  } as Storage;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

type WireCall = { readonly url: string; readonly body: string | null };

function isBoundOwnerAudit(
  event: SecurityAuditEvent,
  userId: string,
): event is InviteBindLogtoUserSucceededAuditEvent {
  return event.kind === "invite_bind_logto_user_succeeded" && event.userId === userId;
}

function isCompletedOwnerAudit(
  event: SecurityAuditEvent,
  userId: string,
): event is InviteRedeemedAuditEvent {
  return event.kind === "invite_redeemed" && event.newUserId === userId;
}

describe("D488 owner claim browser/API/Fastify boundary", () => {
  let fx: AppFixture;
  let fixtureReady = false;
  let baseUrl: string;
  let claim: string;
  let reissuedClaim: string;
  let expiredClaim: string;
  let ordinaryInvite: string;
  let claimantBearer: string;
  let originalFetch: typeof fetch;
  let wire: WireCall[];
  let auditRoot: string;
  let auditLogPath: string;
  const createdHashes: string[] = [];
  const originalSessionStorage = (globalThis as Record<string, unknown>)["sessionStorage"];

  beforeAll(async () => {
    auditRoot = mkdtempSync(join(tmpdir(), "nautilo-d488-owner-audit-"));
    auditLogPath = join(auditRoot, "security-audit.log");
    fx = await setupOwnerAppFixture({
      // setupOwnerAppFixture derives an agent handle from the first twelve
      // normalized suite-name characters. Keep entropy inside that prefix so
      // an interrupted prior run cannot permanently wedge this integration.
      suiteName: `d488owner${randomBytes(3).toString("hex")}`,
      createAppExtras: { securityAuditLogPath: auditLogPath },
    });
    fixtureReady = true;

    // Revert the ordinary fixture owner to the fresh-server bootstrap shape:
    // the same users/actors/group membership now get re-targeted in place by
    // the real claim path, exactly as a newly booted server does.
    await fx.db.delete(profiles).where(eq(profiles.userId, fx.ownerId));
    await fx.db.delete(credentials).where(eq(credentials.userId, fx.ownerId));
    await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, fx.ownerId));
    await fx.db.update(users).set({ externalId: null }).where(eq(users.id, fx.ownerId));

    claim = newToken();
    reissuedClaim = newToken();
    expiredClaim = newToken();
    ordinaryInvite = newToken();
    createdHashes.push(sha256(claim), sha256(reissuedClaim), sha256(ordinaryInvite));
    const [members] = await fx.db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, "members"))
      .limit(1);
    if (!members) throw new Error("fixture did not seed the canonical members group");

    await fx.db.insert(invites).values([
      {
        tokenHash: sha256(claim),
        kind: "claim",
        targetGroupId: null,
        targetRoomId: null,
        maxUses: 1,
        usedCount: 0,
        createdBy: null,
        displayName: "Browser owner claim",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        revokedAt: null,
      },
      {
        tokenHash: sha256(ordinaryInvite),
        kind: "server",
        targetGroupId: members.id,
        targetRoomId: null,
        maxUses: 1,
        usedCount: 0,
        createdBy: fx.ownerId,
        displayName: "Legacy compose invite",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        revokedAt: null,
      },
    ]);

    const claimantSub = `d488-owner-${randomBytes(8).toString("hex")}`;
    claimantBearer = await fx.mintBearerForOrphanSub(claimantSub);
    _setLogtoAdminClientForTests({
      getUser: async (sub: string) => ({ id: sub, username: "owner_d488" }),
    } as unknown as LogtoAdminClient);

    baseUrl = (await fx.app.listen({ port: 0, host: "127.0.0.1" })).replace(/\/$/, "");
    originalFetch = globalThis.fetch;
    wire = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = typeof init?.body === "string" ? init.body : null;
      wire.push({ url: requestUrl(input), body });
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    if (originalSessionStorage === undefined) {
      Reflect.deleteProperty(globalThis, "sessionStorage");
    } else {
      Object.defineProperty(globalThis, "sessionStorage", {
        value: originalSessionStorage,
        configurable: true,
      });
    }
    if (fixtureReady) {
      await fx.db.delete(invites).where(inArray(invites.tokenHash, createdHashes));
      await fx.cleanup();
    }
    if (auditRoot !== undefined) rmSync(auditRoot, { recursive: true, force: true });
  });

  test("scrubs/body-posts the hosted claim, recovers lost responses, rejects expiry/replay, and preserves legacy invites", async () => {
    const session = storage();
    Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true });
    const replaceCalls: string[] = [];
    const browser = {
      location: { hash: `#claim=${claim}`, pathname: "/claim", search: "" },
      history: {
        state: null,
        replaceState(_state: unknown, _title: string, url?: string | URL | null) {
          replaceCalls.push(String(url));
        },
      },
    };
    expect(consumeOwnerClaimFragment(browser)).toEqual({ outcome: "stored" });
    expect(replaceCalls).toEqual(["/claim"]);
    const handoff = readOwnerClaimHandoff();
    expect(handoff?.claim).toBe(claim);

    const client = new NautiloApiClient(baseUrl);
    client.setToken(claimantBearer);
    const preview = await client.previewOwnerClaim({ claim: handoff!.claim });
    expect(preview?.kind).toBe("claim");
    expect(preview?.continuation).toBe("new-owner");

    // The old endpoint remains reachable for a rolling old client, but the
    // D508 browser protocol uses the unified prepare-auth contract.
    const legacyOwnerPrepared = await client.prepareOwnerClaimLogtoSignup({
      claim: handoff!.claim,
      handle: "owner_d488",
    });
    expect(legacyOwnerPrepared.handle).toBe("owner_d488");
    const prepared = await client.prepareOwnerClaimAuth({
      claim: handoff!.claim,
      handle: "owner_d488",
    });
    expect(prepared.continuation).toBe("new-owner");
    expect(prepared.handle).toBe("owner_d488");

    const bound = await client.bindLogtoUser({ state: prepared.state });
    // A lost HTTP response retries the same opaque state. The server returns
    // the original reservation, rather than allocating another claimant.
    expect(await client.bindLogtoUser({ state: prepared.state })).toEqual(bound);

    // Controller resume replaces an existing capability while preserving the
    // durable reservation. Model that exact data operation here, then prove
    // the body-only browser contract learns only the bounded continuation and
    // server-resolved handle.
    await fx.db
      .update(invites)
      .set({
        tokenHash: sha256(reissuedClaim),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      })
      .where(eq(invites.tokenHash, sha256(claim)));
    const resumedPreview = await client.previewOwnerClaim({ claim: reissuedClaim });
    expect(resumedPreview?.continuation).toBe("resume-owner");
    const resumed = await client.prepareOwnerClaimAuth({ claim: reissuedClaim });
    expect(resumed).toMatchObject({ continuation: "resume-owner", handle: "owner_d488" });

    const wrongAccount = new NautiloApiClient(baseUrl);
    wrongAccount.setToken(await fx.mintBearerForOrphanSub(`d508-wrong-${randomBytes(8).toString("hex")}`));
    try {
      await wrongAccount.bindLogtoUser({ state: resumed.state });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(409);
      expect((error as ApiError).message).toBe("claim_reserved");
    }
    expect(await client.bindLogtoUser({ state: resumed.state })).toEqual(bound);

    const completed = await client.completeOwnerClaimProfile({
      claim: reissuedClaim,
      displayName: "D488 Owner",
      pin: "847291",
    });
    expect(completed.recoveryCodes.length).toBeGreaterThan(0);

    // `writeSecurityAuditEvent` appends and fsyncs this JSONL file. Scope the
    // physical-record lookup to the newly created actor so shared developer
    // audit history cannot affect this proof. The useful correlation hash is
    // retained, while every plaintext capability/credential remains absent.
    const auditRows = readSecurityAuditLog(auditLogPath, {
      actorId: bound.actorId,
      kinds: ["invite_bind_logto_user_succeeded", "invite_redeemed"],
      limit: 10,
    }).events;
    const bindAudit = auditRows.find((event): event is InviteBindLogtoUserSucceededAuditEvent =>
      isBoundOwnerAudit(event, bound.userId),
    );
    const completeAudit = auditRows.find((event): event is InviteRedeemedAuditEvent =>
      isCompletedOwnerAudit(event, bound.userId),
    );
    expect(bindAudit).toBeDefined();
    expect(completeAudit).toBeDefined();
    for (const event of [bindAudit, completeAudit]) {
      if (!event) throw new Error("expected owner audit event");
      const artifact = JSON.stringify(event);
      // The bind audit is necessarily tied to the pre-reissue capability;
      // completion audit correlation remains a token hash. Both must remain
      // scoped to this browser flow and never contain either raw capability.
      expect([sha256(claim), sha256(reissuedClaim)]).toContain(event.tokenHash);
      expect(artifact).not.toContain(claim);
      expect(artifact).not.toContain(reissuedClaim);
      expect(artifact).not.toContain(claimantBearer);
      expect(artifact).not.toContain("847291");
    }

    // A response can be lost near the short bootstrap TTL. The completed
    // claimant may still recover the idempotent result; a new claimant cannot
    // use the expired capability (covered below through preview/replay).
    await fx.db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(invites.tokenHash, sha256(reissuedClaim)));
    const completionRetry = await client.completeOwnerClaimProfile({
      claim: reissuedClaim,
      displayName: "D488 Owner",
      pin: "847291",
    });
    expect(completionRetry.recoveryCodes).toEqual([]);

    const urls = wire.map((call) => call.url);
    expect(urls).toContain(`${baseUrl}/api/owner-claim/preview`);
    expect(urls).toContain(`${baseUrl}/api/owner-claim/prepare-auth`);
    expect(urls).toContain(`${baseUrl}/api/owner-claim/prepare-logto-signup`);
    expect(urls).toContain(`${baseUrl}/api/owner-claim/complete-profile`);
    expect(urls).toContain(`${baseUrl}/api/bind-logto-user`);
    expect(urls.every((url) => !url.includes(claim))).toBe(true);
    expect(wire.filter((call) => call.url.includes("/owner-claim/")).map((call) => call.body)).toEqual([
      JSON.stringify({ claim }),
      JSON.stringify({ claim, handle: "owner_d488" }),
      JSON.stringify({ claim, handle: "owner_d488" }),
      JSON.stringify({ claim: reissuedClaim }),
      JSON.stringify({ claim: reissuedClaim }),
      JSON.stringify({ claim: reissuedClaim, displayName: "D488 Owner", pin: "847291" }),
      JSON.stringify({ claim: reissuedClaim, displayName: "D488 Owner", pin: "847291" }),
    ]);
    // The database intentionally permits only one unredeemed claim. The
    // live claim was consumed above, so this historical
    // expired row can now prove the precise expiry response independently.
    createdHashes.push(sha256(expiredClaim));
    await fx.db.insert(invites).values({
      tokenHash: sha256(expiredClaim),
      kind: "claim",
      targetGroupId: null,
      targetRoomId: null,
      maxUses: 1,
      usedCount: 0,
      createdBy: null,
      displayName: "Expired browser owner claim",
      expiresAt: new Date(Date.now() - 60_000),
      revokedAt: null,
    });

    try {
      await client.previewOwnerClaim({ claim: expiredClaim });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(410);
      expect((error as ApiError).message).not.toContain(expiredClaim);
    }

    const replayClient = new NautiloApiClient(baseUrl);
    replayClient.setToken(await fx.mintBearerForOrphanSub(`d488-replay-${randomBytes(8).toString("hex")}`));
    const priorState = wire.filter((call) => call.url.endsWith("/api/bind-logto-user")).at(-1)?.body;
    expect(typeof priorState).toBe("string");
    const state = (JSON.parse(priorState as string) as { state: string }).state;
    try {
      await replayClient.bindLogtoUser({ state });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(410);
      expect((error as ApiError).message).not.toContain(claim);
    }

    // Ordinary local/Compose invite compatibility remains path-token based.
    const legacyPreview = await client.previewInvite(ordinaryInvite);
    expect(legacyPreview?.kind).toBe("server");
    const legacyPrepared = await client.prepareLogtoSignup(ordinaryInvite, { handle: "legacy_d488" });
    expect(legacyPrepared.state.length).toBeGreaterThan(0);
    expect(wire.some((call) => call.url === `${baseUrl}/api/invites/${ordinaryInvite}/prepare-logto-signup`)).toBe(true);
  });
});
