import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { SetupTemplateV1 } from "@nautilo/api-client";

test("shipped quickstart template parses against current schema", () => {
  const raw = readFileSync(
    join(import.meta.dirname, "..", "..", "templates", "nautilo-setup.quickstart.toml"),
    "utf8",
  );
  const parsed = parseToml(raw);
  const result = SetupTemplateV1.safeParse(parsed);
  expect(result.success).toBe(true);
});
