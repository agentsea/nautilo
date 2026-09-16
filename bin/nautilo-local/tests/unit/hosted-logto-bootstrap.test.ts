import { describe, expect, test } from "bun:test";

import {
  createHostedHandoffServer,
  HostedLogtoBootstrapInputError,
  hostedOutput,
  reconcileHostedLogto,
} from "../../src/hosted-logto-bootstrap";
import {
  computeOidcUriRebindPatch,
  deriveManagedWorkbenchOriginUris,
  normalizeManagedWorkbenchOriginReplacement,
  selectManagedWorkbenchApplication,
  type BootstrapOptions,
  type LogtoConfig,
} from "../../src/bootstrap-logto";

const config: LogtoConfig = {
  endpoint: "https://identity.example.test",
  workbenchAppId: "workbench-id",
  tuiAppId: "tui-id",
  tuiLoopbackAppId: "tui-loopback-id",
  desktopAppId: "desktop-id",
  mobileAppId: "mobile-id",
  mobileWebAppId: "mobile-web-id",
  m2mAppId: "m2m-id",
  m2mAppSecret: "never-log-m2m-secret",
  resource: "https://nautilo.example.test/api",
};

const environment = {
  PORT: "8080",
  NAUTILO_BOOTSTRAP_HANDOFF_TOKEN: "never-log-handoff-token",
  LOGTO_ENDPOINT_INTERNAL: "http://logto.railway.internal:4301",
  LOGTO_ADMIN_ENDPOINT_INTERNAL: "http://logto.railway.internal:4302",
  LOGTO_POSTGRES_URL: "postgres://logto:secret@logto-postgres.railway.internal:5432/logto_nautilo",
  LOGTO_RESOURCE: "https://nautilo.example.test/api",
  NAUTILO_WORKBENCH_REDIRECT_URI: "https://nautilo.example.test/auth/callback",
  NAUTILO_PUBLIC_BASE_URL: "https://nautilo.example.test",
} as const;

describe("hosted Logto bootstrap handoff", () => {
  test("maps only the exact runtime outputs consumed by the Railway driver", () => {
    expect(hostedOutput(config)).toEqual({
      "logto-workbench-app-id": "workbench-id",
      "logto-tui-app-id": "tui-id",
      "logto-tui-loopback-app-id": "tui-loopback-id",
      "logto-desktop-app-id": "desktop-id",
      "logto-mobile-app-id": "mobile-id",
      "logto-mobile-web-app-id": "mobile-web-id",
      "logto-m2m-app-id": "m2m-id",
      "logto-m2m-app-secret": "never-log-m2m-secret",
      "logto-resource": "https://nautilo.example.test/api",
    });
  });

  test("passes internal/public Railway origins to the existing idempotent reconciler and captures output in memory", async () => {
    let received: BootstrapOptions | undefined;
    const result = await reconcileHostedLogto(environment, (async (options?: BootstrapOptions) => {
      received = options;
      await options?.persistConfig?.(config);
      return config;
    }) as never);

    expect(received).toMatchObject({
      endpoint: "http://logto.railway.internal:4301",
      adminEndpoint: "http://logto.railway.internal:4302",
      postgresUrl: environment.LOGTO_POSTGRES_URL,
      resource: "https://nautilo.example.test/api",
      extraWorkbenchRedirectUris: ["https://nautilo.example.test/auth/callback"],
      persistAdminCredential: false,
    });
    expect(result.port).toBe(8080);
    expect(result.token).toBe("never-log-handoff-token");
    expect(result.output["logto-m2m-app-secret"]).toBe("never-log-m2m-secret");
    expect(received?.managedWorkbenchOriginReplacement).toBeUndefined();
  });

  test("passes a canonical request-memory managed-origin replacement to the reconciler", async () => {
    let received: BootstrapOptions | undefined;
    await reconcileHostedLogto({
      ...environment,
      NAUTILO_MANAGED_WORKBENCH_SOURCE_ORIGIN: "https://source.example.test",
    }, (async (options?: BootstrapOptions) => {
      received = options;
      await options?.persistConfig?.(config);
      return config;
    }) as never);
    expect(received?.managedWorkbenchOriginReplacement).toEqual({
      sourceOrigin: "https://source.example.test",
      targetOrigin: "https://nautilo.example.test",
    });
    expect(received?.preserveProvisionedState).toBe(true);
  });

  test("ordinary hosted bootstrap keeps the established provisioning path", async () => {
    let received: BootstrapOptions | undefined;
    await reconcileHostedLogto(environment, (async (options?: BootstrapOptions) => {
      received = options;
      await options?.persistConfig?.(config);
      return config;
    }) as never);
    expect(received?.preserveProvisionedState).toBeUndefined();
  });

  test("rejects malformed, equal, and mismatched managed origins before reconciliation", async () => {
    for (const invalid of [
      { ...environment, NAUTILO_MANAGED_WORKBENCH_SOURCE_ORIGIN: "http://source.example.test" },
      { ...environment, NAUTILO_MANAGED_WORKBENCH_SOURCE_ORIGIN: environment.NAUTILO_PUBLIC_BASE_URL },
      { ...environment, NAUTILO_MANAGED_WORKBENCH_SOURCE_ORIGIN: "https://source.example.test", NAUTILO_WORKBENCH_REDIRECT_URI: "https://other.example.test/auth/callback" },
    ]) {
      let calls = 0;
      let caught: unknown;
      try {
        await reconcileHostedLogto(invalid, async () => { calls += 1; return config; });
      } catch (error) { caught = error; }
      expect(caught).toEqual(new HostedLogtoBootstrapInputError("invalid-managed-workbench-origin-replacement"));
      expect(calls).toBe(0);
    }
  });

  test("removes only the source-managed set, adds the target set, keeps unrelated URIs, and replays exactly", () => {
    const replacement = normalizeManagedWorkbenchOriginReplacement({
      sourceOrigin: "https://source.example.test",
      targetOrigin: "https://target.example.test",
    });
    const source = deriveManagedWorkbenchOriginUris(replacement.sourceOrigin);
    const target = deriveManagedWorkbenchOriginUris(replacement.targetOrigin);
    const unrelatedRedirect = "https://operator.example.test/callback";
    const unrelatedLogout = "https://operator.example.test/logout";
    expect(source.redirectUris).toEqual([
      "https://source.example.test/auth/callback",
      "https://source.example.test/settings/security",
    ]);
    expect(source.postLogoutRedirectUris).toEqual([
      "https://source.example.test",
      "https://source.example.test/logout",
      "https://source.example.test/claim",
    ]);
    expect(target.redirectUris).toEqual([
      "https://target.example.test/auth/callback",
      "https://target.example.test/settings/security",
    ]);
    expect(target.postLogoutRedirectUris).toEqual([
      "https://target.example.test",
      "https://target.example.test/logout",
      "https://target.example.test/claim",
    ]);
    const first = computeOidcUriRebindPatch(
      [...source.redirectUris, unrelatedRedirect],
      [...source.postLogoutRedirectUris, unrelatedLogout],
      target.redirectUris,
      target.postLogoutRedirectUris,
      source.redirectUris,
      source.postLogoutRedirectUris,
    );
    expect(first.mergedRedirectUris).toEqual([unrelatedRedirect, ...target.redirectUris]);
    expect(first.mergedPostLogoutRedirectUris).toEqual([unrelatedLogout, ...target.postLogoutRedirectUris]);
    expect(first.removedRedirects).toEqual([...source.redirectUris]);
    expect(first.removedPostLogout).toEqual([...source.postLogoutRedirectUris]);
    const replay = computeOidcUriRebindPatch(
      first.mergedRedirectUris, first.mergedPostLogoutRedirectUris,
      target.redirectUris, target.postLogoutRedirectUris,
      source.redirectUris, source.postLogoutRedirectUris,
    );
    expect(replay.mergedRedirectUris).toEqual(first.mergedRedirectUris);
    expect(replay.mergedPostLogoutRedirectUris).toEqual(first.mergedPostLogoutRedirectUris);
    expect(replay.removedRedirects).toEqual([]);
    expect(replay.removedPostLogout).toEqual([]);
  });

  test("fails closed on a missing, duplicate, or non-SPA managed Workbench identity", () => {
    expect(() => selectManagedWorkbenchApplication([], "Nautilo Workbench")).toThrow();
    expect(() => selectManagedWorkbenchApplication([
      { id: "one", name: "Nautilo Workbench", type: "SPA" },
      { id: "two", name: "Nautilo Workbench", type: "SPA" },
    ], "Nautilo Workbench")).toThrow();
    expect(() => selectManagedWorkbenchApplication([
      { id: "one", name: "Nautilo Workbench", type: "Native" },
    ], "Nautilo Workbench")).toThrow();
  });

  test("fails with a stable code before reconciliation when a required input is absent", async () => {
    const invalid = { ...environment, LOGTO_POSTGRES_URL: "" };
    const reconcile = async (_options?: BootstrapOptions): Promise<LogtoConfig> => config;
    let caught: unknown;
    try {
      await reconcileHostedLogto(invalid, reconcile);
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(new HostedLogtoBootstrapInputError("missing-logto-postgres-url"));
    expect(JSON.stringify(new HostedLogtoBootstrapInputError("missing-logto-postgres-url")))
      .not.toContain("never-log-m2m-secret");
  });

  test("serves output only to the bearer token and permits safe retry until teardown", async () => {
    const server = createHostedHandoffServer("handoff-token", hostedOutput(config));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener address");
    const url = `http://127.0.0.1:${address.port}/handoff`;
    try {
      const denied = await fetch(url);
      expect(denied.status).toBe(401);
      expect(await denied.text()).not.toContain("never-log-m2m-secret");

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const accepted = await fetch(url, { headers: { authorization: "Bearer handoff-token" } });
        expect(accepted.status).toBe(200);
        expect((await accepted.json() as Record<string, string>)["logto-m2m-app-secret"])
          .toBe("never-log-m2m-secret");
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
