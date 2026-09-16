/**
 * D374 — exhaustive decision matrix for the instance-identity stamp.
 * Pure function; no DB connection (same discipline as
 * shouldAutoHealScratchDb).
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES,
  decideInstanceIdentityAction,
} from "../../src/utils/db-identity-guard";

describe("decideInstanceIdentityAction", () => {
  test("table missing → skip-unverified (never stamp a half-migrated DB)", () => {
    expect(
      decideInstanceIdentityAction({
        tableExists: false,
        rowExists: false,
        actualInstanceId: null,
        expectedInstanceId: "",
        trustConnection: true,
        connectionMatches: true,
      }),
    ).toBe("skip-unverified");
  });

  test("row present + matches → noop", () => {
    expect(
      decideInstanceIdentityAction({
        tableExists: true,
        rowExists: true,
        actualInstanceId: "",
        expectedInstanceId: "",
        trustConnection: false,
        connectionMatches: false,
      }),
    ).toBe("noop-matches");
  });

  test("row present + default alias normalizes to match", () => {
    expect(
      decideInstanceIdentityAction({
        tableExists: true,
        rowExists: true,
        actualInstanceId: "(default)",
        expectedInstanceId: "",
        trustConnection: false,
        connectionMatches: false,
      }),
    ).toBe("noop-matches");
  });

  test("row present + differs → throw-mismatch (wrong DB tripwire)", () => {
    expect(
      decideInstanceIdentityAction({
        tableExists: true,
        rowExists: true,
        actualInstanceId: "",
        expectedInstanceId: "test-cruft",
        trustConnection: true,
        connectionMatches: true,
      }),
    ).toBe("throw-mismatch");
  });

  test("row absent + trusted (deploy/container) → insert", () => {
    expect(
      decideInstanceIdentityAction({
        tableExists: true,
        rowExists: false,
        actualInstanceId: null,
        expectedInstanceId: "",
        trustConnection: true,
        connectionMatches: false,
      }),
    ).toBe("insert");
  });

  test("row absent + host connection provably matches → insert", () => {
    expect(
      decideInstanceIdentityAction({
        tableExists: true,
        rowExists: false,
        actualInstanceId: null,
        expectedInstanceId: "test-cruft",
        trustConnection: false,
        connectionMatches: true,
      }),
    ).toBe("insert");
  });

  test("row absent + host + connection does NOT match → skip (legit override, no mis-stamp)", () => {
    expect(
      decideInstanceIdentityAction({
        tableExists: true,
        rowExists: false,
        actualInstanceId: null,
        expectedInstanceId: "",
        trustConnection: false,
        connectionMatches: false,
      }),
    ).toBe("skip-unverified");
  });
});

describe("DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES", () => {
  test("covers operator/user data tables that should block fresh default reseed", () => {
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).toContain("public.actors");
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).toContain("public.rooms");
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).toContain("public.invites");
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).toContain("public.channel_identities");
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).toContain("public.file_revisions");
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).toContain("public.tasks");
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).toContain("public.skills");
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).toContain("langchain.checkpoint_blobs");
  });

  test("excludes migration/boot-seeded catalogs so a true fresh install can seed", () => {
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).not.toContain("public.roles");
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).not.toContain("public.capabilities");
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).not.toContain("public.role_capabilities");
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).not.toContain("public.groups");
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).not.toContain("public.group_roles");
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).not.toContain("public.group_members");
    expect(DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES).not.toContain("public.nautilo_instance_identity");
  });
});
