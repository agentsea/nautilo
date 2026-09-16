import { describe, expect, test } from "bun:test";
import {
  OpenConnectorAdminClient,
  OpenConnectorAdminError,
} from "../../src/connected-apps/openconnector-admin-client";

describe("D456 OpenConnector schema admission", () => {
  test("normalizes the current OpenConnector missing OAuth-client code into Nautilo recovery language", async () => {
    const client = new OpenConnectorAdminClient(
      "http://127.0.0.1:3000",
      null,
      (async () => Response.json({
        error: {
          code: "oauth_client_config_required",
          message: "Configure an OAuth client first.",
        },
      }, { status: 400 })) as unknown as typeof fetch,
    );

    const error = await client.startAuthorization("airtable", "user-alias")
      .catch((reason: unknown) => reason);
    expect(error).toEqual(new OpenConnectorAdminError("oauth_client_not_configured", 400));
  });

  test("streams multipart transit bytes with administrator authority and deletes the exact staged file", async () => {
    const fileId = `${"a".repeat(32)}.pdf`;
    const requests: Request[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request
        ? input
        : new Request(input instanceof URL ? input.toString() : input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/api/files" && request.method === "POST") {
        const body = new Uint8Array(await request.arrayBuffer());
        expect(new TextDecoder().decode(body)).toContain("Nautilo");
        return Response.json({
          fileId,
          downloadUrl: `http://127.0.0.1:3000/api/files/${fileId}`,
          sizeBytes: 7,
          name: "brief.pdf",
          mimeType: "application/pdf",
        });
      }
      if (url.pathname === `/api/files/${fileId}` && request.method === "DELETE") {
        return Response.json({ fileId, deleted: true });
      }
      throw new Error(`unexpected request ${request.method} ${url.pathname}`);
    };
    const client = new OpenConnectorAdminClient(
      "http://127.0.0.1:3000",
      "admin-token",
      fetchImpl as typeof fetch,
    );

    expect(await client.uploadTransitFile({
      name: "brief.pdf",
      mimeType: "application/pdf",
      sizeBytes: 7,
      chunks: (async function* () {
        yield Uint8Array.from([78, 97, 117]);
        yield Uint8Array.from([116, 105, 108, 111]);
      })(),
    })).toMatchObject({ fileId, sizeBytes: 7 });
    expect(await client.deleteTransitFile(fileId)).toBe(true);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer admin-token");
    expect(requests[0]?.headers.get("content-type")).toStartWith("multipart/form-data; boundary=nautilo-");
    expect(Number(requests[0]?.headers.get("content-length"))).toBeGreaterThan(7);
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer admin-token");
  });

  test("rejects an upstream action when its schema no longer matches the curated hash", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/api/oauth/configs") {
        return Response.json([{
          service: "slack",
          configured: true,
          clientId: "slack-client",
          expectedRedirectUri: "http://127.0.0.1:3000/oauth/callback",
        }]);
      }
      if (url.pathname === "/api/providers") return Response.json([{ service: "slack" }]);
      if (url.pathname === "/api/actions") return Response.json([{ id: "slack.list_conversations", service: "slack" }]);
      if (url.pathname === "/api/actions/slack.list_conversations") {
        return Response.json({
          id: "slack.list_conversations",
          inputSchema: { type: "object", properties: { unexpected: { type: "string" } } },
          outputSchema: { type: "object" },
        });
      }
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    };
    const client = new OpenConnectorAdminClient(
      "http://127.0.0.1:3000",
      "admin-token",
      fetchImpl as typeof fetch,
    );

    const result = client.verifyProvider(
      "slack",
      ["slack.list_conversations"],
      { "slack.list_conversations": "0".repeat(64) },
      null,
    );

    const error = await result.catch((reason: unknown) => reason);
    expect(error).toEqual(new OpenConnectorAdminError("openconnector_action_schema_drift", 409));
  });

  test.each([
    ["missing", []],
    ["unexpected", ["slack.list_conversations", "slack.new_action"]],
    ["duplicate", ["slack.list_conversations", "slack.list_conversations"]],
  ])("rejects %s upstream provider action inventory before authorizing a token", async (_kind, actionIds) => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/api/oauth/configs") {
        return Response.json([{ service: "slack", configured: true, clientId: "slack-client" }]);
      }
      if (url.pathname === "/api/providers") return Response.json([{ service: "slack" }]);
      if (url.pathname === "/api/actions") return Response.json(actionIds.map((id) => ({ id, service: "slack" })));
      throw new Error(`unexpected request ${url.pathname}`);
    };
    const client = new OpenConnectorAdminClient("http://127.0.0.1:3000", "admin-token", fetchImpl as typeof fetch);
    const result = client.verifyProvider(
      "slack",
      ["slack.list_conversations"],
      { "slack.list_conversations": "a".repeat(64) },
      null,
    );
    const error = await result.catch((reason: unknown) => reason);
    expect(error).toEqual(new OpenConnectorAdminError("connected_app_action_inventory_mismatch", 409));
  });

  test("rejects readiness when any expected action hash is missing", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/api/oauth/configs") {
        return Response.json([{ service: "slack", configured: true, clientId: "slack-client" }]);
      }
      if (url.pathname === "/api/providers") return Response.json([{ service: "slack" }]);
      if (url.pathname === "/api/actions") {
        return Response.json([{ id: "slack.list_conversations", service: "slack" }]);
      }
      throw new Error(`unexpected request ${url.pathname}`);
    };
    const client = new OpenConnectorAdminClient(
      "http://127.0.0.1:3000",
      "admin-token",
      fetchImpl as typeof fetch,
    );
    const error = await client.verifyProvider(
      "slack",
      ["slack.list_conversations"],
      {},
      null,
    ).catch((reason: unknown) => reason);
    expect(error).toEqual(new OpenConnectorAdminError("connected_app_action_schema_invalid", 409));
  });
});
