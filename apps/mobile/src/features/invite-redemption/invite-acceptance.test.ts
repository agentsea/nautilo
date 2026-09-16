/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { parseDeepLink } from "@/lib/deep-link";

import {
  initialInviteCeremonyState,
  reduceInviteCeremony,
  type CeremonyRef,
  type InviteCeremonyState,
} from "./invite-ceremony";
import { runInviteEnrollment } from "./invite-enrollment";
import {
  clearInviteCallbackLocator,
  clearInviteHandoff,
  inviteHandoffKey,
  loadInviteHandoff,
  saveInviteCallbackLocator,
  saveInviteHandoff,
  type InviteHandoffInput,
  type InviteHandoffStorage,
} from "./invite-handoff";
import { InviteIntake, type InviteRoute } from "./invite-intake";
import { resolveInviteLanding } from "./invite-landing";
import { runInviteProfileCompletion } from "./invite-profile";

const now = 1_000_000;
const serverUrl = "https://invites.example.test";
const firstLink = `${serverUrl}/redeem/inv_first`;
const replacementLink = `${serverUrl}/redeem/inv_replacement`;

class MemorySecureStore implements InviteHandoffStorage {
  readonly values = new Map<string, string>();

  async setItemAsync(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async getItemAsync(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async deleteItemAsync(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function serverIdFromUrl(url: string): string {
  return `srv_${url.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;
}

function handoffInput(
  serverId: string,
  stage: InviteHandoffInput["stage"],
  token = "inv_first",
): InviteHandoffInput {
  const prepared = stage === "external-auth" || stage === "binding";
  return {
    serverId,
    serverUrl,
    inviteToken: token,
    prepareState: prepared ? "opaque-state" : null,
    handle: stage === "preview" ? null : "marina_7",
    stage,
    startedAt: now,
    inviteExpiresAt: null,
  };
}

function intakeWithStore(storage: MemorySecureStore) {
  const routes: InviteRoute[] = [];
  const intake = new InviteIntake({
    now: () => now,
    createCeremonyId: (generation) => `ceremony-${generation}`,
    serverIdForUrl: serverIdFromUrl,
    save: (input) => saveInviteHandoff(input, { storage, now }),
    clear: (serverId) => clearInviteHandoff(serverId, storage),
    saveCallbackLocator: (locator) => saveInviteCallbackLocator(locator, storage),
    clearCallbackLocator: (locator) => clearInviteCallbackLocator(locator, storage),
  });
  return { intake, routes, navigate: (route: InviteRoute) => routes.push(route) };
}

function refFromRoute(route: InviteRoute): CeremonyRef {
  return {
    generation: Number(route.params.generation),
    serverId: route.params.serverId,
    ceremonyId: route.params.ceremonyId,
  };
}

function acceptedRoute(result: Awaited<ReturnType<InviteIntake["acceptParsed"]>>): InviteRoute {
  if (result.kind !== "accepted") throw new Error("expected accepted intake");
  return result.route;
}

describe("native invite acceptance matrix", () => {
  test("restores each persisted handoff stage without reducing bearer or opaque state", async () => {
    const expected: Readonly<Record<InviteHandoffInput["stage"], InviteCeremonyState["kind"]>> = {
      preview: "probing-server",
      "external-auth": "external-auth",
      binding: "binding",
      profile: "profile",
    };
    const serverId = serverIdFromUrl(serverUrl);

    for (const stage of Object.keys(expected) as InviteHandoffInput["stage"][]) {
      const expectedKind = expected[stage];
      const storage = new MemorySecureStore();
      await saveInviteHandoff(handoffInput(serverId, stage), { storage, now });
      const restored = await loadInviteHandoff({ serverId, serverUrl }, { storage, now });
      expect(restored?.stage).toBe(stage);
      const ref: CeremonyRef = { generation: 1, serverId, ceremonyId: `restore-${stage}` };
      const state = stage === "preview"
        ? reduceInviteCeremony(initialInviteCeremonyState, { type: "locator.accepted", ref, serverUrl })
        : reduceInviteCeremony(initialInviteCeremonyState, { type: "handoff.hydrated", ref, serverUrl, stage });
      expect(state.kind).toBe(expectedKind);
      expect(JSON.stringify(state)).not.toContain("inv_first");
      expect(JSON.stringify(state)).not.toContain("opaque-state");
    }
  });

  test("fails closed for expired or corrupt process-restoration bytes", async () => {
    const storage = new MemorySecureStore();
    const serverId = serverIdFromUrl(serverUrl);
    await saveInviteHandoff(handoffInput(serverId, "preview"), { storage, now });
    expect(await loadInviteHandoff({ serverId, serverUrl }, { storage, now: now + 30 * 60 * 1000 })).toBeNull();
    expect(storage.values.size).toBe(0);

    storage.values.set(inviteHandoffKey(serverId)!, "{bad");
    expect(await loadInviteHandoff({ serverId, serverUrl }, { storage, now })).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  test("retains only retryable work, clears explicit cancellation, and permits same-link replay", async () => {
    const storage = new MemorySecureStore();
    const h = intakeWithStore(storage);
    const route = acceptedRoute(await h.intake.acceptParsed(parseDeepLink(firstLink), "manual", h.navigate));
    const ref = refFromRoute(route);
    expect(await h.intake.settle(ref, "retryable-network")).toBe("retained");
    expect(await h.intake.acceptParsed(parseDeepLink(firstLink), "deep-link", h.navigate)).toEqual({ kind: "duplicate" });
    expect(await h.intake.settle(ref, "cancelled")).toBe("cleared");
    expect(storage.values.size).toBe(0);
    expect((await h.intake.acceptParsed(parseDeepLink(firstLink), "deep-link", h.navigate)).kind).toBe("accepted");
  });

  test("a newer invite for the same server fences stale cleanup and preserves the replacement handoff", async () => {
    const storage = new MemorySecureStore();
    const h = intakeWithStore(storage);
    const oldRoute = acceptedRoute(await h.intake.acceptParsed(parseDeepLink(firstLink), "manual", h.navigate));
    const oldRef = refFromRoute(oldRoute);
    const newRoute = acceptedRoute(await h.intake.acceptParsed(parseDeepLink(replacementLink), "deep-link", h.navigate));
    const newRef = refFromRoute(newRoute);

    expect(oldRef.serverId).toBe(newRef.serverId);
    expect(h.intake.ceremonyOwnership(oldRef)).toBe(false);
    expect(await h.intake.settle(oldRef, "cancelled")).toBe("replaced");
    expect((await loadInviteHandoff({ serverId: newRef.serverId, serverUrl }, { storage, now }))?.inviteToken).toBe("inv_replacement");
    expect(h.intake.ceremonyOwnership(newRef)).toBe(true);
  });

  test("runs the one exact-server client spine and lands only in the returned readable Room", async () => {
    const storage = new MemorySecureStore();
    const h = intakeWithStore(storage);
    const route = acceptedRoute(await h.intake.acceptParsed(parseDeepLink(firstLink), "manual", h.navigate));
    const ref = refFromRoute(route);
    const calls: string[] = [];
    let redeemCalls = 0;
    const clientFor = (baseUrl: string) => {
      if (baseUrl !== serverUrl) throw new Error(`cross-server request: ${baseUrl}`);
      return {
        previewInvite: async (token: string) => {
          calls.push(`preview:${baseUrl}:${token}`);
          return { expiresAt: null };
        },
        prepareLogtoSignup: async (token: string, input: { handle: string }) => {
          calls.push(`prepare:${baseUrl}:${token}:${input.handle}`);
          return { state: "opaque-state" };
        },
        bindLogtoUser: async (input: { state: string }) => {
          calls.push(`bind:${baseUrl}:${input.state}`);
        },
        completeInviteProfile: async (token: string, { displayName }: { displayName: string; pin: string }) => {
          calls.push(`complete:${baseUrl}:${token}:${displayName}`);
          return { recoveryCodes: [], landingRoomId: "room-invite" };
        },
        listRooms: async () => {
          calls.push(`rooms:${baseUrl}`);
          return { rooms: [{ id: "room-invite" }] };
        },
        redeemInvite: async () => {
          redeemCalls += 1;
          throw new Error("legacy redeemInvite must never be called");
        },
      };
    };
    const current = (candidate: CeremonyRef) => h.intake.ceremonyOwnership(candidate) === true;
    const loaded = await loadInviteHandoff({ serverId: ref.serverId, serverUrl }, { storage, now });
    if (!loaded) throw new Error("expected preview handoff");
    await clientFor(serverUrl).previewInvite(loaded.inviteToken);

    const enrollment = await runInviteEnrollment({ ref, serverUrl, start: "prepare", handle: "marina_7" }, {
      isCurrent: current,
      loadHandoff: (server) => loadInviteHandoff(server, { storage, now }),
      saveHandoff: (input) => saveInviteHandoff(input, { storage, now }),
      prepare: (token, input) => clientFor(serverUrl).prepareLogtoSignup(token, input),
      authenticate: async ({ serverUrl: exactServerUrl, handle }) => {
        clientFor(exactServerUrl);
        calls.push(`authenticate:${exactServerUrl}:${handle}`);
        return "completed";
      },
      bind: (input) => clientFor(serverUrl).bindLogtoUser(input),
      onPrepared: () => undefined,
      onAuthenticated: () => undefined,
    });
    expect(enrollment).toEqual({ kind: "bound" });

    const profile = await runInviteProfileCompletion({
      ref,
      serverUrl,
      displayName: "Marina",
      pin: "123456",
    }, {
      isCurrent: current,
      loadHandoff: (server) => loadInviteHandoff(server, { storage, now }),
      complete: (token, input) => clientFor(serverUrl).completeInviteProfile(token, input),
    });
    expect(profile).toEqual({ kind: "completed", recoveryCodes: [], landingRoomId: "room-invite" });
    expect(await h.intake.settle(ref, "success")).toBe("cleared");
    expect(storage.values.size).toBe(0);

    const landing = await resolveInviteLanding({ ceremonyServerId: ref.serverId, landingRoomId: "room-invite" }, {
      getActiveServer: () => ({ id: ref.serverId, serverUrl }),
      refreshViewer: async () => {
        calls.push(`viewer:${serverUrl}`);
        return true;
      },
      listRooms: () => clientFor(serverUrl).listRooms(),
    });

    expect(landing).toEqual({ kind: "room", roomId: "room-invite" });
    expect(calls).toEqual([
      "preview:https://invites.example.test:inv_first",
      "prepare:https://invites.example.test:inv_first:marina_7",
      "authenticate:https://invites.example.test:marina_7",
      "bind:https://invites.example.test:opaque-state",
      "complete:https://invites.example.test:inv_first:Marina",
      "viewer:https://invites.example.test",
      "rooms:https://invites.example.test",
    ]);
    expect(redeemCalls).toBe(0);
  });
});
