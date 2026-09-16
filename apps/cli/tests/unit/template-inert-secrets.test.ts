import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { SetupTemplateV1 } from "@nautilo/api-client";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

describe("inert setup templates (§13.1)", () => {
  test("setup.example.toml and quickstart use fromEnv for secret fields", () => {
    for (const rel of ["setup.example.toml", "apps/cli/templates/nautilo-setup.quickstart.toml"]) {
      const body = readFileSync(join(repoRoot, rel), "utf8");
      const parsed = parseToml(body);
      const v = SetupTemplateV1.safeParse(parsed);
      expect(v.success).toBe(true);
      if (!v.success) continue;
      expect("fromEnv" in v.data.admin.password).toBe(true);
      expect(v.data.admin.pin === undefined || "fromEnv" in v.data.admin.pin).toBe(true);
      expect("fromEnv" in v.data.claim.inviteCode).toBe(true);
    }
  });
});
