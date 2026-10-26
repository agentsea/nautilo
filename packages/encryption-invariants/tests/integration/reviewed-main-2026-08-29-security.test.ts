import { reviewedExternalMessageAttributionDtoReplacements } from "../../baseline/reviewed-external-message-attribution-dto";
import { reviewedImageAssistanceDtoReplacements } from "../../baseline/reviewed-image-assistance-dto";

import { describe, expect, test } from "bun:test";
import { SUPERSEDED_LANDING_SOURCE_LOCATORS } from "../../baseline/reviewed-main-2026-09-05-landing-source-alarms";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import {
  REVIEWED_MAIN_2026_08_29_COVERAGE_ENTRIES,
  REVIEWED_MAIN_2026_08_29_DEBT_LINKS,
} from "../../baseline/reviewed-main-2026-08-29-coverage";
import {
  REVIEWED_MAIN_2026_08_29_DTO_DECLARATIONS,
  SUPERSEDED_MAIN_2026_08_29_DTO_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-29-dto";
import {
  REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_29_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-29-source-alarms";
import {
  REVIEWED_MAIN_2026_08_31_DTO_DECLARATIONS,
  SUPERSEDED_MAIN_2026_08_31_DTO_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-31-dto";
import { SUPERSEDED_M301_DTO_LOCATORS } from "../../baseline/reviewed-m301-dto";
import { SUPERSEDED_M300_SOURCE_ALARM_LOCATORS } from "../../baseline/reviewed-m300-source-alarms";
import { SUPERSEDED_MAIN_2026_09_03_COVERAGE_LOCATORS } from "../../baseline/reviewed-main-2026-09-03-coverage";
import { SUPERSEDED_MAIN_2026_09_03_DTO_LOCATORS } from "../../baseline/reviewed-main-2026-09-03-dto";
import { SUPERSEDED_MAIN_2026_09_03_SOURCE_ALARM_LOCATORS } from "../../baseline/reviewed-main-2026-09-03-source-alarms";
import { SUPERSEDED_RELAY_BINDING_DTO_LOCATORS } from "../../baseline/reviewed-relay-binding-dto";
import { SUPERSEDED_RELAY_DISPATCH_SOURCE_ALARM_LOCATORS } from "../../baseline/reviewed-relay-dispatch-source-alarms";
import { isRetiredM306AuthorityLocator } from "../../baseline/retired-m306-authority";
import { REVIEWED_M318_DTO_DECLARATIONS, SUPERSEDED_M318_DTO_LOCATORS } from "../../baseline/reviewed-m318-dto";
import { SUPERSEDED_M318_COVERAGE_LOCATORS } from "../../baseline/reviewed-m318-coverage";
import {
  REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS,
  SUPERSEDED_MAIN_2026_09_12_DTO_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-12-dto";
import {
  REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-12-source-alarms";
import {
  TASK_RESEARCH_RESPONSE_SIGNATURES,
  SUPERSEDED_TASK_RESEARCH_DTO_LOCATORS,
} from "../../baseline/reviewed-task-research-dto";
import {
  REVIEWED_M322_DTO_REPLACEMENTS,
  reviewedM322RepairDtoReplacements,
  SUPERSEDED_M322_DTO_LOCATORS,
  SUPERSEDED_M322_REPAIR_DTO_LOCATORS,
} from "../../baseline/reviewed-m322-dto";
import { SUPERSEDED_MAIN_2026_09_09_PLATFORM_SOURCE_LOCATORS } from
  "../../baseline/reviewed-main-2026-09-09-platform-source-alarms";
import {
  REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_DTO_DECLARATIONS,
  SUPERSEDED_MAIN_2026_09_09_MESSAGEBACKFILL_DTO_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-09-message-backfill-dto";
import { SUPERSEDED_MAIN_2026_09_17_DTO_LOCATORS } from
  "../../baseline/reviewed-main-2026-09-17-dto";
import {
  REVIEWED_MAIN_2026_10_13_DTO_REPLACEMENTS,
  SUPERSEDED_MAIN_2026_10_13_DTO_LOCATORS,
} from "../../baseline/reviewed-main-2026-10-13-dto";
import { SUPERSEDED_MAIN_2026_10_13_SOURCE_ALARM_LOCATORS } from
  "../../baseline/reviewed-main-2026-10-13-source-alarms";
import {
  REVIEWED_TASK_PROTECTION_DTO_DECLARATIONS,
  SUPERSEDED_TASK_PROTECTION_DTO_LOCATORS,
} from "../../baseline/reviewed-task-protection-dto";
import { CURRENT_SOURCE_ALARM_REVIEWS } from "../../src/node/source-alarm-review";
import {
  REVIEWED_CI_SOURCE_RECONCILIATION_ALARMS,
  SUPERSEDED_CI_SOURCE_RECONCILIATION_LOCATORS,
} from "../../baseline/reviewed-ci-source-reconciliation";
import { REVIEWED_TASK_RUNTIME_SIGNER_DTO_LOCATORS } from
  "../../baseline/reviewed-task-runtime-signer-dto";
import { REVIEWED_CI_DTO_REPLACEMENTS } from "../../baseline/reviewed-ci-dto";
import { REVIEWED_RELEASE_RECONCILIATION_DTO_DECLARATIONS } from
  "../../baseline/reviewed-release-reconciliation-dto";
import type { DtoDeclaration } from "../../src/node/dto-inventory";

const EXTRACTED_SCANNER_ASSEMBLY_LOCATORS = [
  "apps/desktop/scripts/assemble-security-scanners.ts#network_processor:7f417ba7e396c76b:1",
  "apps/desktop/scripts/assemble-security-scanners.ts#filesystem_write:53b97cd14eb052e2:1",
  "apps/desktop/scripts/assemble-security-scanners.ts#subprocess_processor:eca3d35bc5b1d3f8:1",
  "apps/desktop/scripts/assemble-security-scanners.ts#temporary_storage:f7a11de7ca3892af:1",
  "apps/desktop/scripts/assemble-security-scanners.ts#filesystem_write:0d339cdcab54c9f1:1",
  "apps/desktop/scripts/assemble-security-scanners.ts#filesystem_write:b8b29d72deaa1568:1",
  "apps/desktop/scripts/assemble-security-scanners.ts#filesystem_write:643f7eeb065ba7bb:1",
  "apps/desktop/scripts/assemble-security-scanners.ts#filesystem_write:f62b3a8597d286cd:1",
  "apps/desktop/scripts/assemble-security-scanners.ts#filesystem_write:4e3c87a16d2b73bd:1",
  "apps/desktop/scripts/assemble-security-scanners.ts#filesystem_write:fa96ddf7b79030c4:1",
] as const;

const REFERENCE_AUDIO_SIGNATURE_FRAGMENT =
  ";referenceAudios?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};durationSeconds:number;index:number;label:string}[]";
const currentCiDtoByLocator = new Map<string, DtoDeclaration>(REVIEWED_CI_DTO_REPLACEMENTS.map(
  (entry) => [entry.locator, entry.declaration] as const,
));
const releaseDtoByLocator = new Map<string, DtoDeclaration>(REVIEWED_RELEASE_RECONCILIATION_DTO_DECLARATIONS.map(
  (entry) => [entry.locator, entry] as const,
));

function expectCurrentDtoLeaves(
  locator: string,
  reviewed: readonly DtoDeclaration[],
): void {
  const current = DTO_BASELINE_DECLARATIONS.filter((candidate) =>
    candidate.locator === locator
  );
  expect(current).toHaveLength(1);
  expect(reviewed).toHaveLength(1);
  const expected = currentCiDtoByLocator.get(locator)
    ?? releaseDtoByLocator.get(locator)
    ?? reviewed[0];
  expect(current[0]?.observationId).toBe(expected?.observationId);
  expect(current[0]?.arbitraryPayloads).toEqual(expected?.arbitraryPayloads);
}

function withTaskRuntimeSigner(
  declarations: readonly (typeof REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS)[number][],
) {
  const locators = new Set<string>(REVIEWED_TASK_RUNTIME_SIGNER_DTO_LOCATORS);
  return declarations.map((declaration) => {
    if (!locators.has(declaration.locator)) return declaration;
    const prior = '{evidenceBytesBase64url:string;kind:"agent_runtime_publication"|"processor_authorization"}';
    const next = `${prior}|{evidenceBytesBase64url:string;kind:"task_runtime_signer_certificate"}`;
    let matches = 0;
    const structuralSignatures = (declaration.structuralSignatures ?? []).map((signature) => {
      matches += signature.split(prior).length - 1;
      return signature.replaceAll(prior, next);
    });
    const expected = declaration.locator.endsWith("/message-backfill/source") ? 2 : 1;
    if (matches !== expected) throw new Error(`Task signer successor mismatch for ${declaration.locator}`);
    return { ...declaration, structuralSignatures };
  });
}

function expectLatestTaskResearchReplacement(
  predecessor: (typeof REVIEWED_MAIN_2026_08_29_DTO_DECLARATIONS)[number],
): void {
  const current = DTO_BASELINE_DECLARATIONS.filter((candidate) =>
    candidate.locator === predecessor.locator
  );
  expect(current).toHaveLength(1);
  const currentDeclaration = current[0];
  if (!currentDeclaration?.structuralSignatures) {
    throw new Error(`Missing current Task signatures for ${predecessor.locator}`);
  }
  const response = currentDeclaration.structuralSignatures.find((signature) =>
    signature.startsWith("response.body:{activity?:")
  );
  expect(response).toContain(REFERENCE_AUDIO_SIGNATURE_FRAGMENT);
  const september12 = REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS.find(
    (candidate) => candidate.locator === predecessor.locator,
  );
  expect(september12).toBeDefined();
  if (!september12) throw new Error(`Missing September 12 predecessor for ${predecessor.locator}`);
  expect([...reviewedExternalMessageAttributionDtoReplacements(
    reviewedImageAssistanceDtoReplacements([september12]),
  )][0]).toEqual({
    ...currentDeclaration,
    structuralSignatures: currentDeclaration.structuralSignatures.map((signature) =>
      signature.replace(REFERENCE_AUDIO_SIGNATURE_FRAGMENT, "")
    ),
  });
  expect(september12.arbitraryPayloads).toEqual(predecessor.arbitraryPayloads);
}

describe("reviewed main 2026-08-29 encryption inventory", () => {
  test("accounts for every newly observed coordinate exactly once", () => {
    expect(REVIEWED_MAIN_2026_08_29_COVERAGE_ENTRIES).toHaveLength(733);
    expect(REVIEWED_MAIN_2026_08_29_DEBT_LINKS).toHaveLength(30);

    expect(new Set(
      REVIEWED_MAIN_2026_08_29_COVERAGE_ENTRIES.map((entry) => entry.locator),
    ).size).toBe(REVIEWED_MAIN_2026_08_29_COVERAGE_ENTRIES.length);
    expect(new Set(
      REVIEWED_MAIN_2026_08_29_DEBT_LINKS.map((link) => link.locator),
    ).size).toBe(REVIEWED_MAIN_2026_08_29_DEBT_LINKS.length);

    expect(REVIEWED_MAIN_2026_08_29_COVERAGE_ENTRIES.filter(
      (entry) => entry.classification === "bounded_metadata",
    )).toHaveLength(473);
    expect(REVIEWED_MAIN_2026_08_29_COVERAGE_ENTRIES.filter(
      (entry) => entry.classification === "protected",
    )).toHaveLength(246);
    expect(REVIEWED_MAIN_2026_08_29_COVERAGE_ENTRIES.filter(
      (entry) => entry.classification === "operator_secret",
    )).toHaveLength(14);

    for (const entry of REVIEWED_MAIN_2026_08_29_COVERAGE_ENTRIES) {
      if (SUPERSEDED_M318_COVERAGE_LOCATORS.has(entry.locator)) continue;
      if (
        SUPERSEDED_MAIN_2026_09_03_COVERAGE_LOCATORS.has(entry.locator)
        || isRetiredM306AuthorityLocator(entry.locator)
      ) {
        expect(BASELINE_REGISTRY.entries.some((candidate) =>
          candidate.locator === entry.locator
        )).toBe(false);
      } else {
        expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
      }
    }
    for (const link of REVIEWED_MAIN_2026_08_29_DEBT_LINKS) {
      expect(BASELINE_REGISTRY.reviewedDebtLinks).toContainEqual(link);
    }
  });

  test("keeps authority envelopes and live shadow traffic protected", () => {
    const protectedEntries = REVIEWED_MAIN_2026_08_29_COVERAGE_ENTRIES.filter(
      (entry) => entry.classification === "protected",
    );
    expect(protectedEntries.every((entry) =>
      entry.migrationState === "shadow"
      && entry.bridgeRepository === "packages/lattice-bridge"
      && entry.negativeTestEvidence.length > 0
    )).toBe(true);

    for (const locator of [
      "public.namespace_key_recipient_envelopes.envelope_bytes",
      "public.grant_domain_recipient_envelopes.envelope_bytes",
      "ws:server_to_client:message.shared_agent_stream_frame",
      "http:request_response:GET /api/rooms/:id/messages#response.body.shadowEncryption",
    ]) {
      expect(protectedEntries.some((entry) => entry.locator === locator)).toBe(true);
    }
  });

  test("keeps transient credentials out of durable and agent-grant claims", () => {
    const secrets = REVIEWED_MAIN_2026_08_29_COVERAGE_ENTRIES.filter(
      (entry) => entry.classification === "operator_secret",
    );
    expect(secrets).toHaveLength(14);
    expect(secrets.every((entry) =>
      entry.excludedFromAgentGrants
      && entry.secretStoreLocation.includes("request memory")
      && entry.backupProcedure.includes("Not backed up")
    )).toBe(true);
    for (const fragment of ["permanentCredential", ".password", ".pin", ".startupReceipt"]) {
      expect(secrets.some((entry) => entry.locator.includes(fragment))).toBe(true);
    }
  });

  test("links personal content and identity surfaces to frozen plaintext debt", () => {
    const links = new Map(
      REVIEWED_MAIN_2026_08_29_DEBT_LINKS.map((link) => [link.locator, link]),
    );
    for (const locator of [
      "public.content_reports.comment",
      "public.content_reports.preview_text",
      "public.claude_connections.account",
      "public.human_blocks.blocker_user_id",
      "http:request_response:GET /api/tasks/pending-attention",
    ]) {
      expect(links.has(locator)).toBe(true);
      expect(links.get(locator)?.targetDebtIds.length).toBeGreaterThan(0);
    }

    const classifiedLocators = new Set(
      REVIEWED_MAIN_2026_08_29_COVERAGE_ENTRIES.map((entry) => entry.locator),
    );
    expect(classifiedLocators.has("public.content_reports.comment")).toBe(false);
    expect(classifiedLocators.has("public.content_reports.preview_text")).toBe(false);
    expect(classifiedLocators.has("public.claude_connections.account")).toBe(false);
  });

  test("pins open DTO leaves to concrete contracts or exact existing debt", () => {
    expect(REVIEWED_MAIN_2026_08_29_DTO_DECLARATIONS).toHaveLength(83);
    expect(new Set(
      REVIEWED_MAIN_2026_08_29_DTO_DECLARATIONS.map((item) => item.locator),
    ).size).toBe(REVIEWED_MAIN_2026_08_29_DTO_DECLARATIONS.length);

    const pendingAttention = REVIEWED_MAIN_2026_08_29_DTO_DECLARATIONS.find(
      (item) => item.locator === "http:request_response:GET /api/tasks/pending-attention",
    );
    expect(pendingAttention?.arbitraryPayloads).toEqual([
      {
        path: "response.body[].activity.args",
        schema: "TaskAttentionToolArgumentsV1",
      },
      {
        path: "response.body[].tools[].args",
        schema: "TaskAttentionToolArgumentsV1",
      },
    ]);

    for (const declaration of REVIEWED_MAIN_2026_08_29_DTO_DECLARATIONS) {
      if (SUPERSEDED_MAIN_2026_10_13_DTO_LOCATORS.has(declaration.locator)) {
        const current = DTO_BASELINE_DECLARATIONS.filter((candidate) =>
          candidate.locator === declaration.locator
        );
        const reviewed = REVIEWED_MAIN_2026_10_13_DTO_REPLACEMENTS
          .filter((candidate) => candidate.locator === declaration.locator)
          .map((candidate) => currentCiDtoByLocator.get(candidate.locator)
            ?? releaseDtoByLocator.get(candidate.locator)
            ?? candidate);
        expect(current).toHaveLength(1);
        expect(reviewed).toHaveLength(1);
        expect(current[0]?.observationId).toBe(reviewed[0]?.observationId);
        expect(current[0]?.arbitraryPayloads).toEqual(reviewed[0]?.arbitraryPayloads);
        continue;
      }
      if (SUPERSEDED_TASK_PROTECTION_DTO_LOCATORS.has(declaration.locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((candidate) => candidate.locator === declaration.locator))
          .toEqual(REVIEWED_TASK_PROTECTION_DTO_DECLARATIONS
            .filter((candidate) => candidate.locator === declaration.locator)
            .map((candidate) => currentCiDtoByLocator.get(candidate.locator) ?? candidate));
        continue;
      }
      if (
        SUPERSEDED_TASK_RESEARCH_DTO_LOCATORS.has(declaration.locator)
        && SUPERSEDED_MAIN_2026_09_17_DTO_LOCATORS.has(declaration.locator)
      ) {
        expectLatestTaskResearchReplacement(declaration);
        continue;
      }
      if (SUPERSEDED_TASK_RESEARCH_DTO_LOCATORS.has(declaration.locator)) {
        const current = DTO_BASELINE_DECLARATIONS.filter((candidate) =>
          candidate.locator === declaration.locator
        );
        expect(current).toHaveLength(1);
        expect(current[0]?.structuralSignatures).toContain(
          TASK_RESEARCH_RESPONSE_SIGNATURES[declaration.locator],
        );
        expect(current[0]?.arbitraryPayloads).toEqual(declaration.arbitraryPayloads);
        continue;
      }
      if (SUPERSEDED_MAIN_2026_09_12_DTO_LOCATORS.has(declaration.locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((candidate) => candidate.locator === declaration.locator))
          .toEqual(withTaskRuntimeSigner([...reviewedExternalMessageAttributionDtoReplacements(reviewedImageAssistanceDtoReplacements(
            REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS.filter((candidate) => candidate.locator === declaration.locator),
          ))]));
        continue;
      }
      if (SUPERSEDED_MAIN_2026_09_09_MESSAGEBACKFILL_DTO_LOCATORS.has(declaration.locator)) {
        const current = DTO_BASELINE_DECLARATIONS.filter((candidate) =>
          candidate.locator === declaration.locator
        );
        const reviewed = reviewedExternalMessageAttributionDtoReplacements(
          reviewedImageAssistanceDtoReplacements(
            REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_DTO_DECLARATIONS.filter(
              (candidate) => candidate.locator === declaration.locator,
            ),
          ),
        );
        expect(current).toHaveLength(1);
        expect(reviewed).toHaveLength(1);
        expect(current[0]?.observationId).toBe(reviewed[0]?.observationId);
        expect(current[0]?.arbitraryPayloads).toEqual(reviewed[0]?.arbitraryPayloads);
        continue;
      }
      if (SUPERSEDED_M322_REPAIR_DTO_LOCATORS.has(declaration.locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((candidate) => candidate.locator === declaration.locator))
          .toEqual([...reviewedExternalMessageAttributionDtoReplacements(reviewedImageAssistanceDtoReplacements(
            reviewedM322RepairDtoReplacements([declaration]),
          ))]);
        continue;
      }
      if (SUPERSEDED_M322_DTO_LOCATORS.has(declaration.locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((candidate) => candidate.locator === declaration.locator))
          .toEqual([...reviewedExternalMessageAttributionDtoReplacements(reviewedImageAssistanceDtoReplacements(
            REVIEWED_M322_DTO_REPLACEMENTS.filter((candidate) => candidate.locator === declaration.locator),
          ))]);
        continue;
      }
      if (SUPERSEDED_M318_DTO_LOCATORS.has(declaration.locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((candidate) => candidate.locator === declaration.locator))
          .toEqual([...reviewedExternalMessageAttributionDtoReplacements(reviewedImageAssistanceDtoReplacements(
            REVIEWED_M318_DTO_DECLARATIONS.filter((candidate) => candidate.locator === declaration.locator),
          ))]);
        continue;
      }
      if (isRetiredM306AuthorityLocator(declaration.locator)) {
        expect(DTO_BASELINE_DECLARATIONS.some((candidate) =>
          candidate.locator === declaration.locator
        )).toBe(false);
        continue;
      }
      if (
        SUPERSEDED_MAIN_2026_08_31_DTO_LOCATORS.has(declaration.locator)
        || SUPERSEDED_M301_DTO_LOCATORS.has(declaration.locator)
        || SUPERSEDED_MAIN_2026_09_03_DTO_LOCATORS.has(declaration.locator)
        || SUPERSEDED_RELAY_BINDING_DTO_LOCATORS.has(declaration.locator)
        || SUPERSEDED_M318_DTO_LOCATORS.has(declaration.locator)
      ) {
        if (
          SUPERSEDED_M301_DTO_LOCATORS.has(declaration.locator)
          || SUPERSEDED_MAIN_2026_09_03_DTO_LOCATORS.has(declaration.locator)
          || SUPERSEDED_RELAY_BINDING_DTO_LOCATORS.has(declaration.locator)
        ) {
          expect(DTO_BASELINE_DECLARATIONS.filter((candidate) =>
            candidate.locator === declaration.locator
          )).toHaveLength(1);
        }
        continue;
      }
      expect(DTO_BASELINE_DECLARATIONS).toContainEqual(declaration);
      expect(declaration.arbitraryPayloads.every((payload) =>
        ("schema" in payload && payload.schema.length > 0)
        || ("debtId" in payload && payload.debtId.length > 0)
      )).toBe(true);
    }
    for (const locator of SUPERSEDED_MAIN_2026_08_29_DTO_LOCATORS) {
      if (SUPERSEDED_MAIN_2026_10_13_DTO_LOCATORS.has(locator)) {
        expectCurrentDtoLeaves(locator, REVIEWED_MAIN_2026_10_13_DTO_REPLACEMENTS
          .filter((candidate) => candidate.locator === locator));
        continue;
      }
      if (SUPERSEDED_TASK_PROTECTION_DTO_LOCATORS.has(locator)) {
        expectCurrentDtoLeaves(locator, REVIEWED_TASK_PROTECTION_DTO_DECLARATIONS
          .filter((candidate) => candidate.locator === locator));
        continue;
      }
      if (
        SUPERSEDED_TASK_RESEARCH_DTO_LOCATORS.has(locator)
        && SUPERSEDED_MAIN_2026_09_17_DTO_LOCATORS.has(locator)
      ) {
        const predecessor = REVIEWED_MAIN_2026_08_29_DTO_DECLARATIONS.find(
          (candidate) => candidate.locator === locator,
        );
        expect(predecessor).toBeDefined();
        expectLatestTaskResearchReplacement(predecessor!);
        continue;
      }
      if (SUPERSEDED_TASK_RESEARCH_DTO_LOCATORS.has(locator)) {
        const current = DTO_BASELINE_DECLARATIONS.filter((candidate) =>
          candidate.locator === locator
        );
        const predecessor = REVIEWED_MAIN_2026_08_29_DTO_DECLARATIONS.find(
          (candidate) => candidate.locator === locator,
        );
        expect(current).toHaveLength(1);
        expect(current[0]?.structuralSignatures).toContain(
          TASK_RESEARCH_RESPONSE_SIGNATURES[locator],
        );
        expect(current[0]?.arbitraryPayloads).toEqual(predecessor?.arbitraryPayloads);
        continue;
      }
      if (SUPERSEDED_MAIN_2026_09_12_DTO_LOCATORS.has(locator)) {
        expectCurrentDtoLeaves(locator, reviewedExternalMessageAttributionDtoReplacements(reviewedImageAssistanceDtoReplacements(
            REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS.filter((candidate) => candidate.locator === locator),
          )));
        continue;
      }
      if (SUPERSEDED_MAIN_2026_09_09_MESSAGEBACKFILL_DTO_LOCATORS.has(locator)) {
        expectCurrentDtoLeaves(locator, reviewedExternalMessageAttributionDtoReplacements(reviewedImageAssistanceDtoReplacements(
            REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_DTO_DECLARATIONS.filter((candidate) => candidate.locator === locator),
          )));
        continue;
      }
      if (SUPERSEDED_M322_REPAIR_DTO_LOCATORS.has(locator)) {
        const predecessor = REVIEWED_MAIN_2026_08_29_DTO_DECLARATIONS.filter((candidate) => candidate.locator === locator);
        expect(DTO_BASELINE_DECLARATIONS.filter((candidate) => candidate.locator === locator))
          .toEqual([...reviewedExternalMessageAttributionDtoReplacements(reviewedImageAssistanceDtoReplacements(
            reviewedM322RepairDtoReplacements(predecessor),
          ))]);
        continue;
      }
      if (SUPERSEDED_M322_DTO_LOCATORS.has(locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((candidate) => candidate.locator === locator))
          .toEqual([...reviewedExternalMessageAttributionDtoReplacements(reviewedImageAssistanceDtoReplacements(
            REVIEWED_M322_DTO_REPLACEMENTS.filter((candidate) => candidate.locator === locator),
          ))]);
        continue;
      }
      if (SUPERSEDED_M318_DTO_LOCATORS.has(locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((candidate) => candidate.locator === locator))
          .toEqual([...reviewedExternalMessageAttributionDtoReplacements(reviewedImageAssistanceDtoReplacements(
            REVIEWED_M318_DTO_DECLARATIONS.filter((candidate) => candidate.locator === locator),
          ))]);
        continue;
      }
      if (SUPERSEDED_RELAY_BINDING_DTO_LOCATORS.has(locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter(
          (item) => item.locator === locator,
        )).toHaveLength(1);
        continue;
      }
      if (SUPERSEDED_MAIN_2026_09_03_DTO_LOCATORS.has(locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter(
          (item) => item.locator === locator,
        ).length).toBeLessThanOrEqual(1);
        continue;
      }
      const replacement = REVIEWED_MAIN_2026_08_29_DTO_DECLARATIONS.find(
        (item) => item.locator === locator,
      );
      expect(replacement).toBeDefined();
      const august31Replacement = REVIEWED_MAIN_2026_08_31_DTO_DECLARATIONS.find(
        (item) => item.locator === locator,
      );
      expect(DTO_BASELINE_DECLARATIONS.filter(
        (item) => item.locator === locator,
      )).toEqual(
        SUPERSEDED_M301_DTO_LOCATORS.has(locator)
          ? DTO_BASELINE_DECLARATIONS.filter((item) => item.locator === locator)
          : SUPERSEDED_MAIN_2026_08_31_DTO_LOCATORS.has(locator)
          ? august31Replacement ? [august31Replacement] : []
          : [replacement!],
      );
    }
  });

  test("leaves dynamic diagnostic alarms as release-blocking debt", () => {
    expect(REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS).toHaveLength(97);
    expect(REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS.filter(
      (review) => review.closure === "declaration",
    )).toHaveLength(72);
    const runtimeDebt = REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS.filter(
      (review) => review.closure === "baseline_debt",
    );
    expect(runtimeDebt).toHaveLength(25);
    expect(runtimeDebt.every((review) =>
      review.remediationState === "planned"
      && review.releaseImpact === "blocks_whole_product_claim"
      && review.evidenceGap.length > 0
    )).toBe(true);

    for (const locator of EXTRACTED_SCANNER_ASSEMBLY_LOCATORS) {
      expect(REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS.some((review) =>
        review.locator === locator
      )).toBe(false);
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((review) =>
        review.locator === locator
      )).toBe(false);
    }

    for (const review of REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS) {
      if (
        SUPERSEDED_M300_SOURCE_ALARM_LOCATORS.has(review.locator)
        || SUPERSEDED_MAIN_2026_09_03_SOURCE_ALARM_LOCATORS.has(review.locator)
        || SUPERSEDED_RELAY_DISPATCH_SOURCE_ALARM_LOCATORS.has(review.locator)
        || isRetiredM306AuthorityLocator(review.locator)
        || SUPERSEDED_LANDING_SOURCE_LOCATORS.has(review.locator)
        || SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS.has(review.locator)
        || SUPERSEDED_MAIN_2026_09_09_PLATFORM_SOURCE_LOCATORS.has(review.locator)
        || SUPERSEDED_MAIN_2026_10_13_SOURCE_ALARM_LOCATORS.has(review.locator)
      ) {
        continue;
      }
      if (SUPERSEDED_CI_SOURCE_RECONCILIATION_LOCATORS.has(review.locator)) {
        expect(CURRENT_SOURCE_ALARM_REVIEWS).not.toContainEqual(review);
        const replacement = REVIEWED_CI_SOURCE_RECONCILIATION_ALARMS.find(
          entry => entry.locator === review.locator,
        );
        expect(CURRENT_SOURCE_ALARM_REVIEWS.filter(entry => entry.locator === review.locator))
          .toEqual(replacement ? [replacement] : []);
      } else {
        expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
      }
    }
    for (const locator of SUPERSEDED_MAIN_2026_08_29_SOURCE_ALARM_LOCATORS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((review) =>
        review.locator === locator
      )).toBe(false);
    }
    const september9RetiredReviews = REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS.filter((review) =>
      SUPERSEDED_MAIN_2026_09_09_PLATFORM_SOURCE_LOCATORS.has(review.locator)
    );
    expect(september9RetiredReviews.map((review) => review.locator)).toEqual([
      "apps/workbench/src/pages/settings/sections/integrations-section.tsx#network_processor:0d2ab469d7540d61:1",
    ]);
    expect(september9RetiredReviews.every((review) =>
      !CURRENT_SOURCE_ALARM_REVIEWS.some((current) => current.locator === review.locator)
    )).toBe(true);

    const september12SupersededReviews = REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS.filter((review) =>
      SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS.has(review.locator)
    );
    expect(september12SupersededReviews).toHaveLength(8);
    const sameLocatorReplacements = september12SupersededReviews.filter((review) =>
      REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS.some((replacement) => replacement.locator === review.locator)
    );
    const retiredReviews = september12SupersededReviews.filter((review) =>
      !REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS.some((replacement) => replacement.locator === review.locator)
    );
    expect(sameLocatorReplacements).toHaveLength(5);
    expect(retiredReviews).toHaveLength(3);
    for (const review of sameLocatorReplacements) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS).not.toContainEqual(review);
      expect(CURRENT_SOURCE_ALARM_REVIEWS.filter((current) => current.locator === review.locator))
        .toEqual(REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS.filter((replacement) => replacement.locator === review.locator));
    }
    expect(retiredReviews.every((review) =>
      !CURRENT_SOURCE_ALARM_REVIEWS.some((current) => current.locator === review.locator)
    )).toBe(true);
    const september12ReplacementPrefixes = [
      "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:",
      "packages/agent/src/tools/invocation-service.ts#log_emitter:",
      "packages/runtime/src/stenographer/worker.ts#log_emitter:",
    ];
    const september12Replacements = REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS.filter((review) =>
      september12ReplacementPrefixes.some((prefix) => review.locator.startsWith(prefix))
    );
    expect(september12Replacements).toHaveLength(29);
    const replacementLocators = new Set(september12Replacements.map((review) => review.locator));
    expect(CURRENT_SOURCE_ALARM_REVIEWS.filter((review) => replacementLocators.has(review.locator)))
      .toEqual(september12Replacements);
    expect(september12Replacements.filter((review) => review.closure === "baseline_debt").every((review) =>
      review.releaseImpact === "blocks_whole_product_claim"
      && review.evidenceGap.length > 0
    )).toBe(true);
  });
});
