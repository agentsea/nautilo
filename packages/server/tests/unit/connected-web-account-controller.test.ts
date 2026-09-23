import { expect, test } from "bun:test";
import type { ConnectedWebAccount } from "@nautilo/types";
import { ConnectedWebAccountController } from "../../src/connected-web-accounts/controller";
import type { BrowserUseCloudAdapter } from "../../src/browser-use/browser-use-cloud";
import type { ConnectedWebAccountStore } from "../../src/connected-web-accounts/store";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-09-01T12:00:00.000Z";

test("D568 projects only actionable Browser Use setup readiness", () => {
  const statusFor = (reason?: "missing_configuration" | "invalid_configuration") => {
    const browser = {
      health: () => reason
        ? { kind: "unavailable" as const, reason }
        : { kind: "available" as const, verification: "not_checked" as const },
    } as unknown as BrowserUseCloudAdapter;
    return new ConnectedWebAccountController({
      store: {} as ConnectedWebAccountStore,
      browser,
      navigator: { async navigate() {}, async verifySignIn() { return { atExpectedOrigin: true, authenticationRequired: false }; } },
    }).providerSetupStatus();
  };

  expect(statusFor()).toBe("ready");
  expect(statusFor("missing_configuration")).toBe("api_key_required");
  expect(statusFor("invalid_configuration")).toBe("api_key_invalid");
});

test("D568 reserves before starting a browser, activates before navigation, and returns the bearer once", async () => {
  const events: string[] = [];
  const account = {
    id: accountId, service: "Example", origin: "https://example.com", label: "Example",
    status: "connecting" as const, lastVerifiedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  const store = {
    async createPending() { events.push("pending"); return account; },
    async bindProfileReference() { events.push("bind"); },
    async getBindingForOwner() { return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: null }; },
    async reserveExecutionCheckpoint() { events.push("reserve"); },
    async activateExecutionCheckpoint() { events.push("activate"); },
    async getForOwner() { return account; },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async createProfile() { events.push("profile"); return { profileId: "profile" }; },
    async startBrowser() { events.push("start"); return {
      browserId: "browser", liveViewUrl: "https://live.browser-use.com/session", cdpUrl: "https://11111111-1111-4111-8111-111111111111.cdp.browser-use.com",
      timeoutAt: new Date("2026-09-01T16:00:00.000Z"), observedAt: new Date(timestamp), status: "active" as const,
    }; },
    async stopBrowser() { events.push("stop"); return { kind: "failure" as const, code: "resource_not_found" as const }; },
  } as unknown as BrowserUseCloudAdapter;
  const controller = new ConnectedWebAccountController({
    store,
    browser,
    navigator: {
      async navigate(input) { events.push(`navigate:${input.targetUrl}`); },
      async verifySignIn() { return { atExpectedOrigin: true, authenticationRequired: false }; },
    },
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    now: () => new Date(timestamp),
    assertServerFunding: async () => undefined,
  });
  const result = await controller.create({ ownerUserId, account: { service: "Example", origin: "https://example.com/login", label: "Example", createAnother: true } });
  expect(events).toEqual(["pending", "profile", "bind", "reserve", "start", "activate", "navigate:https://example.com/login"]);
  expect(result).toEqual({ account, login: { liveViewUrl: "https://live.browser-use.com/session", expiresAt: "2026-09-01T16:00:00.000Z" }, createdNewAccount: true });
});

test("server-funding denial creates no account, profile, or browser reservation", async () => {
  const events: string[] = [];
  const store = {
    async createPending() { events.push("pending"); return connectedAccount("connecting"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async createProfile() { events.push("profile"); return { profileId: "profile" }; },
    async startBrowser() { events.push("start"); return browserSession(); },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({
    store,
    browser,
    events,
    assertServerFunding: async () => { throw new Error("server_provider_credentials_required"); },
  });

  const error = await controller.create({ ownerUserId, account: createRequest() }).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ kind: "server_funding_required" });
  expect(events).toEqual([]);
});

test("reconnect and open-page denial preserve existing state before paid browser start", async () => {
  for (const operation of ["reconnect", "openPage"] as const) {
    const events: string[] = [];
    const account = connectedAccount("connected");
    const store = {
      async getBindingForOwner() { events.push("binding"); return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: null }; },
      async getForOwner() { events.push("get"); return account; },
      async beginReconnect() { events.push("begin"); return { ...account, status: "connecting" as const }; },
      async reserveExecutionCheckpoint() { events.push("reserve"); },
    } as unknown as ConnectedWebAccountStore;
    const browser = {
      async startBrowser() { events.push("start"); return browserSession(); },
    } as unknown as BrowserUseCloudAdapter;
    const controller = controllerFor({
      store,
      browser,
      events,
      assertServerFunding: async () => { throw new Error("server_provider_credentials_required"); },
    });

    const error = await controller[operation]({ ownerUserId, accountId }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ kind: "server_funding_required" });
    expect(events).toEqual(operation === "reconnect" ? ["binding"] : ["binding", "get"]);
  }
});

test("D568 reuses the canonical account unless the Human explicitly connects another", async () => {
  const events: string[] = [];
  const account = connectedAccount("connecting");
  const store = {
    async listForOwner() { events.push("list"); return [account]; },
    async getBindingForOwner() {
      events.push("binding");
      return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: loginCheckpoint("active", "browser") };
    },
    async getForOwner() { events.push("get"); return account; },
    async createPending() { events.push("pending"); return account; },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async getBrowser() { events.push("get-browser"); return browserSession(); },
    async createProfile() { events.push("profile"); return { profileId: "new-profile" }; },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  const result = await controller.create({
    ownerUserId,
    account: { service: "Example", origin: "https://example.com/login", label: "Example", createAnother: false },
  });

  expect(result.createdNewAccount).toBe(false);
  expect(events).toEqual(["list", "binding", "get-browser", "get"]);
  expect(events).not.toContain("pending");
  expect(events).not.toContain("profile");
});

test("D568 preserves the active login checkpoint when navigation and its stop both fail", async () => {
  const events: string[] = [];
  const account = connectedAccount("connecting");
  const activeCheckpoint = loginCheckpoint("active", "browser");
  const store = {
    async createPending() { events.push("pending"); return account; },
    async bindProfileReference() { events.push("bind"); },
    async getBindingForOwner() {
      events.push("binding");
      return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: events.filter((event) => event === "binding").length === 1 ? null : activeCheckpoint };
    },
    async reserveExecutionCheckpoint() { events.push("reserve"); },
    async activateExecutionCheckpoint() { events.push("activate"); },
    async revokeForOwner() { events.push("revoke"); },
    async markProviderCleanupCompleted() { events.push("cleanup-complete"); },
    async markProviderCleanupFailed() { events.push("cleanup-failed"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async createProfile() { events.push("profile"); return { profileId: "profile" }; },
    async startBrowser() { events.push("start"); return browserSession(); },
    async stopBrowser() { events.push("stop"); return { kind: "failure" as const, code: "provider_unavailable" as const }; },
    async deleteProfile() { events.push("delete-profile"); },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({
    store,
    browser,
    events,
    navigate: async () => { events.push("navigate"); throw new Error("navigation failed"); },
  });

  const error = await controller.create({ ownerUserId, account: createRequest() }).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ message: "navigation failed" });
  expect(events).toEqual(["pending", "profile", "bind", "binding", "reserve", "start", "activate", "navigate", "stop", "binding"]);
  expect(events).not.toContain("revoke");
  expect(events).not.toContain("delete-profile");
});

test("D568 stops a newly-created browser when checkpoint activation fails", async () => {
  const events: string[] = [];
  const account = connectedAccount("connecting");
  const store = {
    async createPending() { events.push("pending"); return account; },
    async bindProfileReference() { events.push("bind"); },
    async getBindingForOwner() { events.push("binding"); return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: loginCheckpoint("reserving") }; },
    async reserveExecutionCheckpoint() { events.push("reserve"); },
    async activateExecutionCheckpoint() { events.push("activate"); throw new Error("activation failed"); },
    async releaseExecutionReservation() { events.push("release"); },
    async revokeForOwner() { events.push("revoke"); return account; },
    async markProviderCleanupCompleted() { events.push("cleanup-complete"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async createProfile() { events.push("profile"); return { profileId: "profile" }; },
    async startBrowser() { events.push("start"); return browserSession(); },
    async stopBrowser(id: string) { events.push(`stop:${id}`); },
    async deleteProfile() { events.push("delete-profile"); },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  const error = await controller.create({ ownerUserId, account: createRequest() }).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ message: "activation failed" });
  expect(events).toContain("stop:browser");
  expect(events.indexOf("activate")).toBeLessThan(events.indexOf("stop:browser"));
  expect(events.indexOf("stop:browser")).toBeLessThan(events.indexOf("release"));
});

test("D568 preserves the reservation when activation and browser stop both fail", async () => {
  const events: string[] = [];
  const account = connectedAccount("connecting");
  const store = {
    async createPending() { events.push("pending"); return account; },
    async bindProfileReference() { events.push("bind"); },
    async getBindingForOwner() { events.push("binding"); return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: loginCheckpoint("reserving") }; },
    async reserveExecutionCheckpoint() { events.push("reserve"); },
    async activateExecutionCheckpoint() { events.push("activate"); throw new Error("activation failed"); },
    async releaseExecutionReservation() { events.push("release"); },
    async revokeForOwner() { events.push("revoke"); return account; },
    async markProviderCleanupCompleted() { events.push("cleanup-complete"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async createProfile() { events.push("profile"); return { profileId: "profile" }; },
    async startBrowser() { events.push("start"); return browserSession(); },
    async stopBrowser() { events.push("stop"); return { kind: "failure" as const, code: "provider_unavailable" as const }; },
    async deleteProfile() { events.push("delete-profile"); },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  const error = await controller.create({ ownerUserId, account: createRequest() }).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ message: "activation failed" });
  expect(events).toEqual(["pending", "profile", "bind", "binding", "reserve", "start", "activate", "stop", "binding"]);
  expect(events).not.toContain("release");
  expect(events).not.toContain("revoke");
  expect(events).not.toContain("delete-profile");
});

test("D568 does not cancel or disconnect through an in-flight browser reservation", async () => {
  const events: string[] = [];
  const account = connectedAccount("connecting");
  const store = {
    async getBindingForOwner() {
      events.push("binding");
      return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: loginCheckpoint("reserving") };
    },
    async reconcileStaleExecution() { events.push("reconcile"); },
    async revokeForOwner() { events.push("revoke"); return account; },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async stopBrowser() { events.push("stop"); },
    async deleteProfile() { events.push("delete-profile"); },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  const cancelError = await controller.cancelLogin({ ownerUserId, accountId }).catch((cause: unknown) => cause);
  const disconnectError = await controller.disconnect({ ownerUserId, accountId }).catch((cause: unknown) => cause);

  expect(cancelError).toMatchObject({ kind: "conflict" });
  expect(disconnectError).toMatchObject({ kind: "conflict" });
  expect(events).toEqual(["binding", "binding"]);
});

test("D568 does not revoke an account when profile deletion fails", async () => {
  const events: string[] = [];
  const account = connectedAccount("connected");
  const store = {
    async getBindingForOwner() { events.push("binding"); return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: null }; },
    async revokeForOwner() { events.push("revoke"); return account; },
    async markProviderCleanupCompleted() { events.push("cleanup-complete"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async deleteProfile() { events.push("delete-profile"); return { kind: "failure" as const, code: "provider_unavailable" as const }; },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  const error = await controller.disconnect({ ownerUserId, accountId }).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ kind: "provider_unavailable" });
  expect(events).toEqual(["binding", "delete-profile"]);
});

test("D568 keeps an active account visible when its browser cannot be stopped for disconnect", async () => {
  const events: string[] = [];
  const account = connectedAccount("connecting");
  const store = {
    async getBindingForOwner() { events.push("binding"); return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: loginCheckpoint("active", "browser") }; },
    async revokeForOwner() { events.push("revoke"); return account; },
    async markProviderCleanupCompleted() { events.push("cleanup-complete"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async stopBrowser() { events.push("stop"); return { kind: "failure" as const, code: "provider_unavailable" as const }; },
    async deleteProfile() { events.push("delete-profile"); },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  const error = await controller.disconnect({ ownerUserId, accountId }).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ kind: "provider_unavailable" });
  expect(events).toEqual(["binding", "stop"]);
});

test("D568 disconnects in stop, delete-profile, revoke, cleanup-complete order", async () => {
  const events: string[] = [];
  const account = connectedAccount("connecting");
  const store = {
    async getBindingForOwner() { events.push("binding"); return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: loginCheckpoint("active", "browser") }; },
    async revokeForOwner() { events.push("revoke"); return { ...account, status: "revoked" as const }; },
    async markProviderCleanupCompleted() { events.push("cleanup-complete"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async stopBrowser() { events.push("stop"); },
    async deleteProfile() { events.push("delete-profile"); },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  await controller.disconnect({ ownerUserId, accountId });
  expect(events).toEqual(["binding", "stop", "delete-profile", "revoke", "cleanup-complete"]);
});

test("D568 opens a private page from the saved profile at its durable origin", async () => {
  const events: string[] = [];
  const account = connectedAccount("connected");
  const store = {
    async getBindingForOwner() { events.push("binding"); return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: null }; },
    async getForOwner() { events.push("get"); return account; },
    async reserveExecutionCheckpoint(input: { checkpoint: { resource: string } }) { events.push(`reserve:${input.checkpoint.resource}`); },
    async activateExecutionCheckpoint() { events.push("activate"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async startBrowser(input: { profileId: string }) { events.push(`start:${input.profileId}`); return browserSession(); },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({
    store,
    browser,
    events,
    navigate: async (input) => { events.push(`navigate:${input.targetUrl}`); },
  });

  const result = await controller.openPage({ ownerUserId, accountId });

  expect(events).toEqual(["binding", "get", "reserve:view", "start:profile", "activate", "navigate:https://example.com", "get"]);
  expect(result).toEqual({
    account,
    login: { liveViewUrl: "https://live.browser-use.com/session", expiresAt: "2026-09-01T16:00:00.000Z" },
    createdNewAccount: false,
  });
});

test("D568 closes only an active private page and restores connected", async () => {
  const events: string[] = [];
  const account = connectedAccount("busy");
  const store = {
    async getBindingForOwner() { events.push("binding"); return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: viewCheckpoint("active", "browser") }; },
    async completeExecution(input: { status: string }) { events.push(`complete:${input.status}`); return { ...account, status: "connected" as const }; },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async stopBrowser(id: string) { events.push(`stop:${id}`); },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  const result = await controller.closePage({ ownerUserId, accountId });

  expect(events).toEqual(["binding", "stop:browser", "complete:connected"]);
  expect(result.status).toBe("connected");
});

test("D568 projects an active read as coarse activity, owner-only live watch, and an explicit stop", async () => {
  const events: string[] = [];
  const account = connectedAccount("busy");
  const checkpoint = readCheckpoint("active", "run-private-id");
  const store = {
    async getBindingForOwner() { events.push("binding"); return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: checkpoint }; },
    async completeExecution(input: { status: string }) { events.push(`complete:${input.status}`); return { ...account, status: "connected" as const }; },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async observeHostedReadRun(runId: string) {
      events.push(`observe:${runId}`);
      return { runId, status: "running" as const, stage: "browsing" as const, liveViewUrl: "https://live.browser-use.com/?opaque", observedAt: new Date(timestamp) };
    },
    async cancelHostedReadRun(runId: string) { events.push(`cancel:${runId}`); return { runId, status: "cancelled" as const, observedAt: new Date(timestamp) }; },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  expect(await controller.readActivity({ ownerUserId, accountId })).toEqual({ accountId, stage: "browsing", canWatch: true });
  expect(await controller.watchRead({ ownerUserId, accountId })).toEqual({ liveViewUrl: "https://live.browser-use.com/?opaque" });
  expect((await controller.cancelRead({ ownerUserId, accountId })).status).toBe("connected");
  expect(events).toEqual([
    "binding", "observe:run-private-id",
    "binding", "observe:run-private-id",
    "binding", "cancel:run-private-id", "complete:connected",
  ]);
});

test("D568 exposes only a starting state while a read reservation has no provider run", async () => {
  const account = connectedAccount("busy");
  const store = {
    async getBindingForOwner() { return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: readCheckpoint("reserving") }; },
  } as unknown as ConnectedWebAccountStore;
  const controller = controllerFor({ store, browser: {} as BrowserUseCloudAdapter, events: [] });

  expect(await controller.readActivity({ ownerUserId, accountId })).toEqual({ accountId, stage: "starting", canWatch: false });
  expect(await controller.watchRead({ ownerUserId, accountId }).catch((cause: unknown) => cause)).toMatchObject({ kind: "conflict" });
  expect(await controller.cancelRead({ ownerUserId, accountId }).catch((cause: unknown) => cause)).toMatchObject({ kind: "conflict" });
});

test("D568 never finishes a private page as a completed login", async () => {
  const account = connectedAccount("busy");
  const store = {
    async getBindingForOwner() { return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: viewCheckpoint("active", "browser") }; },
  } as unknown as ConnectedWebAccountStore;
  const controller = controllerFor({ store, browser: {} as BrowserUseCloudAdapter, events: [] });

  const error = await controller.finish({ ownerUserId, accountId }).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ kind: "conflict" });
});

test("D568 keeps the protected login open when Done is pressed on an authentication surface", async () => {
  const events: string[] = [];
  const account = connectedAccount("connecting");
  const store = {
    async getBindingForOwner() {
      events.push("binding");
      return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: loginCheckpoint("active", "browser") };
    },
    async completeExecution() { events.push("complete"); return connectedAccount("connected"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async getBrowser() { events.push("get-browser"); return browserSession(); },
    async stopBrowser() { events.push("stop"); },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({
    store,
    browser,
    events,
    verifySignIn: async () => {
      events.push("verify");
      return { atExpectedOrigin: true, authenticationRequired: true };
    },
  });

  const error = await controller.finish({ ownerUserId, accountId }).catch((cause: unknown) => cause);

  expect(error).toMatchObject({ kind: "authentication_incomplete" });
  expect(events).toEqual(["binding", "get-browser", "verify"]);
  expect(events).not.toContain("stop");
  expect(events).not.toContain("complete");
});

test("D568 keeps the protected login open while an OAuth page is still visible", async () => {
  const events: string[] = [];
  const account = connectedAccount("connecting");
  const store = {
    async getBindingForOwner() {
      events.push("binding");
      return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: loginCheckpoint("active", "browser") };
    },
    async completeExecution() { events.push("complete"); return connectedAccount("connected"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async getBrowser() { events.push("get-browser"); return browserSession(); },
    async stopBrowser() { events.push("stop"); },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({
    store,
    browser,
    events,
    verifySignIn: async () => ({ atExpectedOrigin: false, authenticationRequired: true }),
  });

  const error = await controller.finish({ ownerUserId, accountId }).catch((cause: unknown) => cause);

  expect(error).toMatchObject({ kind: "authentication_incomplete" });
  expect(events).toEqual(["binding", "get-browser"]);
});

test("D568 stops and publishes a login only after the visible page passes sign-in verification", async () => {
  const events: string[] = [];
  const account = connectedAccount("connecting");
  const connected = { ...connectedAccount("connected"), lastVerifiedAt: timestamp };
  const store = {
    async getBindingForOwner() {
      events.push("binding");
      return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: loginCheckpoint("active", "browser") };
    },
    async completeExecution(input: { status: string; lastVerifiedAt?: Date }) {
      events.push(`complete:${input.status}:${input.lastVerifiedAt?.toISOString()}`);
      return connected;
    },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async getBrowser() { events.push("get-browser"); return browserSession(); },
    async stopBrowser() { events.push("stop"); },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({
    store,
    browser,
    events,
    verifySignIn: async () => {
      events.push("verify");
      return { atExpectedOrigin: true, authenticationRequired: false };
    },
  });

  expect(await controller.finish({ ownerUserId, accountId })).toEqual(connected);
  expect(events).toEqual(["binding", "get-browser", "verify", "stop", `complete:connected:${timestamp}`]);
});

test("D568 recovery stops a private page and restores connected", async () => {
  const events: string[] = [];
  const store = {
    async listStaleExecutions() { return [{ accountId, ownerUserId, checkpoint: viewCheckpoint("active", "browser") }]; },
    async completeExecution(input: { status: string }) { events.push(`complete:${input.status}`); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async stopBrowser(id: string) { events.push(`stop:${id}`); },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  await controller.reconcileStaleExecutions();

  expect(events).toEqual(["stop:browser", "complete:connected"]);
});

test("D568 recovery leaves an async read to its durable operation supervisor", async () => {
  const events: string[] = [];
  const store = {
    async listStaleExecutions() { return [{ accountId, ownerUserId, checkpoint: readCheckpoint("active", "run-private-id") }]; },
    async hasNonterminalReadOperation() { events.push("operation:active"); return true; },
    async completeExecution() { events.push("complete"); return connectedAccount("connected"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async cancelHostedReadRun() { events.push("cancel"); return { runId: "run-private-id", status: "cancelled" as const }; },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  await controller.reconcileStaleExecutions();

  expect(events).toEqual(["operation:active"]);
});

test("D568 boot preserves a synchronous read reservation with an uncertain provider create", async () => {
  const events: string[] = [];
  const store = {
    async listStaleExecutions() { return [{ accountId, ownerUserId, checkpoint: readCheckpoint("reserving") }]; },
    async hasNonterminalReadOperation() { return false; },
    async reconcileStaleExecution() { events.push("released"); },
    async completeExecution() { events.push("completed"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async cancelHostedReadRun() { events.push("cancel-without-id"); },
  } as unknown as BrowserUseCloudAdapter;

  await controllerFor({ store, browser, events }).reconcileStaleExecutions();

  expect(events).toEqual([]);
});

test("D568 disconnect stops a private page instead of cancelling it as a hosted read", async () => {
  const events: string[] = [];
  const account = connectedAccount("busy");
  const store = {
    async getBindingForOwner() { events.push("binding"); return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: viewCheckpoint("active", "browser") }; },
    async revokeForOwner() { events.push("revoke"); return { ...account, status: "revoked" as const }; },
    async markProviderCleanupCompleted() { events.push("cleanup-complete"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async stopBrowser(id: string) { events.push(`stop:${id}`); },
    async deleteProfile(id: string) { events.push(`delete-profile:${id}`); },
    async cancelHostedReadRun() { events.push("cancel-read"); },
  } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  await controller.disconnect({ ownerUserId, accountId });

  expect(events).toEqual(["binding", "stop:browser", "delete-profile:profile", "revoke", "cleanup-complete"]);
});

test("D568 action Stop is exact and a provider 404 remains ambiguous", async () => {
  const events: string[] = [];
  const account = connectedAccount("busy");
  const operation = { id: "operation", ownerUserId, accountId, deliveryId: "tool-call", requestDigest: "a".repeat(64), actionType: "save_item" as const, target: "Report", status: "running" as const, opaqueRunRef: "run-a", receipt: null };
  const store = {
    async getActionOperationForOwnerDelivery(input: { ownerUserId: string; deliveryId: string }) { events.push(`operation:${input.ownerUserId}:${input.deliveryId}`); return operation; },
    async getBindingForOwner() { events.push("binding"); return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: { resource: "action" as const, phase: "active" as const, reservationToken: "reservation", recordedAt: timestamp, opaqueExecutionRef: "run-a" } }; },
    async finishActionOperation(input: { status: string; receipt: { evidenceCode: string } }) { events.push(`receipt:${input.status}:${input.receipt.evidenceCode}`); },
    async completeExecution() { events.push("release"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = { async cancelHostedReadRun(runId: string) { events.push(`cancel:${runId}`); return { kind: "failure" as const, code: "resource_not_found" as const }; } } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  expect(await controller.stopAction({ ownerUserId, deliveryId: "tool-call" })).toEqual({ deliveryId: "tool-call", accountId, action: "save_item", stage: "finishing", canWatch: false, canStop: false, terminal: "ambiguous" });
  expect(events).toEqual([`operation:${ownerUserId}:tool-call`, "binding", "cancel:run-a"]);
});

test("D568 exact action cancellation stays fenced for runtime-owned verifier cleanup", async () => {
  const events: string[] = [];
  const account = connectedAccount("busy");
  const operation = { id: "operation", ownerUserId, accountId, deliveryId: "tool-call", requestDigest: "a".repeat(64), actionType: "save_item" as const, target: "Report", status: "running" as const, opaqueRunRef: "run-a", receipt: null };
  const store = {
    async getActionOperationForOwnerDelivery() { return operation; },
    async getBindingForOwner() { return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: { resource: "action" as const, phase: "active" as const, reservationToken: "reservation", recordedAt: timestamp, opaqueExecutionRef: "run-a" } }; },
    async finishActionOperation() { events.push("receipt"); },
    async completeExecution() { events.push("release"); },
  } as unknown as ConnectedWebAccountStore;
  const browser = { async cancelHostedReadRun(runId: string) { events.push(`cancel:${runId}`); return { runId, status: "cancelled" as const }; } } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  expect(await controller.stopAction({ ownerUserId, deliveryId: "tool-call" })).toMatchObject({ terminal: "ambiguous" });
  expect(events).toEqual(["cancel:run-a"]);
});

test("D568 stopping a verifier is ambiguous, never a claimed cancelled website action", async () => {
  const events: string[] = [];
  const account = connectedAccount("busy");
  const operation = { id: "operation", ownerUserId, accountId, deliveryId: "tool-call", requestDigest: "a".repeat(64), actionType: "save_item" as const, target: "Report", status: "verifying" as const, opaqueRunRef: "run-b", receipt: null };
  const store = {
    async getActionOperationForOwnerDelivery() { return operation; },
    async getBindingForOwner() { return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: { resource: "action" as const, phase: "active" as const, reservationToken: "reservation", recordedAt: timestamp, opaqueExecutionRef: "run-b" } }; },
    async finishActionOperation(input: { status: string; expectedOpaqueRunRef: string; receipt: { evidenceCode: string } }) { events.push(`receipt:${input.status}:${input.expectedOpaqueRunRef}:${input.receipt.evidenceCode}`); },
    async completeExecution(input: { expectedOpaqueExecutionRef: string }) { events.push(`release:${input.expectedOpaqueExecutionRef}`); },
  } as unknown as ConnectedWebAccountStore;
  const browser = { async cancelHostedReadRun(runId: string) { events.push(`cancel:${runId}`); return { runId, status: "cancelled" as const }; } } as unknown as BrowserUseCloudAdapter;
  const controller = controllerFor({ store, browser, events });

  expect(await controller.stopAction({ ownerUserId, deliveryId: "tool-call" })).toMatchObject({ terminal: "ambiguous" });
  expect(events).toEqual(["cancel:run-b", "receipt:ambiguous:run-b:owner_stopped_verifier", "release:run-b"]);
});

function connectedAccount(status: ConnectedWebAccount["status"]): ConnectedWebAccount {
  return { id: accountId, service: "Example", origin: "https://example.com", label: "Example", status, lastVerifiedAt: null, createdAt: timestamp, updatedAt: timestamp };
}

function createRequest() {
  return { service: "Example", origin: "https://example.com/login", label: "Example", createAnother: true };
}

function browserSession() {
  return {
    browserId: "browser", liveViewUrl: "https://live.browser-use.com/session", cdpUrl: "https://11111111-1111-4111-8111-111111111111.cdp.browser-use.com",
    timeoutAt: new Date("2026-09-01T16:00:00.000Z"), observedAt: new Date(timestamp), status: "active" as const,
  };
}

function loginCheckpoint(phase: "reserving" | "active", opaqueExecutionRef: string | null = null) {
  return { resource: "login" as const, phase, reservationToken: "reservation", recordedAt: timestamp, opaqueExecutionRef };
}

function viewCheckpoint(phase: "reserving" | "active", opaqueExecutionRef: string | null = null) {
  return { resource: "view" as const, phase, reservationToken: "reservation", recordedAt: timestamp, opaqueExecutionRef };
}

function readCheckpoint(phase: "reserving" | "active", opaqueExecutionRef: string | null = null) {
  return { resource: "read" as const, phase, reservationToken: "reservation", recordedAt: timestamp, opaqueExecutionRef };
}

function controllerFor(input: {
  readonly store: ConnectedWebAccountStore;
  readonly browser: BrowserUseCloudAdapter;
  readonly events: string[];
  readonly navigate?: (input: { readonly cdpUrl: string; readonly targetUrl: string; readonly timeoutMs: number }) => Promise<void>;
  readonly verifySignIn?: (input: { readonly cdpUrl: string; readonly origin: string; readonly timeoutMs: number }) => Promise<{
    readonly atExpectedOrigin: boolean;
    readonly authenticationRequired: boolean;
  }>;
  readonly assertServerFunding?: (humanUserId: string, origin?: string) => Promise<void>;
}): ConnectedWebAccountController {
  return new ConnectedWebAccountController({
    store: input.store,
    browser: Object.assign({ stopHostedReadBrowser: async () => true }, input.browser),
    navigator: {
      async navigate(navigation) { await input.navigate?.(navigation); },
      async verifySignIn(verification) {
        return input.verifySignIn?.(verification)
          ?? { atExpectedOrigin: true, authenticationRequired: false };
      },
    },
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    now: () => new Date(timestamp),
    assertServerFunding: input.assertServerFunding ?? (async () => undefined),
  });
}

test("disconnect stops stranded direct control before hosted cleanup and profile deletion, retaining the account on uncertainty", async () => {
  for (const recovered of [false, true]) {
    const events: string[] = [];
    const account = connectedAccount("busy");
    const store = {
      async getBindingForOwner() { return { ...account, ownerUserId, profileRef: "profile", executionCheckpoint: { ...loginCheckpoint("active", "run"), resource: "read" } }; },
      async revokeForOwner() { events.push("revoke"); return account; },
      async markProviderCleanupCompleted() { events.push("complete"); },
    } as unknown as ConnectedWebAccountStore;
    const browser = {
      async cancelHostedReadRun() { events.push("cancel"); return { runId: "run", status: "cancelled" }; },
      async stopHostedReadBrowser() { events.push("stop-hosted"); return true; },
      async deleteProfile() { events.push("delete"); return {}; },
    } as unknown as BrowserUseCloudAdapter;
    const controller = new ConnectedWebAccountController({
      store, browser, navigator: {} as never,
      stopDirectOperations: async (input) => { expect(input).toEqual({ ownerUserId, accountId }); events.push("stop-direct"); return recovered; },
    });
    const result = await controller.disconnect({ ownerUserId, accountId }).catch((error: unknown) => error);
    if (!recovered) expect(result).toMatchObject({ kind: "provider_unavailable" });
    expect(events).toEqual(recovered ? ["stop-direct", "cancel", "stop-hosted", "delete", "revoke", "complete"] : ["stop-direct"]);
  }
});
