import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SetupStatusResponse } from "@nautilo/api-client/browser";
import type { RoomMemberDto } from "@nautilo/types";
import {
  ProviderSetupEmptyState,
  shouldShowProviderSetupEmptyState,
} from "../../src/components/provider-setup-empty-state";

const missingProvider: SetupStatusResponse = {
  instanceId: "inst-test",
  serverUrl: "https://server.example",
  deploymentMode: "server",
  claimRequired: false,
  setupState: "server-needs-keys",
  providers: { hasLlm: false, managedByCloud: false },
  recommendedSetupSurface: { kind: "workbench-admin", url: "/admin#provider-credentials" },
};

const ready: SetupStatusResponse = {
  ...missingProvider,
  setupState: "ready",
  providers: { hasLlm: true, managedByCloud: false },
};

const agent = { actorId: "agent", kind: "agent", displayName: "Genie", roomRole: "member" } as RoomMemberDto;
const human = { actorId: "human", kind: "user", displayName: "Ada", roomRole: "member" } as RoomMemberDto;

describe("provider setup empty state", () => {
  test("appears only on model-dependent chat surfaces", () => {
    expect(shouldShowProviderSetupEmptyState(missingProvider, [])).toBe(true);
    expect(shouldShowProviderSetupEmptyState(missingProvider, [agent])).toBe(true);
    expect(shouldShowProviderSetupEmptyState(missingProvider, [human])).toBe(false);
    expect(shouldShowProviderSetupEmptyState(ready, [agent])).toBe(false);
    expect(shouldShowProviderSetupEmptyState(null, [agent])).toBe(false);
  });

  test("authorized administrators get both bounded setup actions", () => {
    const html = renderToStaticMarkup(<ProviderSetupEmptyState canManageProviders />);
    expect(html).toContain("Models aren’t configured yet");
    expect(html).toContain("API Keys");
    expect(html).toContain('href="/admin#provider-credentials"');
    expect(html).toContain("Open Server Guide");
    expect(html).toContain('href="/help/server"');
    expect(html).toContain("Everything else in Nautilo remains available");
    expect(html).not.toContain("Provider keys required");
  });

  test("other users receive clear administrator-contact copy without management actions", () => {
    const html = renderToStaticMarkup(<ProviderSetupEmptyState canManageProviders={false} />);
    expect(html).toContain("Ask your server administrator");
    expect(html).not.toContain("API Keys");
    expect(html).not.toContain("Open Server Guide");
    expect(html).not.toContain("server.example");
  });
});
