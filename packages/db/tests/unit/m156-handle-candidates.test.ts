/**
 * M156 — pure unit tests for the Agent handle-derivation candidate list
 * (`buildHandleCandidates`). No database is touched: the function is the
 * pure algorithm that `renameAgentProfileIdentity` walks to pick the first
 * non-colliding handle. The collision/transaction behavior lives in the DB
 * and is covered by integration / manual QA.
 */
import { describe, expect, test } from "bun:test";
import { HANDLE_MAX_LEN, HANDLE_RE } from "@nautilo/types";
import { buildHandleCandidates } from "../../src/utils/rename-agent-profile-identity";

describe("M156 buildHandleCandidates", () => {
  test("first candidate is the slug of the name", () => {
    const c = buildHandleCandidates("Genie", "casey");
    expect(c[0]).toBe("genie");
  });

  test("second candidate is slug_<ownerHandle>", () => {
    const c = buildHandleCandidates("My Cool Bot", "bob");
    expect(c[0]).toBe("my_cool_bot");
    expect(c[1]).toBe("my_cool_bot_bob");
  });

  test("includes random-digit fallbacks after the owner-handle candidate", () => {
    const c = buildHandleCandidates("Robot", "casey");
    expect(c[0]).toBe("robot");
    expect(c[1]).toBe("robot_casey");
    // remaining candidates are `robot_<digits>` forms
    const digitForms = c.slice(2);
    expect(digitForms.length).toBeGreaterThan(0);
    for (const cand of digitForms) {
      expect(cand).toMatch(/^robot_\d{3,4}$/);
    }
  });

  test("empty / non-charset name falls back to the 'genie' base", () => {
    expect(buildHandleCandidates("!!!", "casey")[0]).toBe("genie");
    expect(buildHandleCandidates("   ", "bob")[0]).toBe("genie");
    expect(buildHandleCandidates("123", "bob")[0]).toBe("genie");
  });

  test("every candidate is a valid handle and within length", () => {
    const samples: Array<[string, string]> = [
      ["Genie", "casey"],
      ["My Cool Bot", "bob"],
      ["Robot Helper 9000", "alice"],
      ["!!!", "owner"],
      // long name + long owner → truncation must still yield valid handles
      ["Supercalifragilisticexpialidocious Assistant", "averyveryverylonghandlename"],
    ];
    for (const [name, owner] of samples) {
      const c = buildHandleCandidates(name, owner);
      expect(c.length).toBeGreaterThan(0);
      for (const cand of c) {
        expect(HANDLE_RE.test(cand)).toBe(true);
        expect(cand.length).toBeLessThanOrEqual(HANDLE_MAX_LEN);
        expect(cand.endsWith("_")).toBe(false);
      }
    }
  });

  test("the owner-suffix candidate preserves the suffix even when truncated", () => {
    const c = buildHandleCandidates(
      "Supercalifragilisticexpialidocious",
      "longownerhandle",
    );
    // candidate #1 must end with the owner handle (suffix survives), not be
    // sliced back into the bare base.
    expect(c[1]).toMatch(/_longownerhandle$/);
    expect(c[1]!.length).toBeLessThanOrEqual(HANDLE_MAX_LEN);
  });

  test("candidates are de-duplicated", () => {
    const c = buildHandleCandidates("Genie", "casey");
    expect(new Set(c).size).toBe(c.length);
  });
});
