import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  HostedConnectedAppDriverError,
  OomolHostedConnectedAppDriver,
  hostedDriverBinding,
} from "../../src/connected-apps/hosted-driver";

type Seen = { path: string; method: string; body: Record<string, unknown> | null };

function gateway(options: { mismatchProfile?: boolean; actionStatus?: number } = {}): {
  fetch: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  let binding = { externalUserId: "", connectionName: "" };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : null;
    seen.push({ path: url.pathname, method: init?.method ?? "GET", body });
    if (url.pathname.endsWith("/link")) {
      const externalUserId = body?.["userId"];
      const connectionName = body?.["alias"];
      binding = {
        externalUserId: typeof externalUserId === "string" ? externalUserId : "",
        connectionName: typeof connectionName === "string" ? connectionName : "",
      };
      return Response.json({ success: true, data: {
        id: "request-A",
        status: "initiated",
        projectId: "project-A",
        providerConfigId: "provider-A",
        externalUserId: binding.externalUserId,
        service: "notion",
        alias: binding.connectionName,
        authorizationUrl: "https://authorization.example/notion",
        connectedAccountId: null,
        errorCode: null,
        errorMessage: null,
        expiresAt: "2030-01-01T00:00:00Z",
        createdAt: 1,
        updatedAt: 1,
      } });
    }
    if (url.pathname.includes("/connection-requests/")) {
      return Response.json({ success: true, data: {
        id: "request-A",
        status: "connected",
        projectId: "project-A",
        providerConfigId: "provider-A",
        externalUserId: binding.externalUserId,
        service: "notion",
        alias: binding.connectionName,
        authorizationUrl: "https://authorization.example/notion",
        connectedAccountId: "account-A",
        errorCode: null,
        errorMessage: null,
        expiresAt: "2030-01-01T00:00:00Z",
        createdAt: 1,
        updatedAt: 2,
      } });
    }
    if (url.pathname.endsWith("/profile")) {
      return Response.json({ success: true, data: {
        connectedAccountId: "account-A",
        externalUserId: options.mismatchProfile ? "other-user" : binding.externalUserId,
        service: "notion",
        profile: {
          id: "notion-user-A",
          kind: "user",
          username: "alex",
          displayName: "Alex",
          avatarUrl: "https://images.example/avatar.png",
          email: "alex@example.com",
          metadata: { workspaceId: "workspace-A", workspaceName: "Pilot Workspace" },
        },
        fetchedAt: 1,
      } });
    }
    if (url.pathname.includes("/actions/")) {
      if (options.actionStatus) {
        return Response.json(
          { error: { code: "provider_error", message: "PLANTED_UPSTREAM_SECRET" } },
          { status: options.actionStatus },
        );
      }
      return Response.json({
        success: true,
        data: {
          output: { results: [{ id: "page-A" }] },
          executionId: "execution-A",
          actionId: "notion.search",
          message: null,
        },
      });
    }
    return Response.json({ error: { code: "not_found", message: "unexpected" } }, { status: 404 });
  };
  return { fetch: fetchImpl as typeof fetch, seen };
}

describe("D456 hosted connected-app driver", () => {
  test("uses a full lowercase SHA-256 alias accepted by the hosted gateway", () => {
    const binding = hostedDriverBinding("user-A", "namespace-A");
    expect(binding.connectionName).toMatch(/^[a-f0-9]{64}$/u);
    expect(binding.connectionName).toBe(hostedDriverBinding("user-A", "namespace-A").connectionName);
    expect(binding.connectionName).not.toBe(hostedDriverBinding("user-A", "namespace-B").connectionName);
  });

  test("resumes OAuth by request id, verifies account identity, and executes one exact action", async () => {
    const fake = gateway();
    const driver = new OomolHostedConnectedAppDriver(
      "oo_proj_abcdefghijklmnopqrstuvwxyz123456",
      { fetch: fake.fetch },
    );
    const binding = hostedDriverBinding(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    );
    const started = await driver.startOauth(binding, "http://127.0.0.1:3001/connections");
    expect(started).toMatchObject({ requestId: "request-A", providerConfigId: "provider-A" });
    expect(JSON.stringify(fake.seen[0]?.body)).not.toContain("11111111-1111-4111-8111-111111111111");

    const inspected = await driver.inspectOauth(binding, {
      requestId: started.requestId,
      providerConfigId: started.providerConfigId,
    });
    expect(inspected).toMatchObject({
      status: "connected",
      connectedAccountId: "account-A",
      account: { displayName: "Alex", email: "alex@example.com", workspaceName: "Pilot Workspace" },
    });
    if (inspected.status !== "connected") throw new Error("expected connected profile");

    const executed = await driver.execute({
      binding,
      connectedAccountId: "account-A",
      providerConfigId: "provider-A",
      workspaceIdentity: inspected.workspaceIdentity,
      operationId: "notion.search",
      args: { query: "pilot" },
    });
    expect(executed).toEqual({ executionId: "execution-A", data: { results: [{ id: "page-A" }] } });
    expect(fake.seen.filter((entry) => entry.path.includes("/actions/"))).toHaveLength(1);
  });

  test("rejects a cross-user account before action dispatch", async () => {
    const fake = gateway({ mismatchProfile: true });
    const driver = new OomolHostedConnectedAppDriver(
      "oo_proj_abcdefghijklmnopqrstuvwxyz123456",
      { fetch: fake.fetch },
    );
    const binding = hostedDriverBinding("user-A", "namespace-A");
    const workspaceIdentity = createHash("sha256")
      .update("notion-workspace:workspace-A")
      .digest("base64url");
    await driver.startOauth(binding, "https://nautilo.example/connections");
    const error = await driver.execute({
      binding,
      connectedAccountId: "account-A",
      providerConfigId: "provider-A",
      workspaceIdentity,
      operationId: "notion.search",
      args: {},
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "connection_identity_mismatch" });
    expect(fake.seen.filter((entry) => entry.path.includes("/actions/"))).toHaveLength(0);
  });

  test("does not reflect hosted provider error bodies", async () => {
    const fake = gateway({ actionStatus: 500 });
    const driver = new OomolHostedConnectedAppDriver(
      "oo_proj_abcdefghijklmnopqrstuvwxyz123456",
      { fetch: fake.fetch },
    );
    const binding = hostedDriverBinding("user-A", "namespace-A");
    const workspaceIdentity = createHash("sha256")
      .update("notion-workspace:workspace-A")
      .digest("base64url");
    await driver.startOauth(binding, "https://nautilo.example/connections");
    const error = await driver.execute({
      binding,
      connectedAccountId: "account-A",
      providerConfigId: "provider-A",
      workspaceIdentity,
      operationId: "notion.search",
      args: {},
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HostedConnectedAppDriverError);
    expect(JSON.stringify(error)).not.toContain("PLANTED_UPSTREAM_SECRET");
    expect(fake.seen.filter((entry) => entry.path.includes("/actions/"))).toHaveLength(1);
  });
});
