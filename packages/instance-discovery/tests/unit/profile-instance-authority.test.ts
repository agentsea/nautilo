import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyProfileAuthority,
  readProfileInstanceAuthority,
} from "../../src/node.ts";

describe("profile instance authority", () => {
  let home: string | undefined;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("reads every TOML once and remote transport deterministically owns its instance ID", () => {
    home = mkdtempSync(join(tmpdir(), "nautilo-authority-"));
    const profiles = join(home, ".nautilo", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(
      join(profiles, "beta.toml"),
      'transport = "remote"\nlifecycle = "compose"\ninstance_id = "beta"\ndomain = "beta.example.test"\n',
    );
    const authority = readProfileInstanceAuthority(home);
    expect(classifyProfileAuthority("beta", authority)).toMatchObject({
      classification: "remote",
    });
  });

  test("accepts generated instance IDs allowed by the canonical 32-character contract", () => {
    home = mkdtempSync(join(tmpdir(), "nautilo-authority-long-id-"));
    const profiles = join(home, ".nautilo", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(
      join(profiles, "d513.toml"),
      'transport = "local"\nlifecycle = "compose"\ninstance_id = "agent-lab-314-4e95"\n',
    );
    const authority = readProfileInstanceAuthority(home);
    expect(classifyProfileAuthority("agent-lab-314-4e95", authority)).toMatchObject({
      classification: "local",
      retention: "durable",
    });
  });

  test("explicit disposable retention is distinct from fail-safe legacy durability", () => {
    home = mkdtempSync(join(tmpdir(), "nautilo-authority-retention-"));
    const profiles = join(home, ".nautilo", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, "scratch.toml"), 'transport = "local"\nlifecycle = "compose"\ninstance_id = "scratch"\nretention = "disposable"\n');
    const authority = readProfileInstanceAuthority(home);
    expect(classifyProfileAuthority("scratch", authority)).toMatchObject({ classification: "local", retention: "disposable" });
  });

  test("conflicting or malformed retention fails closed", () => {
    home = mkdtempSync(join(tmpdir(), "nautilo-authority-retention-conflict-"));
    const profiles = join(home, ".nautilo", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, "one.toml"), 'transport = "local"\nlifecycle = "compose"\ninstance_id = "shared"\nretention = "durable"\n');
    writeFileSync(join(profiles, "two.toml"), 'transport = "local"\nlifecycle = "compose"\ninstance_id = "shared"\nretention = "disposable"\n');
    writeFileSync(join(profiles, "bad.toml"), 'transport = "local"\nlifecycle = "compose"\ninstance_id = "bad"\nretention = "temporary"\n');
    const authority = readProfileInstanceAuthority(home);
    expect(classifyProfileAuthority("shared", authority)).toMatchObject({ classification: "unknown", retention: "unknown" });
    expect(classifyProfileAuthority("bad", authority)).toMatchObject({ classification: "unknown", retention: "unknown" });
  });

  test("invalid relevant metadata and contradictory claims fail closed", () => {
    home = mkdtempSync(join(tmpdir(), "nautilo-authority-bad-"));
    const profiles = join(home, ".nautilo", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(
      join(profiles, "bad.toml"),
      'transport = "elsewhere"\nlifecycle = "compose"\ninstance_id = "bad"\n',
    );
    writeFileSync(
      join(profiles, "local.toml"),
      'transport = "local"\nlifecycle = "compose"\ninstance_id = "shared"\n',
    );
    writeFileSync(
      join(profiles, "remote.toml"),
      'transport = "remote"\nlifecycle = "compose"\ninstance_id = "shared"\n',
    );
    const authority = readProfileInstanceAuthority(home);
    expect(classifyProfileAuthority("bad", authority)?.classification).toBe("unknown");
    expect(classifyProfileAuthority("shared", authority)?.classification).toBe("unknown");
  });

  test("unparseable profile makes otherwise unclaimed IDs unknown", () => {
    home = mkdtempSync(join(tmpdir(), "nautilo-authority-malformed-"));
    const profiles = join(home, ".nautilo", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, "broken.toml"), 'transport = "remote\n');
    const authority = readProfileInstanceAuthority(home);
    expect(classifyProfileAuthority("anything", authority)?.classification).toBe("unknown");
  });
});
