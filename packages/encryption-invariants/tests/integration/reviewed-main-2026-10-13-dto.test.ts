import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  REVIEWED_MAIN_2026_10_13_DTO_REPLACEMENTS,
  REVIEWED_MAIN_2026_10_13_NEW_DTO_DECLARATIONS,
  SUPERSEDED_MAIN_2026_10_13_DTO_LOCATORS,
} from "../../baseline/reviewed-main-2026-10-13-dto";
import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import {
  auditDtoDeclarations,
  discoverDtoInventory,
} from "../../src/node/dto-inventory";

const repoRoot = resolve(import.meta.dir, "../../../..");

const AVATAR_REPLY_REPLACEMENTS = new Map<string, readonly string[]>([
  ["http:request_response:GET /api/profile/avatar", []],
  ["http:request_response:GET /api/rooms/:id/agents/:agentId/avatar", [
    "request.params:{agentId:string;id:string}",
    "response.body:{error:string}",
  ]],
  ["http:request_response:GET /api/tasks/:id/agent/avatar", [
    "request.params:{id:string}",
    "response.body:{error:string}",
  ]],
  ["http:request_response:GET /api/users/:id/avatar", [
    "request.params:{id:string}",
    "response.body:{error:string}",
  ]],
]);

describe("current-main October 13 DTO review", () => {
  test("matches every exact changed and new declaration", async () => {
    expect(SUPERSEDED_MAIN_2026_10_13_DTO_LOCATORS.size).toBe(57);
    expect(REVIEWED_MAIN_2026_10_13_DTO_REPLACEMENTS).toHaveLength(57);
    expect(REVIEWED_MAIN_2026_10_13_NEW_DTO_DECLARATIONS).toHaveLength(36);

    const reviewedDeclarations = [
      ...REVIEWED_MAIN_2026_10_13_DTO_REPLACEMENTS,
      ...REVIEWED_MAIN_2026_10_13_NEW_DTO_DECLARATIONS,
    ];
    const locators = new Set(reviewedDeclarations.map((entry) => entry.locator));
    const declarations = DTO_BASELINE_DECLARATIONS.filter((entry) =>
      locators.has(entry.locator)
    );
    const observations = (await discoverDtoInventory(repoRoot)).filter((entry) =>
      locators.has(entry.locator)
    );
    const audit = auditDtoDeclarations({ observations, declarations });
    expect(audit.ok).toBe(true);
    if (!audit.ok) throw new Error(audit.errors.join("\n"));
    expect(audit.counts.observations).toBe(declarations.length);
    expect(audit.counts.declarations).toBe(declarations.length);
  }, 60_000);

  test("retires only the false Promise methods from avatar binary replies", () => {
    const replacements = new Map(
      REVIEWED_MAIN_2026_10_13_DTO_REPLACEMENTS.map((entry) => [entry.locator, entry]),
    );

    expect(AVATAR_REPLY_REPLACEMENTS.size).toBe(4);
    for (const [locator, structuralSignatures] of AVATAR_REPLY_REPLACEMENTS) {
      expect(SUPERSEDED_MAIN_2026_10_13_DTO_LOCATORS.has(locator)).toBe(true);
      expect(replacements.get(locator)).toMatchObject({
        locator,
        structuralSignatures,
        arbitraryPayloads: [],
      });
      expect(replacements.get(locator)?.structuralSignatures).not.toContain(
        "response.body:{catch:function;finally:function;then:function}",
      );
    }
  });

  test("closes only exact arbitrary leaves with parsers or frozen same-surface debt", () => {
    const replacements = new Map(
      REVIEWED_MAIN_2026_10_13_DTO_REPLACEMENTS.map((entry) => [entry.locator, entry]),
    );
    const newDeclarations = new Map(
      REVIEWED_MAIN_2026_10_13_NEW_DTO_DECLARATIONS.map((entry) => [entry.locator, entry]),
    );

    const newlyObservedLeaves = [
      ["http:request_response:POST /api/admin/server-models", "request.body", "parseUpdateBody"],
      ["http:request_response:PUT /api/security/posture", "request.body.localNetworkPolicy", "NetworkPolicySchema"],
      ...[
        "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest",
        "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage",
        "relay:server_to_client:relay:dispatch",
        "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage",
      ].flatMap((locator) => [
        [locator, "githubBinding", "parseRelayGitHubInvocationBinding"],
        [locator, "humanTerminalBinding.owner", "parseHumanTerminalOwner"],
        [locator, "localExecutionBinding.authority.delegation", "parseLocalExecutionDelegation"],
        [locator, "localExecutionDelegationCapture.source", "parseRelayLocalExecutionDelegationCapture"],
        [locator, "localExecutionDelegationCapture.source.target", "parseRelayLocalExecutionDelegationCapture"],
        [locator, "localExecutionHistoryBinding.reader", "parseRelayLocalExecutionHistoryBinding"],
      ]),
    ] as const;
    expect(newlyObservedLeaves).toHaveLength(26);
    for (const [locator, path, schema] of newlyObservedLeaves) {
      const decision = replacements.get(locator)?.arbitraryPayloads.find(
        (entry) => entry.path === path,
      );
      expect(decision).toEqual({ path, schema });
    }

    const namedRelaySchemas = new Map<string, Readonly<Record<string, string>>>([
      ["relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayHumanTerminalBinding", {
        owner: "parseHumanTerminalOwner",
      }],
      ["relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionBinding", {
        "authority.delegation": "parseLocalExecutionDelegation",
      }],
      ["relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionBindingV4", {
        "authority.delegation": "parseLocalExecutionDelegation",
      }],
      ["relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionDelegationCapture", {
        source: "parseRelayLocalExecutionDelegationCapture",
        "source.target": "parseRelayLocalExecutionDelegationCapture",
      }],
      ["relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionHistoryBindingV1", {
        reader: "parseRelayLocalExecutionHistoryBinding",
      }],
    ]);
    for (const [locator, expected] of namedRelaySchemas) {
      const decisions = newDeclarations.get(locator)?.arbitraryPayloads ?? [];
      expect(Object.fromEntries(decisions.map((entry) => [entry.path,
        "schema" in entry ? entry.schema : null]))).toEqual(expected);
    }

    expect(newDeclarations.get("http:request_response:POST /api/moderation/actions")?.arbitraryPayloads)
      .toEqual([{ path: "request.body", schema: "normalizeModerationCommand" }]);

    for (const declaration of [...replacements.values(), ...newDeclarations.values()]) {
      expect(declaration.arbitraryPayloads.every((entry) =>
        !entry.path.includes("*") && !entry.path.startsWith(".")
      )).toBe(true);
    }
  });
});
