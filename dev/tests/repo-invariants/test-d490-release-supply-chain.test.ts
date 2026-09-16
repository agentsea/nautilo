import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRegistryImageRef } from "../../../deploy/compose-driver/src/buildRegistryOverlay";

const repoRoot = join(import.meta.dir, "../../..");

function source(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

const bunBase =
  "oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";
const bunBaseMatch = /^oven\/bun:(\d+\.\d+\.\d+)@sha256:([a-f0-9]{64})$/.exec(
  bunBase,
);

if (bunBaseMatch === null) {
  throw new Error("bunBase must be an explicit semver tag and SHA-256 digest");
}

const [, bunVersion, bunDigest] = bunBaseMatch;

describe("D490 release supply-chain pins", () => {
  test("uses one explicit immutable multi-architecture Bun base identity", () => {
    const dockerfile = source("packaging/docker/Dockerfile");
    const bunFromLines = dockerfile.match(/^FROM\s+oven\/bun:[^\s]+/gm) ?? [];
    const bunBaseReference = /^oven\/bun:(\d+\.\d+\.\d+)@sha256:([a-f0-9]{64})$/;

    // deps starts from the pinned base and copies the prepared manifests in
    // one layer to avoid exhausting Docker overlay depth during app builds.
    expect(bunFromLines).toEqual([
      `FROM ${bunBase}`,
      `FROM ${bunBase}`,
      `FROM ${bunBase}`,
      `FROM ${bunBase}`,
    ]);
    for (const line of bunFromLines) {
      const match = bunBaseReference.exec(line.slice("FROM ".length));
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe(bunVersion);
      expect(match?.[1]?.split(".").map(Number)).toEqual([1, 3, 14]);
      expect(match?.[2]).toBe(bunDigest);
    }
    expect(dockerfile).not.toMatch(/^FROM\s+oven\/bun:[^@\s]+(?:\s|$)/m);
  });

  test("keeps retained base evidence aligned with the Dockerfile Bun pin", () => {
    const audit = source("packaging/docker/prepare-release-audit.ts");
    const auditBunDigests = [
      ...audit.matchAll(
        /identity:\s*"docker\.io\/oven\/bun@sha256:([a-f0-9]{64})"/g,
      ),
    ].map((match) => match[1]);

    expect(auditBunDigests).toEqual([bunDigest]);
  });

  test("schedules monthly versioned Bun checkpoint updates only", () => {
    const config = Bun.YAML.parse(source(".github/dependabot.yml"));

    expect(config).toEqual({
      version: 2,
      updates: [
        {
          "package-ecosystem": "docker",
          directory: "/packaging/docker",
          schedule: { interval: "monthly" },
          allow: [{ "dependency-name": "oven/bun" }],
          "open-pull-requests-limit": 1,
        },
      ],
    });
  });

  test("preserves dependency layers across source edits", () => {
    const dockerfile = source("packaging/docker/Dockerfile");
    const rootInstall = dockerfile.indexOf(
      "bun install --frozen-lockfile --linker=hoisted",
    );

    expect(rootInstall).toBeGreaterThan(
      dockerfile.indexOf("FROM manifests AS deps"),
    );
    expect(rootInstall).toBeLessThan(
      dockerfile.indexOf("COPY dev/scripts/install-first-party-apps.ts"),
    );
    expect(rootInstall).toBeLessThan(
      dockerfile.indexOf("COPY apps/workbench                apps/workbench"),
    );
  });

  test("keeps raw exact-image reports in CI or release artifact storage", () => {
    const gitignore = source(".gitignore");
    const evidenceRoot = join(repoRoot, "packaging/docker/evidence");
    const rawEvidenceFiles = Array.from(
      new Bun.Glob("source-*/**/*").scanSync({
        cwd: evidenceRoot,
        onlyFiles: true,
      }),
    );

    expect(gitignore).toContain("/packaging/docker/evidence/source-*/");
    expect(rawEvidenceFiles).toEqual([]);
  });

  test("keeps canonical Compose deploy authority on the public runtime digest", () => {
    const registryOverlay = source(
      "deploy/compose-driver/src/buildRegistryOverlay.ts",
    );
    const deploy = source("apps/cli/src/commands/deploy.ts");
    const profileCommand = source("apps/cli/src/commands/profile.ts");
    const profileSchema = source("apps/cli/src/lib/profile-schema.ts");
    const upgrade = source("apps/cli/src/commands/upgrade.ts");
    const composeDriver = source("deploy/compose-driver/src/ComposeDriver.ts");

    expect(registryOverlay).toContain(
      'CANONICAL_RUNTIME_IMAGE = "ghcr.io/agentsea/nautilo-runtime-v2"',
    );
    const digest = `sha256:${"a".repeat(64)}`;
    for (const repository of ["ghcr.io/agentsea/nautilo-runtime-v2", "ghcr.io/agentsea/nautilo-runtime"]) {
      expect(buildRegistryImageRef(`${repository}@${digest}`)).toBe(`${repository}@${digest}`);
      for (const invalid of [repository, `${repository}:latest`, `${repository}@sha256:abc`, `${repository}@${digest}extra`, `${repository.replace("ghcr.io", "ghcrXio")}@${digest}`]) {
        expect(() => buildRegistryImageRef(invalid)).toThrow();
      }
    }
    expect(() => buildRegistryImageRef(`ghcr.io/agentsea/nautilo-server@${digest}`)).toThrow();
    expect(registryOverlay).not.toContain("ghcr.io/agentsea/nautilo-server");
    expect(deploy).not.toContain('.option("tag"');
    expect(deploy).toContain("await resolveStableRuntimeImage()");
    expect(deploy).toContain("buildRegistryImageRef(imageRef)");
    expect(profileCommand).not.toContain('.option("tag"');
    expect(profileCommand).not.toContain('.option("image"');
    expect(profileSchema).toContain('delete out["tag"]');
    expect(profileSchema).toContain('delete out["from_source"]');
    expect(profileSchema).toContain('delete out["image_ref"]');
    expect(upgrade).toContain("await resolveStableRuntimeImage()");
    expect(upgrade).toContain("buildRegistryImageRef(imageRef)");
    expect(composeDriver).not.toContain("profile.tag");
    expect(composeDriver).toContain(
      'return buildRegistryImageRef(profile.image_ref ?? "");',
    );
  });
});
