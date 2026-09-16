import { afterEach, describe, expect, test } from "bun:test";
import { setConfigOverrides } from "@nautilo/config";
import { isOfficeSkillHidden, OFFICE_BUNDLED_SKILL_NAMES } from "../../src/skills/resolve-skills";

afterEach(() => {
  setConfigOverrides({ nautilo_office_enabled: false });
});

describe("office skill gating (isOfficeSkillHidden)", () => {
  test("office skills are hidden when office is disabled", () => {
    setConfigOverrides({ nautilo_office_enabled: false });
    for (const name of OFFICE_BUNDLED_SKILL_NAMES) {
      expect(isOfficeSkillHidden(name)).toBe(true);
    }
  });

  test("office skills are visible when office is enabled", () => {
    setConfigOverrides({ nautilo_office_enabled: true });
    for (const name of OFFICE_BUNDLED_SKILL_NAMES) {
      expect(isOfficeSkillHidden(name)).toBe(false);
    }
  });

  test("non-office skills are never hidden by this gate", () => {
    setConfigOverrides({ nautilo_office_enabled: false });
    expect(isOfficeSkillHidden("mini-app-authoring")).toBe(false);
    setConfigOverrides({ nautilo_office_enabled: true });
    expect(isOfficeSkillHidden("mini-app-authoring")).toBe(false);
  });
});
