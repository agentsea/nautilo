import { describe, expect, test } from "bun:test";

import { SetupTemplateV1 } from "../../src/schemas/setup-template.ts";

const minimalTemplate = {
  schemaVersion: 1,
  admin: {
    handle: "owner",
    displayName: "Owner",
    password: { value: "permanent-password" },
  },
  claim: { inviteCode: { value: "invite" } },
};

describe("SetupTemplateV1 owner password contract", () => {
  test("accepts omission without adding forcePasswordChangeOnFirstSignIn", () => {
    const parsed = SetupTemplateV1.parse(minimalTemplate);

    expect("forcePasswordChangeOnFirstSignIn" in parsed.admin).toBe(false);
  });

  test.each([true, false])(
    "rejects explicit forcePasswordChangeOnFirstSignIn=%s",
    (forcePasswordChangeOnFirstSignIn) => {
      const result = SetupTemplateV1.safeParse({
        ...minimalTemplate,
        admin: {
          ...minimalTemplate.admin,
          forcePasswordChangeOnFirstSignIn,
        },
      });

      expect(result.success).toBe(false);
    },
  );
});
