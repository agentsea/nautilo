/**
 * M128 — TP14 wizard-skip-predicate test (D6).
 *
 * Source spec: ISSUE-M128 §10 D6 (revised), §12.2 / §15.1.
 *
 * The wizard runs for every non-guest invitee. A user whose ONLY Group
 * is `guests` skips wizard entry entirely. Every other rung (owner,
 * admin, superuser, member, contributor) enters the wizard. A user in
 * multiple Groups enters the wizard if any of them is non-guest.
 *
 * The predicate `shouldSkipWizardForGuestOnly` is the only piece of
 * production logic that consumes `groups` from `/api/auth/whoami` in
 * the wizard's import surface — Electron main hooks it at
 * `showOnboardingWizard` time (P5 follow-up).
 */
import { describe, expect, test } from "bun:test";
import { shouldSkipWizardForGuestOnly } from "../src/hooks/useWizardState";

describe("M128 D6 — shouldSkipWizardForGuestOnly", () => {
  test("returns true ONLY when sole group is 'guests'", () => {
    expect(shouldSkipWizardForGuestOnly([{ type: "guests" }])).toBe(true);
  });

  test("returns false for sole group = owners", () => {
    expect(shouldSkipWizardForGuestOnly([{ type: "owners" }])).toBe(false);
  });

  test("returns false for sole group = admins", () => {
    expect(shouldSkipWizardForGuestOnly([{ type: "admins" }])).toBe(false);
  });

  test("returns false for sole group = superusers", () => {
    expect(shouldSkipWizardForGuestOnly([{ type: "superusers" }])).toBe(false);
  });

  test("returns false for sole group = members", () => {
    expect(shouldSkipWizardForGuestOnly([{ type: "members" }])).toBe(false);
  });

  test("returns false for sole group = contributors", () => {
    expect(shouldSkipWizardForGuestOnly([{ type: "contributors" }])).toBe(false);
  });

  test("returns false for empty groups list (unbound / pre-redemption)", () => {
    expect(shouldSkipWizardForGuestOnly([])).toBe(false);
  });

  test("returns false when guests is one of MULTIPLE groups (e.g. guests + members)", () => {
    expect(
      shouldSkipWizardForGuestOnly([{ type: "guests" }, { type: "members" }]),
    ).toBe(false);
  });

  test("returns false when groups contains any non-guests entry", () => {
    expect(
      shouldSkipWizardForGuestOnly([
        { type: "guests" },
        { type: "guests" }, // pathological duplicate
        { type: "admins" },
      ]),
    ).toBe(false);
  });
});
