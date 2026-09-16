import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  canonicalConnectionProviderCatalogSigningPayloadV1,
  type ConnectionProviderCatalog,
} from "@nautilo/types";
import { ToolCatalog } from "@nautilo/catalog";
import {
  BUNDLED_CONNECTION_PROVIDER_CATALOG,
  loadConnectionProviderCatalog,
} from "../../src/connected-apps/catalog";
import {
  compileConnectedAppOperationAdmissions,
  syncConnectedAppOperationTools,
} from "@nautilo/agent";

const VERSION = "2026.08.31.99";
const KEY_ID = "test-key";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const TRUSTED_KEYS = {
  [KEY_ID]: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
};

function signed(catalog: ConnectionProviderCatalog): { pointer: string; artifact: string } {
  const artifact = `${JSON.stringify(catalog)}\n`;
  const artifactSha256 = createHash("sha256").update(artifact, "utf8").digest("hex");
  const signature = sign(
    null,
    Buffer.from(canonicalConnectionProviderCatalogSigningPayloadV1(VERSION, artifactSha256)),
    privateKey,
  ).toString("base64");
  return {
    artifact,
    pointer: JSON.stringify({ catalogVersion: VERSION, artifactSha256, signature, signingKeyId: KEY_ID }),
  };
}

function catalogFetch(pointer: string, artifact: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    return new Response(url.endsWith("latest.json") ? pointer : artifact, {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function candidate(): ConnectionProviderCatalog {
  const slack = structuredClone(BUNDLED_CONNECTION_PROVIDER_CATALOG.providers
    .find((provider) => provider.id === "slack")!);
  slack.lifecycle = "available";
  const seedOperation = structuredClone(slack.operations[0]!);
  seedOperation.toolName = "fixture_list_items";
  seedOperation.sourceActionId = "fixture.list_items";
  const fixture = {
    ...structuredClone(slack),
    id: "fixture",
    displayName: "Fixture App",
    description: "A signed fixture provider used to prove catalog-only delivery.",
    searchTerms: ["fixture", "catalog"],
    iconUrl: "https://media.nautilo.ai/connections/icons/fixture.svg",
    shortMark: "F",
    sortOrder: 40,
    service: "fixture",
    operations: [seedOperation],
  };
  return {
    ...structuredClone(BUNDLED_CONNECTION_PROVIDER_CATALOG),
    catalogVersion: VERSION,
    publishedAt: "2026-08-31T12:00:00Z",
    providers: [slack, fixture],
  };
}

describe("D456 signed connection provider catalog", () => {
  test("projects the complete reviewed packs with exact names and signed policy metadata", () => {
    const counts = Object.fromEntries(BUNDLED_CONNECTION_PROVIDER_CATALOG.providers.map((provider) => [
      provider.id,
      provider.operations.length,
    ]));
    expect(counts).toEqual({ notion: 25, slack: 23, canva: 13, airtable: 14, dropbox: 24 });
    const admissions = compileConnectedAppOperationAdmissions(BUNDLED_CONNECTION_PROVIDER_CATALOG.providers);
    expect(admissions).toHaveLength(99);
    expect(new Set(admissions.map((admission) => admission.toolName)).size).toBe(99);
    const toolCatalog = new ToolCatalog();
    expect(syncConnectedAppOperationTools(toolCatalog, BUNDLED_CONNECTION_PROVIDER_CATALOG.providers))
      .toEqual(admissions.map((admission) => admission.toolName));
    const allNames = admissions.map((admission) => admission.toolName);
    expect(toolCatalog.resolveProgressiveTools({
      context: { connectedAppProviderIds: [] },
      activatedToolNames: allNames,
    }).tools).toHaveLength(0);
    expect(toolCatalog.resolveProgressiveTools({
      context: { connectedAppProviderIds: ["notion", "slack", "canva", "airtable", "dropbox"] },
      activatedToolNames: allNames,
    }).tools.map((tool) => tool.name)).toEqual(allNames);
    const canvaNames = admissions
      .filter((admission) => admission.providerId === "canva")
      .map((admission) => admission.toolName);
    expect(toolCatalog.resolveProgressiveTools({
      context: { connectedAppProviderIds: ["canva"] },
      activatedToolNames: allNames,
    }).tools.map((tool) => tool.name)).toEqual(canvaNames);
    const dropboxUpload = admissions.find((admission) => admission.toolName === "dropbox_upload_file");
    expect(dropboxUpload?.artifactInput).toEqual({
      kind: "workspace_artifact_to_transit_file",
      modelField: "artifactPath",
      providerField: "file",
    });
    expect(dropboxUpload?.inputSchema.safeParse({
      path: "/Nautilo/brief.pdf",
      artifactPath: "/brief.pdf",
    }).success).toBe(true);
    expect(dropboxUpload?.inputSchema.safeParse({
      path: "/Nautilo/brief.pdf",
      file: { fileId: `${"a".repeat(32)}.pdf` },
    }).success).toBe(false);
    expect(dropboxUpload?.inputSchema.safeParse({
      path: "/Nautilo/brief.pdf",
      contentBase64: "JVBERg==",
    }).success).toBe(false);
    for (const admission of admissions) {
      const operation = BUNDLED_CONNECTION_PROVIDER_CATALOG.providers
        .find((provider) => provider.id === admission.providerId)!
        .operations.find((candidate) => candidate.sourceActionId === admission.sourceActionId)!;
      expect(admission).toMatchObject({
        category: operation.category,
        discoveryCategories: operation.discoveryCategories,
        impact: operation.impact,
        requiresApproval: operation.requiresApproval,
      });
      expect(admission.approvalLevel).toBe(operation.approvalLevel);
    }
  });

  test("accepts a signed generic release without resurrecting omitted bundled apps", async () => {
    const release = signed(candidate());
    const resolved = await loadConnectionProviderCatalog(
      catalogFetch(release.pointer, release.artifact),
      TRUSTED_KEYS,
    );
    expect(resolved.source).toBe("remote");
    expect(resolved.catalog.providers.map((provider) => provider.id)).toEqual(["slack", "fixture"]);
    expect(resolved.catalog.providers[0]?.lifecycle).toBe("available");
  });

  test("fails closed to the bundled catalog when the signed artifact is altered", async () => {
    const release = signed(candidate());
    const resolved = await loadConnectionProviderCatalog(
      catalogFetch(release.pointer, release.artifact.replace("Fixture App", "Planted")),
      TRUSTED_KEYS,
    );
    expect(resolved.source).toBe("bundled");
    expect(resolved.catalog).toEqual(BUNDLED_CONNECTION_PROVIDER_CATALOG);
    expect(resolved.reason).toBe("connection catalog artifact hash rejected");
  });

  test("rejects tool-name collisions before activating a signed candidate", async () => {
    const invalid = candidate();
    invalid.providers[1]!.operations[0]!.toolName = invalid.providers[0]!.operations[0]!.toolName;
    const release = signed(invalid);
    const resolved = await loadConnectionProviderCatalog(
      catalogFetch(release.pointer, release.artifact),
      TRUSTED_KEYS,
    );
    expect(resolved.source).toBe("bundled");
    expect(resolved.reason).toContain("tool names must be unique");
  });
});
