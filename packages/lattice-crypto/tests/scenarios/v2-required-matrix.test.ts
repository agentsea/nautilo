import { describe, expect, test } from "bun:test";
import { v2ProviderMatrix } from "../../src/testing/v2-matrix.ts";
import { requiredV2Scenarios } from "../../playground/v2-scenarios.ts";

const requiredProviderSemantics = new Map<number, string>([
  [3, "human-add"],
  [4, "human-add"],
  [5, "human-remove"],
  [6, "human-add"],
  [7, "human-add"],
  [9, "device-add"],
  [10, "device-revoke"],
  [11, "human-add"],
  [26, "human-add"],
  [28, "device-revoke"],
  [29, "human-add"],
]);

const requiredScenarioEvidence = new Map<number, readonly string[]>([
  [1, [
    "fifty exact-set Namespace registrations must reuse one stored Domain",
    "exact-set Domain reuse must allocate only the first Domain",
  ]],
  [2, [
    "grant enumeration must emit one root per distinct covered Domain",
    "grant enumeration must preserve every covered Namespace",
  ]],
  [3, ["membership rebind must carry history and append a generation"]],
  [4, ["old generation must not open post-transition write"]],
  [5, ["retained generation must read history"]],
  [6, ["pre-transition grant must fail at a new Domain epoch"]],
  [7, ["fresh grant AI root must open retained and current generations"]],
  [8, ["AI root must never open Human keyring"]],
  [9, ["device add must preserve current Namespace generations"]],
  [10, [
    "device revoke must rotate every affected Namespace",
    "device revoke must rotate both key classes in every affected Namespace",
  ]],
  [11, ["one Room must rebind into the target Domain"]],
  [12, [
    "each same-Domain Namespace envelope must open its own object",
    "same-Domain Namespace envelope substitution must fail with the correct wrapping key",
  ]],
  [13, ["minted grant must not gain a newly eligible Domain"]],
  [14, [
    "one payload must remain readable through two differently bound Namespace envelopes",
    "M:N envelopes must be byte-distinct and reject cross-object substitution",
  ]],
  [15, ["detached envelope replay must fail against the current manifest"]],
  [16, ["binding rollback/fork substitution must fail"]],
  [17, ["4,096-generation ceiling must fail closed"]],
  [18, ["recovery must restore only the authorized Namespace inventory"]],
  [19, ["complete reference-store snapshot must contain no forbidden secret class"]],
  [20, ["fifty same-Domain Rooms must use one Runtime envelope"]],
  [21, ["Domain roots must not open manager-only Management material"]],
  [22, ["a remaining Runtime-authorizing edge must take the no-rotation path"]],
  [23, ["final-edge removal must create exactly one fresh Runtime generation"]],
  [24, [
    "missing device authorization must leave autonomous work pending",
    "denial must create no persistent server key",
  ]],
  [25, ["opaque handoff must create target Domain envelope"]],
  [26, ["retry must advance exactly once"]],
  [27, ["digest collision or hostile storage substitution must fail closed instead of aliasing exact participants"]],
  [28, ["historical binding and retained keyring must survive actual device revocation"]],
  [29, ["real Namespace rebind must leave stored payload and wrapped DEK byte-identical"]],
  [30, ["failed publication must leave no partial archive"]],
]);

describe("M225 required v2 scenario matrix", () => {
  test("contains the exact 30 numbered behaviors and three real providers", () => {
    expect(requiredV2Scenarios.map((scenario) => scenario.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
    expect(v2ProviderMatrix.map((provider) => provider.id)).toEqual([
      "dummy",
      "ts-mls",
      "openmls",
    ]);
    expect([...requiredScenarioEvidence.keys()]).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
  });

  for (const provider of v2ProviderMatrix) {
    for (const scenario of requiredV2Scenarios) {
      test(
        `${provider.id} #${scenario.id}: ${scenario.name}`,
        async () => {
          const result = await scenario.run(provider);
          expect(result.assertions).toBeGreaterThan(0);
          expect(result.providerTransitions).toBeGreaterThan(0);
          expect(result.scenarioAssertions).toBeGreaterThan(0);
          expect(result.scenarioEvidence).toHaveLength(
            result.scenarioAssertions,
          );
          expect(
            result.scenarioEvidence.every((label) => label.length > 0),
          ).toBe(true);
          for (
            const requiredEvidence
              of requiredScenarioEvidence.get(scenario.id) ?? []
          ) {
            expect(result.scenarioEvidence).toContain(requiredEvidence);
          }
          const requiredSemantic = requiredProviderSemantics.get(
            scenario.id,
          );
          if (requiredSemantic) {
            expect(result.scenarioEvidence).toContain(
              `provider:${provider.id}:${requiredSemantic}`,
            );
          }
        },
        60_000,
      );
    }
  }
});
