import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
type Job = { if?: string; environment?: unknown; permissions?: Record<string, string>; steps?: unknown[] };
type Workflow = { permissions?: Record<string, string>; jobs: Record<string, Job> };
const workflows = Object.fromEntries(readdirSync(join(root, ".github/workflows")).map((name) => [
  name, Bun.YAML.parse(readFileSync(join(root, ".github/workflows", name), "utf8")) as Workflow,
]));
test("product workflows carry no official publishing or signing authority", () => {
  for (const [name, workflow] of Object.entries(workflows)) {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const write = Object.entries(job.permissions ?? workflow.permissions ?? {}).some(([permission, value]) =>
        ["contents", "packages", "id-token", "attestations"].includes(permission) && value === "write");
      expect(write, `${name}/${id} must not publish official artifacts`).toBe(false);
      expect(job.environment, `${name}/${id} must not acquire release environments`).toBeUndefined();
      expect(JSON.stringify(job.steps), `${name}/${id} must not acquire signing keys`).not.toMatch(/secrets\.(?:MACOS_|NAUTILO_.*SIGNING)/u);
    }
  }
});

test("migrated official release workflows are absent from product source", () => {
  for (const name of ["desktop-release.yml", "desktop-branch-qualification.yml", "computer-use-host-release.yml", "cli-release.yml", "security-scanner-release.yml", "build-server-image.yml", "build-bootstrap-image.yml", "assemble-railway-qualification-release.yml"]) {
    expect(workflows[name]).toBeUndefined();
  }
});

test("extracted private Cloud provider-management tooling stays outside product source", () => {
  for (const path of [
    "packages/provider-management",
    "apps/cli/scripts/qualify-managed-provider.ts",
    "apps/cli/tests/unit/provider-qualification-script.test.ts",
  ]) {
    expect(existsSync(join(root, path)), `${path} must remain in the private Cloud repository`).toBe(false);
  }

  const cliPackage = JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  expect(cliPackage.dependencies["@nautilo/provider-management"]).toBeUndefined();
  expect(cliPackage.scripts["qualify:providers"]).toBeUndefined();
  expect(readFileSync(join(root, "bun.lock"), "utf8")).not.toContain("@nautilo/provider-management");
  expect(readFileSync(join(root, "packaging/docker/Dockerfile"), "utf8")).not.toContain(
    "packages/provider-management",
  );
  expect(
    readFileSync(join(root, "packages/encryption-invariants/generated/encryption-coverage.md"), "utf8"),
  ).not.toContain("packages/provider-management");
});

test("Host source retains contributor compilation without its official publisher", () => {
  for (const path of [".github/workflows/computer-use-host-release.yml", "apps/desktop/scripts/publish-computer-use-host.ts"]) {
    expect(existsSync(join(root, path)), `${path} must not return to product source`).toBe(false);
  }
  const hostPackage = JSON.parse(readFileSync(join(root, "packages/computer-use-host/package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const architecture of ["arm64", "x64"]) {
    expect(hostPackage.scripts["build:executable"]).toContain(`build:executable:${architecture}`);
    expect(hostPackage.scripts[`build:executable:${architecture}`]).toContain(`bun build --compile --target=bun-darwin-${architecture}`);
  }
  expect(hostPackage.scripts["build:executable"]).toContain("lipo -create");
});

test("official server signer and publisher implementations stay outside product source", () => {
  for (const path of [
    "packages/hosting/src/release-publication.ts",
    "packages/hosting/src/server-release-publication.ts",
    "packaging/docker/publish-runtime-image.ts",
    "packaging/docker/publish-bootstrap-image.ts",
    "packaging/docker/runtime-artifact-record.ts",
    "packaging/docker/bootstrap-artifact-record.ts",
    "packaging/docker/release-workflow-authority.ts",
    "packaging/docker/release-promotion-authority.ts"
]) {
    expect(existsSync(join(root, path)), `${path} must not return to product source`).toBe(false);
  }
  const hosting = JSON.parse(readFileSync(join(root, "packages/hosting/package.json"), "utf8")) as { scripts: Record<string, string> };
  expect(hosting.scripts["release:manifest"]).toBeUndefined();
  expect(readFileSync(join(root, "packages/hosting/src/index.ts"), "utf8")).not.toContain("release-publication");
});
