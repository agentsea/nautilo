import { describe, expect, test } from "bun:test";
import { OpenConnector } from "@oomol-lab/connector";
import type { ConnectedAppProfileRow, ConnectedAppProviderConfigRow } from "@nautilo/db";
import {
  OpenConnectorLocalConnectedAppDriver,
  type ConnectedAppSecretStore,
  type DriverSecretRef,
} from "../../src/connected-apps/local-driver";

const EMPTY_ACTION_SCHEMA_HASH = "cf31d309b74c082e2ea1e4d62c858e812d98f6df36f9ea5692225b3bcfb43b9b";

function actionSchemaHashes(actionIds: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(actionIds.map((actionId) => [actionId, EMPTY_ACTION_SCHEMA_HASH]));
}

function secretStore(): ConnectedAppSecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    store: async (input) => {
      const ref: DriverSecretRef = {
        id: `${input.namespaceId}:${input.agentId}:${input.field}`,
        namespaceId: input.namespaceId,
        agentId: input.agentId,
        field: input.field,
      };
      values.set(ref.id, input.value);
      return ref;
    },
    read: async (ref) => values.get(ref.id) ?? null,
    delete: async (ref) => { values.delete(ref.id); },
  };
}

function providerConfig(
  adminRef: DriverSecretRef,
  providerId: "notion" | "slack" = "notion",
): ConnectedAppProviderConfigRow {
  const now = new Date();
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    providerId,
    driverKind: "openconnector_local",
    status: "ready",
    clientId: "client-id",
    adminCredentialRefId: adminRef.id,
    adminCredentialNamespaceId: adminRef.namespaceId,
    adminCredentialAgentId: adminRef.agentId,
    lastErrorCode: null,
    revision: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

describe("D456 OpenConnector local driver", () => {
  test("lets the caller own long-running connected-app cancellation", async () => {
    const client = new OpenConnector({
      baseUrl: "http://127.0.0.1:3000",
      runtimeToken: "oct_test",
      timeoutMs: 0,
      maxRetries: 0,
      fetch: (async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({
          success: true,
          data: [{ id: "dropbox:test", service: "dropbox", status: "active", alias: "test" }],
          meta: {},
        });
      }) as unknown as typeof fetch,
    });

    const apps = await Promise.resolve(client.apps.listByService("dropbox", { retries: 0 }));
    expect(apps).toEqual([
      { id: "dropbox:test", service: "dropbox", status: "active", connectionName: "test" },
    ]);
  });

  test("reuses administrator setup, restricted tokens, dispatch, and disconnect for Slack", async () => {
    const secrets = secretStore();
    let alias = "";
    let runtimeToken = "";
    let tokenPolicy: Record<string, unknown> | null = null;
    let disconnected = false;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      if (url.pathname === "/api/oauth/configs/slack" && init?.method === "PUT") {
        expect(body).toMatchObject({
          requestedScopes: [
            "channels:read", "groups:read", "im:read", "mpim:read",
            "channels:history", "groups:history", "im:history", "mpim:history",
            "search:read", "chat:write",
          ],
        });
        return Response.json({ service: "slack", configured: true, clientId: "slack-client", expectedRedirectUri: "http://127.0.0.1:3000/oauth/callback" });
      }
      if (url.pathname === "/api/providers") return Response.json([{ service: "slack" }]);
      if (url.pathname === "/api/actions") return Response.json(actions.map((id) => ({ id, service: "slack" })));
      if (url.pathname.startsWith("/api/actions/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/actions/".length));
        return Response.json({ id, inputSchema: { type: "object" }, outputSchema: { type: "object" } });
      }
      if (url.pathname === "/api/oauth/authorizations") {
        alias = String(body["connectionName"]);
        expect(body).toMatchObject({ service: "slack" });
        return Response.json({ authorizationUrl: `https://slack.example/authorize?state=${alias}`, state: `state-${alias}` });
      }
      if (url.pathname === "/api/connections" && init?.method !== "DELETE") {
        return Response.json([{ id: `slack:${alias}`, service: "slack", connectionName: alias, configured: true,
          profile: { accountId: "U123", displayName: "Pilot Slack", grantedScopes: ["channels:read", "chat:write"] } }]);
      }
      if (url.pathname === "/api/runtime-tokens" && init?.method !== "POST") return Response.json([]);
      if (url.pathname === "/api/runtime-tokens" && init?.method === "POST") {
        tokenPolicy = body;
        runtimeToken = "oct_slack_token";
        return Response.json({ token: runtimeToken, record: { id: "runtime-slack" } });
      }
      if (url.pathname === "/v1/apps/services/slack") {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${runtimeToken}`);
        return Response.json({ success: true, data: [{ id: `slack:${alias}`, service: "slack", status: "active", alias }], meta: {} });
      }
      if (url.pathname === "/v1/actions/slack.list_conversations" && init?.method === "POST") {
        return Response.json({ success: true, data: { conversations: [], nextCursor: null }, message: "OK", meta: { actionId: "slack.list_conversations", executionId: "execution-slack" } });
      }
      if (url.pathname.startsWith("/api/runtime-tokens/") && init?.method === "DELETE") return Response.json({ revoked: true });
      if (url.pathname === "/api/connections/slack" && init?.method === "DELETE") {
        disconnected = true;
        return Response.json({ configured: false });
      }
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    };
    const driver = new OpenConnectorLocalConnectedAppDriver("http://127.0.0.1:3000", secrets, fetchImpl as typeof fetch);
    const scope = { userId: "11111111-1111-4111-8111-111111111111", namespaceId: "33333333-3333-4333-8333-333333333333" };
    const actions = ["slack.list_conversations", "slack.get_channel_messages", "slack.search_messages", "slack.post_message"];
    const requestedScopes = [
      "channels:read", "groups:read", "im:read", "mpim:read",
      "channels:history", "groups:history", "im:history", "mpim:history",
      "search:read", "chat:write",
    ];
    const configured = await driver.configure({
      providerId: "slack", allowedActions: actions, schemaSha256: actionSchemaHashes(actions), requestedScopes, scope, existing: null,
      clientId: "slack-client", clientSecret: "slack-secret", adminToken: "admin-token",
    });
    const config = providerConfig(configured.adminCredentialRef!, "slack");
    const started = await driver.startOauth("slack", scope, config);
    const inspected = await driver.inspectOauth({
      providerId: "slack", allowedActions: actions, scope, config,
      connectionName: started.connectionName, authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt,
    });
    expect(inspected.status).toBe("connected");
    if (inspected.status !== "connected") throw new Error("expected Slack connection");
    expect(tokenPolicy).toMatchObject({
      allowedActions: actions,
      allowedConnections: [inspected.connectedAccountId],
    });
    const now = new Date();
    const profile: ConnectedAppProfileRow = {
      id: "44444444-4444-4444-8444-444444444444", userId: scope.userId, namespaceId: scope.namespaceId,
      providerId: "slack", driverKind: "openconnector_local", status: "connected",
      connectedAccountId: inspected.connectedAccountId, providerConfigId: inspected.providerConfigId,
      connectionName: inspected.connectionName, providerUserId: inspected.providerUserId,
      providerWorkspaceIdentity: inspected.workspaceIdentity, providerUserKind: inspected.account.kind,
      accountUsername: null, accountDisplayName: inspected.account.displayName, accountEmail: null,
      accountAvatarUrl: null, accountWorkspaceName: null, driverCredentialRefId: inspected.driverCredentialRef.id,
      driverCredentialNamespaceId: inspected.driverCredentialRef.namespaceId,
      driverCredentialAgentId: inspected.driverCredentialRef.agentId,
      driverCredentialRecordId: inspected.driverCredentialRecordId, lastErrorCode: null, revision: 0,
      connectedAt: now, lastVerifiedAt: now, createdAt: now, updatedAt: now,
    };
    expect(await driver.execute({ providerId: "slack", effect: "read", profile, operationId: "slack.list_conversations", args: {} }))
      .toMatchObject({ executionId: "execution-slack" });
    await driver.disconnect({ providerId: "slack", profile, config });
    expect(disconnected).toBe(true);
    expect(secrets.values.has(inspected.driverCredentialRef.id)).toBe(false);
  });

  test("verifies admitted schemas, isolates two users, executes dynamically, and disconnects exactly", async () => {
    const secrets = secretStore();
    const tokenPolicies: Array<Record<string, unknown>> = [];
    const revoked: string[] = [];
    const disconnected: string[] = [];
    const aliases: string[] = [];
    const runtimeTokenToConnection = new Map<string, string>();
    let tokenSequence = 0;

    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      if (url.pathname === "/api/oauth/configs/notion" && init?.method === "PUT") {
        expect(body).toMatchObject({ clientId: "client-id", clientSecret: "client-secret" });
        return Response.json({ service: "notion", configured: true, clientId: "client-id", expectedRedirectUri: "http://127.0.0.1:3000/oauth/callback" });
      }
      if (url.pathname === "/api/oauth/configs") {
        return Response.json([{ service: "notion", configured: true, clientId: "client-id", expectedRedirectUri: "http://127.0.0.1:3000/oauth/callback" }]);
      }
      if (url.pathname === "/api/providers") return Response.json([{ service: "notion", displayName: "Notion", actions: [] }]);
      if (url.pathname === "/api/actions") return Response.json([
        "notion.search", "notion.retrieve_page", "notion.create_page",
      ].map((id) => ({ id, service: "notion" })));
      if (url.pathname.startsWith("/api/actions/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/actions/".length));
        return Response.json({ id, inputSchema: { type: "object" }, outputSchema: { type: "object" } });
      }
      if (url.pathname === "/api/oauth/authorizations") {
        const alias = String(body["connectionName"]);
        aliases.push(alias);
        return Response.json({ authorizationUrl: `https://notion.example/authorize?state=${alias}`, state: `state-${alias}` });
      }
      if (url.pathname === "/api/connections" && init?.method !== "DELETE") {
        return Response.json(aliases.map((alias) => ({
          id: `notion:${alias}`,
          service: "notion",
          connectionName: alias,
          authType: "oauth2",
          configured: true,
          virtual: false,
          default: false,
          profile: { accountId: `account-${alias}`, displayName: `User ${aliases.indexOf(alias) + 1}`, grantedScopes: [] },
        })));
      }
      if (url.pathname === "/api/runtime-tokens" && init?.method !== "POST") return Response.json([]);
      if (url.pathname === "/api/runtime-tokens" && init?.method === "POST") {
        tokenPolicies.push(body);
        tokenSequence += 1;
        const token = `oct_token_${tokenSequence}`;
        runtimeTokenToConnection.set(token, String((body["allowedConnections"] as string[])[0]));
        return Response.json({ token, record: { id: `runtime-${tokenSequence}` } });
      }
      if (url.pathname.startsWith("/api/runtime-tokens/") && init?.method === "DELETE") {
        revoked.push(decodeURIComponent(url.pathname.split("/").at(-1) ?? ""));
        return Response.json({ revoked: true });
      }
      if (url.pathname === "/api/connections/notion" && init?.method === "DELETE") {
        disconnected.push(url.searchParams.get("connectionName") ?? "");
        return Response.json({ configured: false });
      }
      if (url.pathname === "/v1/apps/services/notion") {
        const token = authorization.replace(/^Bearer /u, "");
        const connectionId = runtimeTokenToConnection.get(token);
        const alias = connectionId?.slice("notion:".length) ?? "";
        return Response.json({ success: true, data: [{ id: connectionId, service: "notion", status: "active", alias }], meta: {} });
      }
      if (url.pathname === "/v1/actions/notion.search" && init?.method === "POST") {
        return Response.json({ success: true, data: { object: "list", results: [], next_cursor: null, has_more: false }, message: "OK", meta: { actionId: "notion.search", executionId: "execution-local" } });
      }
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    };

    const driver = new OpenConnectorLocalConnectedAppDriver("http://127.0.0.1:3000", secrets, fetchImpl as typeof fetch);
    const scopeOne = { userId: "11111111-1111-4111-8111-111111111111", namespaceId: "33333333-3333-4333-8333-333333333333" };
    const notionActions = ["notion.search", "notion.retrieve_page", "notion.create_page"];
    const configured = await driver.configure({ providerId: "notion", allowedActions: notionActions, schemaSha256: actionSchemaHashes(notionActions), scope: scopeOne, existing: null, clientId: "client-id", clientSecret: "client-secret", adminToken: "admin-token" });
    expect(configured.callbackUrl).toBe("http://127.0.0.1:3000/oauth/callback");
    const config = providerConfig(configured.adminCredentialRef!);
    expect(await driver.configure({ providerId: "notion", allowedActions: notionActions, schemaSha256: actionSchemaHashes(notionActions), scope: scopeOne, existing: config })).toMatchObject({
      clientId: "client-id",
      callbackUrl: "http://127.0.0.1:3000/oauth/callback",
    });

    const scopes = [
      scopeOne,
      { userId: "22222222-2222-4222-8222-222222222222", namespaceId: scopeOne.namespaceId },
    ];
    const profiles: ConnectedAppProfileRow[] = [];
    for (const scope of scopes) {
      const started = await driver.startOauth("notion", scope, config);
      const inspected = await driver.inspectOauth({
        providerId: "notion",
        allowedActions: notionActions,
        scope,
        config,
        connectionName: started.connectionName,
        authorizationUrl: started.authorizationUrl,
        expiresAt: started.expiresAt,
      });
      expect(inspected.status).toBe("connected");
      if (inspected.status !== "connected") throw new Error("expected connection");
      const now = new Date();
      profiles.push({
        id: scope.userId,
        userId: scope.userId,
        namespaceId: scope.namespaceId,
        providerId: "notion",
        driverKind: "openconnector_local",
        status: "connected",
        connectedAccountId: inspected.connectedAccountId,
        providerConfigId: inspected.providerConfigId,
        connectionName: inspected.connectionName,
        providerUserId: inspected.providerUserId,
        providerWorkspaceIdentity: inspected.workspaceIdentity,
        providerUserKind: inspected.account.kind,
        accountUsername: null,
        accountDisplayName: inspected.account.displayName,
        accountEmail: null,
        accountAvatarUrl: null,
        accountWorkspaceName: null,
        driverCredentialRefId: inspected.driverCredentialRef.id,
        driverCredentialNamespaceId: inspected.driverCredentialRef.namespaceId,
        driverCredentialAgentId: inspected.driverCredentialRef.agentId,
        driverCredentialRecordId: inspected.driverCredentialRecordId,
        lastErrorCode: null,
        revision: 0,
        connectedAt: now,
        lastVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    expect(tokenPolicies).toHaveLength(2);
    expect(tokenPolicies[0]).toMatchObject({
      allowedActions: ["notion.search", "notion.retrieve_page", "notion.create_page"],
      allowedConnections: [profiles[0]!.connectedAccountId],
      allowedProxies: [],
    });
    expect(tokenPolicies[1]?.["allowedConnections"]).toEqual([profiles[1]!.connectedAccountId]);
    expect(profiles[0]!.driverCredentialRefId).not.toBe(profiles[1]!.driverCredentialRefId);

    expect(await driver.execute({ providerId: "notion", effect: "read", profile: profiles[0]!, operationId: "notion.search", args: { query: "pilot" } }))
      .toMatchObject({ executionId: "execution-local", data: { object: "list" } });
    await driver.disconnect({ providerId: "notion", profile: profiles[0]!, config });
    expect(revoked).toEqual([profiles[0]!.driverCredentialRecordId!]);
    expect(disconnected).toEqual([profiles[0]!.connectionName]);
    expect(secrets.values.has(profiles[0]!.driverCredentialRefId!)).toBe(false);
    expect(secrets.values.has(profiles[1]!.driverCredentialRefId!)).toBe(true);
  });

  test("reads only exact local OpenConnector transit-file identifiers", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const driver = new OpenConnectorLocalConnectedAppDriver(
      "http://127.0.0.1:3000",
      secretStore(),
      (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
          init,
        });
        return new Response(Uint8Array.from([1, 2, 3]));
      }) as typeof fetch,
    );
    const fileId = `${"a".repeat(32)}.pdf`;
    const transit = await driver.readTransitFile({ fileId });
    const bytes: number[] = [];
    for await (const chunk of transit.chunks) bytes.push(...chunk);
    expect(bytes).toEqual([1, 2, 3]);
    expect(calls).toEqual([{
      url: `http://127.0.0.1:3000/api/files/${fileId}`,
      init: { method: "GET", redirect: "error", credentials: "omit" },
    }]);

    const invalid = await driver.readTransitFile({ fileId: "../secret" })
      .catch((cause: unknown) => cause);
    expect(invalid).toMatchObject({
      code: "connected_app_transit_file_invalid",
      status: 404,
    });
    expect(calls).toHaveLength(1);
  });
});
