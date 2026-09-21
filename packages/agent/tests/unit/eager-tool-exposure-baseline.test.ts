import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { setConfigOverrides } from "@nautilo/config";
import { buildGuestToolPolicy, type ToolAccess } from "@nautilo/trust";
import { expandToolFamilies } from "../../src/tools/exposure/manifest";
import {
  measureProgressiveToolExposure,
  selectIntentPackToolsForTelemetry,
  type ToolExposureTelemetry,
} from "../../src/tools/exposure/telemetry";
import { activeComputerUseHostToolDefinitions } from "../../src/config/computer-use-catalogue/host-tool-admission";
import { registerAllTools } from "../../src/tools/register-all";

let catalog: ToolCatalog;
const ORIGINAL_TAVILY_API_KEY = process.env["TAVILY_API_KEY"];

beforeAll(() => {
  setConfigOverrides({ nautilo_office_enabled: false });
  process.env["TAVILY_API_KEY"] = "test-key";
  catalog = new ToolCatalog();
  registerAllTools(catalog, {
    officeCliAvailable: () => true,
    mediaGenerationAvailable: () => true,
    publicBrowserUseAvailable: () => true,
    decisionModelsAvailable: () => true,
  });
});

afterAll(() => {
  if (ORIGINAL_TAVILY_API_KEY !== undefined) process.env["TAVILY_API_KEY"] = ORIGINAL_TAVILY_API_KEY;
  else delete process.env["TAVILY_API_KEY"];
});

type Fixture = {
  actorRole: string;
  toolPolicy?: Readonly<Record<string, string>>;
  relayCapabilities?: Readonly<Record<string, boolean>>;
  context?: { deepResearchForegroundAvailable: boolean };
};

function eagerBaselineFor({ actorRole, toolPolicy, relayCapabilities, context }: Fixture): ToolExposureTelemetry {
  const toolContext = { actorRole, turnId: "synthetic-baseline", fullEncryptionOnly: false, ...context };
  const eligible = catalog.getFiltered(toolPolicy, relayCapabilities, { context: toolContext });
  const tools = catalog.getToolsForActor(toolContext, toolPolicy, relayCapabilities);
  return measureProgressiveToolExposure({
    registeredCatalogTools: catalog.size,
    eligibleEntries: eligible.entries,
    exclusionReasons: eligible.exclusions.map((exclusion) => exclusion.reason),
    tools,
  });
}

function progressiveFixture(
  activatedToolNames: readonly string[] = [],
  intentPackToolNames: readonly string[] = [],
  activatedToolLeases: readonly { name: string }[] = [],
): ToolExposureTelemetry {
  const resolution = catalog.resolveProgressiveTools({
    relayCapabilities: fullRelayCapabilities(),
    activatedToolNames,
    intentPackToolNames,
  });
  return measureProgressiveToolExposure({
    registeredCatalogTools: catalog.size,
    eligibleEntries: resolution.eligible.entries,
    exclusionReasons: resolution.snapshot.exclusions.map((exclusion) => exclusion.reason),
    activatedToolNames,
    activatedToolLeases,
    intentPackToolNames,
    tools: resolution.tools,
  });
}

function guestPolicy(): Record<string, ToolAccess> {
  return buildGuestToolPolicy();
}

function fullRelayCapabilities(): Record<string, boolean> {
  const capabilities: Record<string, boolean> = {};
  for (const entry of catalog.query({})) {
    for (const capability of entry.requiredCapabilities) {
      capabilities[capability] = true;
    }
    for (const capability of entry.relayCapabilities ?? []) {
      capabilities[capability] = true;
    }
  }
  return capabilities;
}

describe("progressive tool exposure telemetry", () => {
  test("measures aggregate-only eager baseline contexts", () => {
    const guest = eagerBaselineFor({
      actorRole: "guest",
      toolPolicy: guestPolicy(),
    });
    const ownerNoRelay = eagerBaselineFor({ actorRole: "owner" });
    const ownerFullRelay = eagerBaselineFor({
      actorRole: "owner",
      relayCapabilities: fullRelayCapabilities(),
      context: { deepResearchForegroundAvailable: true },
    });

    for (const baseline of [guest, ownerNoRelay, ownerFullRelay]) {
      expect(baseline.registeredCatalogTools).toBe(catalog.size);
      expect(baseline.promptSchemas).toBe(baseline.providerSchemas);
      expect(baseline.descriptionChars).toBeGreaterThan(0);
      expect(baseline.serializedSchemaChars).toBeGreaterThan(0);
      expect(baseline.descriptionEstimatedTokens).toBe(Math.ceil(baseline.descriptionChars / 4));
      expect(baseline.serializedSchemaEstimatedTokens).toBe(
        Math.ceil(baseline.serializedSchemaChars / 4),
      );
    }

    expect(guest.eligibleTools).toBeLessThan(ownerNoRelay.eligibleTools);
    expect(ownerNoRelay.eligibleTools).toBeLessThan(ownerFullRelay.eligibleTools);
    expect(ownerFullRelay.eligibleTools).toBe(catalog.size);
  });

  test("keeps routine owner core exposure bounded and materially below eager schemas", () => {
    const eager = eagerBaselineFor({
      actorRole: "owner",
      relayCapabilities: fullRelayCapabilities(),
    });
    const coreOnly = progressiveFixture();
    const filesystemPack = progressiveFixture(
      expandToolFamilies(["filesystem"]),
      expandToolFamilies(["filesystem"]),
    );

    // The core-growth gate includes all 21 embedded-browser tools.
    // The static baseline is 48, including run_website_task, public browse_web and the connected-website reader
    // and its immediately available supervision and direct-control tools.
    // Computer Use core tools are supplied only by
    // the active signed catalogue, so this guard derives their count instead
    // of compiling a second operation list.
    expect(coreOnly.coreTools).toBe(48 + activeComputerUseHostToolDefinitions().length);
    expect(coreOnly.promptSchemas).toBe(coreOnly.providerSchemas);
    expect(filesystemPack.intentPackTools).toBeGreaterThan(0);
    expect(filesystemPack.activatedTools).toBe(filesystemPack.intentPackTools);
    expect(filesystemPack.retainedTools).toBe(0);

    // Core-only and representative intent packs must remain meaningfully below
    // the eager full-relay baseline, otherwise progressive exposure regressed.
    expect(coreOnly.serializedSchemaEstimatedTokens).toBeLessThan(
      eager.serializedSchemaEstimatedTokens,
    );
    for (const pack of [filesystemPack]) {
      expect(pack.serializedSchemaEstimatedTokens * 4).toBeLessThan(
        eager.serializedSchemaEstimatedTokens * 3,
      );
    }
  });

  test("aggregates exclusion categories without retaining sensitive identifiers", () => {
    const telemetry = measureProgressiveToolExposure({
      registeredCatalogTools: 3,
      eligibleEntries: [{ name: "core_tool", exposure: "core" }],
      exclusionReasons: [
        'namespace "private-namespace-123" not readable by actor',
        'requires relay capability "machine-control" not available',
        "forbidden by actor toolPolicy",
      ],
      tools: [],
    });

    expect(telemetry.exclusionReasons).toEqual({
      namespace_unreadable: 1,
      relay_capability_missing: 1,
      policy_forbidden: 1,
    });
    expect(JSON.stringify(telemetry)).not.toContain("private-namespace-123");
    expect(JSON.stringify(telemetry)).not.toContain("machine-control");
  });

  test("counts only eligible selected tools that have live leases", () => {
    const telemetry = measureProgressiveToolExposure({
      registeredCatalogTools: 4,
      eligibleEntries: [
        { name: "core_tool", exposure: "core" },
        { name: "retained_tool", exposure: "discoverable" },
        { name: "intent_only", exposure: "discoverable" },
      ],
      exclusionReasons: [],
      activatedToolNames: ["retained_tool", "intent_only", "ineligible_lease"],
      activatedToolLeases: [
        { name: "retained_tool" },
        { name: "ineligible_lease" },
      ],
      intentPackToolNames: ["intent_only"],
      tools: [],
    });

    expect(telemetry.activatedTools).toBe(2);
    expect(telemetry.intentPackTools).toBe(1);
    expect(telemetry.retainedTools).toBe(1);
    expect(JSON.stringify(telemetry)).not.toContain("retained_tool");
    expect(JSON.stringify(telemetry)).not.toContain("intent_only");
    expect(JSON.stringify(telemetry)).not.toContain("ineligible_lease");
  });

  test("counts intent only when it survived the bound activation projection", () => {
    expect(selectIntentPackToolsForTelemetry(
      ["browser_click", "file"],
      ["file", "retained_tool"],
    )).toEqual(["file"]);
    expect(selectIntentPackToolsForTelemetry(["file"], [])).toEqual([]);
  });

  test("keeps guest and eager projections aggregate-only and count-stable", () => {
    const guest = measureProgressiveToolExposure({
      registeredCatalogTools: 2,
      eligibleEntries: [{ name: "core_tool", exposure: "core" }],
      exclusionReasons: [],
      // A guest supplies the empty actor-safe selection even if the shared
      // checkpoint has owner leases.
      activatedToolNames: [],
      activatedToolLeases: [{ name: "owner_retained_tool" }],
      tools: [],
    });
    const eager = eagerBaselineFor({
      actorRole: "owner",
      relayCapabilities: fullRelayCapabilities(),
    });

    expect(guest.retainedTools).toBe(0);
    expect(eager.retainedTools).toBe(0);
    expect(eager.promptSchemas).toBe(eager.providerSchemas);
  });
});
