import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import {
  REVIEWED_MAIN_2026_09_17_NEW_DTO_DECLARATIONS,
  SUPERSEDED_MAIN_2026_09_17_DTO_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-17-dto";
import {
  auditDtoDeclarations,
  discoverDtoInventory,
} from "../../src/node/dto-inventory";

const repoRoot = resolve(import.meta.dir, "../../../..");

describe("current-main September 17 DTO review", () => {
  test("matches all changed and new structural snapshots", async () => {
    expect(SUPERSEDED_MAIN_2026_09_17_DTO_LOCATORS.size).toBe(18);
    expect(REVIEWED_MAIN_2026_09_17_NEW_DTO_DECLARATIONS).toHaveLength(5);

    const reviewedLocators = new Set([
      ...SUPERSEDED_MAIN_2026_09_17_DTO_LOCATORS,
      ...REVIEWED_MAIN_2026_09_17_NEW_DTO_DECLARATIONS.map(
        (declaration) => declaration.locator,
      ),
    ]);
    const declarations = DTO_BASELINE_DECLARATIONS.filter((declaration) =>
      reviewedLocators.has(declaration.locator)
    );
    const observations = (await discoverDtoInventory(repoRoot)).filter(
      (observation) => reviewedLocators.has(observation.locator),
    );

    expect(declarations).toHaveLength(23);
    expect(auditDtoDeclarations({ observations, declarations })).toEqual({
      ok: true,
      counts: {
        observations: 23,
        declarations: 23,
        arbitraryPayloads: declarations.reduce(
          (count, declaration) => count + declaration.arbitraryPayloads.length,
          0,
        ),
      },
    });
  }, 60_000);

  test("binds newly open leaves only to their actual validators", async () => {
    const declaration = (locator: string) =>
      DTO_BASELINE_DECLARATIONS.find((entry) => entry.locator === locator);

    expect(declaration(
      "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#VideoMediaPickResult",
    )?.arbitraryPayloads).toEqual([
      { path: "imports[]", schema: "isSafeVideoWorkspaceImportResult" },
    ]);
    expect(declaration(
      "http:request_response:POST /api/apps/:appId/live-session/prepare",
    )?.arbitraryPayloads).toEqual([
      { path: "request.body.clientSessionId", schema: "uuid-v4" },
    ]);
    expect(declaration(
      "http:request_response:POST /api/apps/:appId/live-session/revoke",
    )?.arbitraryPayloads).toContainEqual({
      path: "request.body.clientSessionId",
      schema: "uuid-v4",
    });
    expect(declaration(
      "http:request_response:PUT /api/event-feed/preference",
    )?.arbitraryPayloads).toEqual([
      { path: "request.body", schema: "eventFeedPreferenceSchema" },
    ]);

    const bridgeSource = await Bun.file(resolve(
      repoRoot,
      "apps/workbench/src/apps/app-bridge.ts",
    )).text();
    expect(bridgeSource).toContain(
      "result.imports.every(isSafeVideoWorkspaceImportResult)",
    );
    const preferenceSource = await Bun.file(resolve(
      repoRoot,
      "packages/server/src/routes/event-feed-preferences.ts",
    )).text();
    expect(preferenceSource).toContain(
      "eventFeedPreferenceSchema.safeParse(request.body)",
    );
    const appRoutesSource = await Bun.file(resolve(
      repoRoot,
      "packages/server/src/apps/app-routes.ts",
    )).text();
    expect(appRoutesSource).toContain(
      "/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientSessionId)",
    );
  });

  test("records the reviewed contract semantics without changing prior open-path decisions", () => {
    const signatures = (locator: string) =>
      DTO_BASELINE_DECLARATIONS.find((entry) => entry.locator === locator)
        ?.structuralSignatures?.join("\n") ?? "";

    expect(signatures(
      "http:accepted_arbitrary:packages/types/src/api.ts#ActiveMiniAppRequestContext",
    )).toContain("mode?:\"edit\"|\"preview\"");
    expect(signatures(
      "http:request_response:GET /api/connected-web-operations/:operationId",
    )).toContain(
      "provenance:\"authenticated_website\"|\"public_website\"|\"user_connected_website\"",
    );
    expect(signatures(
      "http:request_response:POST /api/video-generations/prepare",
    )).toContain("referenceAudios?:");
    expect(signatures(
      "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeRequest",
    )).toContain("purpose:\"media\"|\"references\"");

    const bridgeOptions = DTO_BASELINE_DECLARATIONS.find((entry) =>
      entry.locator.endsWith("#AppBridgeOptions")
    );
    expect(bridgeOptions?.arbitraryPayloads).toContainEqual({
      path: "documentSession.documentReadPromise",
      debtId: "debt.wire.arbitrary.1pjbi6v",
    });
    expect(bridgeOptions?.arbitraryPayloads).toContainEqual({
      path: "recovery",
      schema: "AppDraftRecoveryPort",
    });
  });
});
