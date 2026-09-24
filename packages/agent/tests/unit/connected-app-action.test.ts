import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ToolContext } from "@nautilo/catalog";
import { compileConnectedAppOperationAdmissions } from "../../src/tools/connected-apps/admissions";
import { createConnectedAppActionTool } from "../../src/tools/connected-apps/connected-app-action";
import { setConnectedAppActionRuntime } from "../../src/tools/connected-apps/runtime";

const [admission] = compileConnectedAppOperationAdmissions([{
  id: "notion",
  displayName: "Fixture Notion",
  description: "Fixture.",
  searchTerms: ["fixture"],
  iconUrl: "https://media.nautilo.ai/connections/icons/fixture.svg",
  shortMark: "N",
  sortOrder: 1,
  lifecycle: "pilot",
  defaultEnabled: false,
  service: "notion",
  supportedDrivers: ["openconnector_local"],
  setup: { kind: "oauth_client", providerSetupUrl: "https://example.test", scopes: [], acceptsAdminToken: true },
  operations: [{
    toolName: "notion_search",
    sourceActionId: "notion.search",
    label: "Search",
    description: "Search fixture content.",
    tags: ["notion", "search"],
    category: "knowledge",
    discoveryCategories: ["integrations"],
    impact: "read-only",
    effect: "read",
    requiresApproval: false,
    sourceSchemaSha256: "a".repeat(64),
    inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } }, required: ["query"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { results: { type: "array" } }, required: ["results"] },
  }],
}]);
if (!admission) throw new Error("fixture admission missing");

afterEach(() => setConnectedAppActionRuntime(null));

describe("D456 generic connected-app action projection", () => {
  test("binds Human×Namespace context and dispatches the exact admitted source action", async () => {
    const execute = mock(async (_input: unknown) => ({
      providerId: "notion" as const,
      operationId: "notion.search",
      executionId: "execution-A",
      profileId: "44444444-4444-4444-8444-444444444444",
      effect: "read" as const,
      reconciliation: null,
      result: { results: [] },
    }));
    setConnectedAppActionRuntime({ execute });
    const tool = createConnectedAppActionTool(admission, {
      userId: "11111111-1111-4111-8111-111111111111",
      causalHumanUserId: "33333333-3333-4333-8333-333333333333",
      memoryAccessEnvelope: {
        memoryMode: "namespace",
        writableNamespaces: ["22222222-2222-4222-8222-222222222222"],
      },
    } as unknown as ToolContext);

    const output: unknown = await Promise.resolve(tool.invoke({ query: "pilot" }));
    if (typeof output !== "string") throw new Error("tool output was not serialized");
    expect(JSON.parse(output) as unknown).toMatchObject({
      executionId: "execution-A",
      result: { results: [] },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      userId: "11111111-1111-4111-8111-111111111111",
      causalHumanUserId: "33333333-3333-4333-8333-333333333333",
      namespaceId: "22222222-2222-4222-8222-222222222222",
      memoryAccessEnvelope: {
        memoryMode: "namespace",
        writableNamespaces: ["22222222-2222-4222-8222-222222222222"],
      },
      providerId: "notion",
      operationId: "notion.search",
      effect: "read",
      input: { query: "pilot" },
    });
  });

  test("rejects extra action fields and scope-memory contexts before dispatch", async () => {
    const execute = mock(async (_input: unknown) => {
      throw new Error("should not run");
    });
    setConnectedAppActionRuntime({ execute });
    const ordinary = createConnectedAppActionTool(admission, {
      userId: "user-A",
      memoryAccessEnvelope: { memoryMode: "namespace", writableNamespaces: ["namespace-A"] },
    } as unknown as ToolContext);
    let ordinaryError: unknown = null;
    try {
      await Promise.resolve(ordinary.invoke({ query: "pilot", invented: true }));
    } catch (error) {
      ordinaryError = error;
    }
    expect(ordinaryError).toBeInstanceOf(Error);

    const scoped = createConnectedAppActionTool(admission, {
      userId: "user-A",
      memoryAccessEnvelope: { memoryMode: "scope", writableNamespaces: ["namespace-A"] },
    } as unknown as ToolContext);
    let scopedError: unknown = null;
    try {
      await Promise.resolve(scoped.invoke({ query: "pilot" }));
    } catch (error) {
      scopedError = error;
    }
    expect(scopedError).toMatchObject({ message: "CONNECTED_APP_NAMESPACE_REQUIRED" });
    expect(execute).toHaveBeenCalledTimes(0);
  });

  test("uses the signed JSON Schema exactly, including closed inputs", () => {
    expect(admission.inputSchema.safeParse({ query: "pilot" }).success).toBe(true);
    expect(admission.inputSchema.safeParse({ query: "pilot", invented: true }).success).toBe(false);
  });
});
