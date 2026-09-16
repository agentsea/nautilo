import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

const publicDocuments = [
  "README.md",
  "DOCS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "README.ai",
  "AGENTS.md",
  "RELEASE.md",
  "CHANGELOG.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "ASSET_PROVENANCE.md",
  ".github/ISSUE_TEMPLATE/01-reproducible-defect.yml",
  ".github/ISSUE_TEMPLATE/02-problem-proposal.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE/specification.md",
  ".cursor/rules/nautilo.md",
  "docs/contributing/spec-template.md",
  "docs/apply-patch-runtime-boundary.md",
  "docs/crypto-browser-compatibility.md",
  "docs/genie-application-bridge.md",
  "docs/officecli-provisioning.md",
  "docs/progressive-tool-activation.md",
  "deploy/README.md",
  "deploy/compose-driver/README.md",
  "deploy/releases/qualification/README.md",
  "ops/README.md",
  "ops/runbooks/CONVENTIONS.md",
  "apps/desktop/README.md",
  "apps/desktop/PACKAGE-MANIFEST.md",
  "apps/desktop/PRODUCTION.md",
  "apps/desktop/PACKAGING.md",
] as const;

const forbiddenPrivateReference =
  /(?:nautilo-docs|github\.com\/agentsea\/nautilo-docs|\/Users\/|https:\/\/nautilo\.dev)/i;

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function repositoryLinks(markdown: string): string[] {
  return [...markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1]?.trim() ?? "")
    .map((target) => {
      if (target.startsWith("<") && target.endsWith(">")) {
        return target.slice(1, -1);
      }
      return target.split(/\s+["']/u, 1)[0] ?? target;
    })
    .filter(
      (target) =>
        target.length > 0 &&
        !target.startsWith("#") &&
        !/^[a-z][a-z0-9+.-]*:/iu.test(target),
    );
}

describe("public documentation inventory", () => {
  test("every canonical public document exists and is indexed", () => {
    const index = read("DOCS.md");

    for (const relativePath of publicDocuments) {
      expect(existsSync(resolve(root, relativePath)), relativePath).toBe(true);
      expect(index, `${relativePath} is missing from DOCS.md`).toContain(
        relativePath,
      );
    }
  });

  test("public documents do not depend on private workspace paths or the retired domain", () => {
    for (const relativePath of publicDocuments) {
      expect(read(relativePath), relativePath).not.toMatch(
        forbiddenPrivateReference,
      );
    }
  });

  test("repository-relative Markdown links resolve inside the public checkout", () => {
    for (const relativePath of publicDocuments.filter((path) =>
      path.endsWith(".md"),
    )) {
      for (const rawTarget of repositoryLinks(read(relativePath))) {
        const withoutFragment = rawTarget.split("#", 1)[0] ?? rawTarget;
        const withoutQuery = withoutFragment.split("?", 1)[0] ?? withoutFragment;
        const decodedTarget = decodeURIComponent(withoutQuery);
        const absoluteTarget = resolve(root, dirname(relativePath), decodedTarget);

        expect(
          existsSync(absoluteTarget),
          `${relativePath} links to missing path ${rawTarget}`,
        ).toBe(true);
      }
    }
  });
});
