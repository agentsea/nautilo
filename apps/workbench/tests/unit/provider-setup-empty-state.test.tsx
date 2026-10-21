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

  test("personal missing-key guidance distinguishes server-funding permission", () => {
    const community = renderToStaticMarkup(
      <ProviderSetupEmptyState
        canManageProviders={false}
        canUseServerKeys={false}
        personalState="missing-key"
      />,
    );
    expect(community).toContain("account currently requires its own provider key");
    expect(community).toContain("ask an administrator for server-funded access");
    expect(community).toContain('href="/settings#personal-provider-keys"');
    expect(community).not.toContain('href="/admin#provider-credentials"');

    const serverFunded = renderToStaticMarkup(
      <ProviderSetupEmptyState
        canManageProviders={false}
        canUseServerKeys
        personalState="missing-key"
      />,
    );
    expect(serverFunded).toContain("Add one of your provider keys in Settings");
    expect(serverFunded).not.toContain("account currently requires its own provider key");

    const unknown = renderToStaticMarkup(
      <ProviderSetupEmptyState canManageProviders={false} personalState="missing-key" />,
    );
    expect(unknown).toContain("Add one of your provider keys in Settings");
    expect(unknown).not.toContain("account currently requires its own provider key");
  });
});
