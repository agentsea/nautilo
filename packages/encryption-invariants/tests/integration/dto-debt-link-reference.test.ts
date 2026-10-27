import { describe, expect, test } from "bun:test";

import { dtoDebtReferenceErrors } from "../../src/node/repository-inventory";
import type { DtoDeclaration } from "../../src/node/dto-inventory";
import {
  auditCoverageRegistry,
  reviewedDebtLinkErrors,
  type CoverageRegistry,
  type ReviewedDebtLink,
} from "../../src/registry";

const route = "http:request_response:POST /api/example";
const path = "request.query.purpose";
const leaf = `${route}#${path}`;
const debt = {
  id: "debt.wire.example.request",
  surface: "wire",
  locator: route,
  owner: "packages/server",
  reason: "The frozen request boundary still accepts ordinary plaintext content.",
  remediationState: "untriaged",
  releaseImpact: "blocks_whole_product_claim",
  evidenceGap: "No protected request representation has been implemented yet.",
} as const;
const declaration = {
  observationId: "wire.http.example",
  locator: route,
  structuralSignatures: ["request.query:{purpose?:unknown}"],
  arbitraryPayloads: [{ path, debtId: debt.id }],
} as const satisfies DtoDeclaration;
const link = {
  id: "ci.wire.example-purpose",
  surface: "wire",
  locator: leaf,
  owner: "packages/server",
  targetDebtIds: [debt.id],
  reason: "The exact purpose leaf is part of the same frozen request boundary.",
  testEvidence: [
    "packages/encryption-invariants/tests/integration/dto-debt-link-reference.test.ts",
  ],
} as const satisfies ReviewedDebtLink;

function registry(input: {
  readonly debt?: CoverageRegistry["debt"];
  readonly links?: readonly ReviewedDebtLink[];
  readonly retired?: CoverageRegistry["retiredFrozenDebt"];
} = {}): CoverageRegistry {
  return {
    entries: [],
    debt: input.debt ?? [debt],
    reviewedDebtLinks: input.links ?? [],
    ...(input.retired ? { retiredFrozenDebt: input.retired } : {}),
    exceptions: [],
  };
}

const expectedMismatch =
  `${route}: arbitrary payload ${path} references debt ${debt.id} at ${route}; expected ${leaf}`;

describe("DTO debt references through reviewed links", () => {
  test("preserves direct exact-leaf debt and schema-backed declarations", () => {
    const directDebt = { ...debt, locator: leaf };
    expect(dtoDebtReferenceErrors(
      registry({ debt: [directDebt] }),
      [declaration],
      [],
    )).toEqual([]);

    const schemaDeclaration = {
      ...declaration,
      arbitraryPayloads: [{ path, schema: "PurposeMetadataV1" }],
    } as const satisfies DtoDeclaration;
    expect(dtoDebtReferenceErrors(registry(), [schemaDeclaration], [])).toEqual([]);
  });

  test("accepts only an exact singleton link to the exact frozen wire debt", () => {
    const current = registry({ links: [link] });
    expect(dtoDebtReferenceErrors(current, [declaration], [debt])).toEqual([]);
    expect(reviewedDebtLinkErrors(current, [debt])).toEqual([]);
  });

  test.each([
    ["missing", []],
    ["route root", [{ ...link, locator: route }]],
    ["sibling leaf", [{ ...link, locator: `${route}#request.query.other` }]],
  ] as const)("rejects a %s reviewed link", (_label, links) => {
    expect(dtoDebtReferenceErrors(
      registry({ links }),
      [declaration],
      [debt],
    )).toEqual([expectedMismatch]);
  });

  test("rejects wrong and additional reviewed targets", () => {
    const otherDebt = {
      ...debt,
      id: "debt.wire.other.request",
      locator: "http:request_response:POST /api/other",
    } as const;
    for (const targetDebtIds of [
      [otherDebt.id],
      [debt.id, otherDebt.id],
    ] as const) {
      expect(dtoDebtReferenceErrors(
        registry({
          debt: [debt, otherDebt],
          links: [{ ...link, targetDebtIds }],
        }),
        [declaration],
        [debt, otherDebt],
      )).toEqual([expectedMismatch]);
    }
  });

  test("rejects missing and current-but-unfrozen target debt", () => {
    expect(dtoDebtReferenceErrors(
      registry({ debt: [], links: [link] }),
      [declaration],
      [],
    )).toEqual([
      `${route}: arbitrary payload references missing debt ${debt.id}`,
    ]);
    expect(dtoDebtReferenceErrors(
      registry({ links: [link] }),
      [declaration],
      [],
    )).toEqual([expectedMismatch]);
    expect(dtoDebtReferenceErrors(
      registry({ links: [link] }),
      [declaration],
      [{ ...debt, locator: "http:request_response:POST /api/other" }],
    )).toEqual([expectedMismatch]);
  });

  test("rejects non-wire and retired frozen targets", () => {
    const processorDebt = { ...debt, surface: "processor" } as const;
    expect(dtoDebtReferenceErrors(
      registry({ links: [{ ...link, surface: "processor" }] }),
      [declaration],
      [debt],
    )).toEqual([expectedMismatch]);
    expect(dtoDebtReferenceErrors(
      registry({ debt: [processorDebt], links: [link] }),
      [declaration],
      [processorDebt],
    )).toEqual([expectedMismatch]);

    expect(dtoDebtReferenceErrors(
      registry({
        links: [link],
        retired: [{
          debtId: debt.id,
          reason: "The exact frozen request observation no longer exists.",
          testEvidence: [
            "packages/encryption-invariants/tests/integration/dto-debt-link-reference.test.ts",
          ],
        }],
      }),
      [declaration],
      [debt],
    )).toEqual([expectedMismatch]);
  });

  test("rejects ambiguous links and combined verification blocks malformed evidence", () => {
    const ambiguous = registry({
      links: [link, { ...link, id: "ci.wire.example-purpose-duplicate" }],
    });
    expect(dtoDebtReferenceErrors(ambiguous, [declaration], [debt])).toEqual([
      expectedMismatch,
    ]);
    const ambiguousAudit = auditCoverageRegistry(ambiguous);
    expect(ambiguousAudit.ok).toBe(false);
    expect(ambiguousAudit.ok ? [] : ambiguousAudit.errors).toContain(
      `duplicate reviewed debt link locator: ${leaf}`,
    );

    const malformed = registry({
      links: [{ ...link, testEvidence: [] }],
    });
    const audit = auditCoverageRegistry(malformed);
    const combinedErrors = [
      ...(audit.ok ? [] : audit.errors),
      ...reviewedDebtLinkErrors(malformed, [debt]),
      ...dtoDebtReferenceErrors(malformed, [declaration], [debt]),
    ];
    expect(combinedErrors).toContain(
      `${link.id}: reviewed debt link needs executable test evidence`,
    );
  });
});
