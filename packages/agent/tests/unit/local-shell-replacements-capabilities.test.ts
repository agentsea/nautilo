import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { buildRuntimeCapabilityTokens } from "../../src/runtime/relay-capabilities";
import { registerAllTools } from "../../src/tools/register-all";
import type { ToolRelayRegistry } from "../../src/nodes/tools";

beforeEach(() => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog, { decisionModelsAvailable: () => true });
  initToolCatalog(catalog);
});
afterEach(() => clearToolCatalog());

describe("retired local brokers", () => {
  test("are absent from the catalog while retained shell output remains selectable", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { decisionModelsAvailable: () => true });
    expect(catalog.get("local_git")).toBeUndefined();
    expect(catalog.get("local_github")).toBeUndefined();

    const capabilities = {
      profile: "desktop-agent",
      canReadShellOutput: true,
      canUseLocalGit: true,
      localGit: { version: 1 },
      canUseGitHub: true,
      github: { version: 1 },
    } as never;
    const registry = {
      findByCapabilityForUser: () => ["desktop"],
      getCapabilities: () => capabilities,
      getProtocolVersion: () => 29,
      getUserId: () => "human",
    } as unknown as ToolRelayRegistry;
    expect(buildRuntimeCapabilityTokens(registry, "human", undefined, "desktop")).toMatchObject({ canReadShellOutput: true });
    expect(buildRuntimeCapabilityTokens(registry, "human", undefined, "desktop")).not.toHaveProperty("canUseLocalGit");
    expect(buildRuntimeCapabilityTokens(registry, "human", undefined, "desktop")).not.toHaveProperty("canUseGitHub");
  });
});
