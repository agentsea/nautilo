import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

interface Service {
  image: string;
  depends_on?: Record<string, { condition: string }>;
  entrypoint?: string[];
  command?: string[];
}

const template = Bun.YAML.parse(readFileSync(new URL("../../templates/docker-compose.yml", import.meta.url), "utf8")) as {
  services: Record<"logto" | "logto-seed", Service>;
};

describe("packaged authentication database upgrades", () => {
  test("the selected image prepares its schema before the core can start", () => {
    const seed = template.services["logto-seed"];
    expect(seed.image).toBe(template.services.logto.image);
    expect(seed.entrypoint).toEqual(["/bin/sh", "-ec"]);
    expect(seed.depends_on?.["logto-postgres"]?.condition).toBe("service_healthy");
    expect(template.services.logto.depends_on?.["logto-seed"]?.condition).toBe("service_completed_successfully");
    expect(seed.command).toEqual([
      "npm run cli -- db seed --swe && npm run alteration deploy ${LOGTO_IMAGE_TAG:?LOGTO_IMAGE_TAG must match the selected authentication image}",
    ]);
  });

  for (const seedExit of [0, 1]) {
    test(`seed exit ${seedExit} preserves ordered, failure-closed alteration execution`, () => {
      const root = mkdtempSync(join(tmpdir(), "nautilo-auth-lifecycle-"));
      try {
        const npm = join(root, "npm");
        const calls = join(root, "calls");
        writeFileSync(npm, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NAUTILO_FIXTURE_CALLS"\nif test "$2" = cli; then exit "$NAUTILO_FIXTURE_SEED_EXIT"; fi\n');
        chmodSync(npm, 0o700);
        const command = template.services["logto-seed"].command?.[0];
        expect(command).toBeDefined();
        const result = spawnSync("/bin/sh", ["-ec", command!], {
          env: { ...process.env, PATH: `${root}:${process.env["PATH"] ?? ""}`, LOGTO_IMAGE_TAG: "1.45.0",
            NAUTILO_FIXTURE_CALLS: calls, NAUTILO_FIXTURE_SEED_EXIT: String(seedExit) },
          encoding: "utf8",
        });
        expect(result.status).toBe(seedExit);
        expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(seedExit === 0
          ? ["run cli -- db seed --swe", "run alteration deploy 1.45.0"]
          : ["run cli -- db seed --swe"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
