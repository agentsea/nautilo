import { describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import type { ConnectionProviderDescriptor } from "@nautilo/types";
import {
  syncConnectedAppOperationTools,
} from "../../src/index";

function provider(
  lifecycle: ConnectionProviderDescriptor["lifecycle"],
  id = "fixture",
): ConnectionProviderDescriptor {
  const operation = {
    toolName: `${id}_search`,
    sourceActionId: `${id}.search`,
    label: "Search",
    description: "Search fixture content.",
    tags: [id, "search"],
    category: "knowledge" as const,
    discoveryCategories: ["integrations" as const],
    impact: "read-only" as const,
    effect: "read" as const,
    requiresApproval: false,
    sourceSchemaSha256: "a".repeat(64),
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: false },
  };
  return {
    id,
    displayName: "Fixture App",
    description: "A fixture connected app.",
    searchTerms: ["fixture"],
    iconUrl: "https://media.nautilo.ai/connections/icons/fixture.svg",
    shortMark: "F",
    sortOrder: 10,
    lifecycle,
    defaultEnabled: false,
    service: id,
    supportedDrivers: ["openconnector_local"],
    setup: {
      kind: "oauth_client",
      providerSetupUrl: "https://provider.example/apps",
      scopes: ["read"],
      acceptsAdminToken: true,
    },
    operations: [operation],
  };
}

describe("D456 signed connected-app ToolCatalog projection", () => {
  test("adds, promotes, disables, and withdraws catalog tools without duplicate registration", () => {
    const catalog = new ToolCatalog();
    expect(syncConnectedAppOperationTools(catalog, [provider("pilot")])).toEqual(["fixture_search"]);
    expect(catalog.has("fixture_search")).toBe(true);
    expect(catalog.get("fixture_search")).toMatchObject({
      connectedAppProviderId: "fixture",
      category: "knowledge",
      discoveryCategories: ["integrations"],
      impact: "read-only",
      approvalLevel: undefined,
    });
    const firstGeneration = catalog.currentGeneration;

    expect(syncConnectedAppOperationTools(catalog, [provider("available")])).toEqual(["fixture_search"]);
    expect(catalog.has("fixture_search")).toBe(true);
    expect(catalog.currentGeneration).toBeGreaterThan(firstGeneration);

    expect(syncConnectedAppOperationTools(catalog, [provider("disabled")])).toEqual([]);
    expect(catalog.has("fixture_search")).toBe(false);

    expect(syncConnectedAppOperationTools(catalog, [provider("withdrawn")])).toEqual([]);
    expect(catalog.has("fixture_search")).toBe(false);
  });

  test("rejects a collision with an unrelated local tool before mutating the active projection", () => {
    const catalog = new ToolCatalog();
    syncConnectedAppOperationTools(catalog, [provider("pilot")]);
    catalog.register({
      name: "collision_search",
      factory: () => ({ description: "Unrelated tool." }) as never,
      category: "documents",
      trustTier: "standard",
      impact: "read-only",
    });
    expect(() => syncConnectedAppOperationTools(catalog, [provider("available", "collision")]))
      .toThrow("connected app tool collides with existing tool: collision_search");
    expect(catalog.has("fixture_search")).toBe(true);
    expect(catalog.has("collision_search")).toBe(true);
  });
});
