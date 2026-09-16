// M118: closure-guard test for the runtime image package set.
//
// The Dockerfile's runtime stage must copy EXACTLY the transitive production
// workspace-package closure of `@nautilo/server-bin` — no workspace-package
// extras, none missing. This test computes the closure from every workspace
// `package.json` and asserts that the Dockerfile's source COPY set matches.
//
// It also asserts the only source COPY under `bin/` is `bin/nautilo-server`
// (the other five entries are dev / operator / desktop tools the container
// never executes).
//
// "Closure" follows production `dependencies` only. Client-only workspaces
// such as `@nautilo/realtime-client` must not leak into the runtime source or
// install inventory. `@nautilo/api-client` is a server runtime dependency as
// of M243 because it canonically owns the protected Memory wire schemas.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeProductionClosure, loadWorkspaceManifests, type WorkspaceManifest } from "../../../../packaging/docker/generate-runtime-install";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const DOCKERFILE_PATH = join(REPO_ROOT, "packaging/docker/Dockerfile");
const SERVER_BIN_NAME = "@nautilo/server-bin";
const NON_WORKSPACE_RUNTIME_PACKAGE_ASSETS = new Set([
  // M182 first-party mini-app seed sources are runtime assets, not workspace packages.
  "first-party-apps",
]);

function parseRuntimePackageCopies(dockerfile: string): Set<string> {
  const out = new Set<string>();
  // Fold Docker continuations so the final token is always the actual COPY
  // destination. A package source copied into an app-local node_modules tree
  // is a first-party runtime asset, not a root server-package copy.
  const instructions = dockerfile.replace(/\\\r?\n\s*/gu, " ").split("\n");
  for (const instruction of instructions) {
    const tokens = instruction.trim().split(/\s+/u);
    if (tokens[0]?.toUpperCase() !== "COPY") continue;
    let firstSource = 1;
    while (tokens[firstSource]?.startsWith("--")) firstSource += 1;
    if (tokens.length - firstSource < 2) continue;
    const destination = tokens.at(-1)!.replace(/^\.\//u, "").replace(/^\//u, "");
    for (const sourceToken of tokens.slice(firstSource, -1)) {
      const source = sourceToken.replace(/^\.\//u, "").replace(/^\/repo\//u, "");
      const match = /^packages\/([\w.-]+)(?:\/|$)/u.exec(source);
      if (!match) continue;
      const packageDir = match[1]!;
      const rootPackageDestination = /^repo\/packages\/([\w.-]+)(?:\/|$)/u.exec(destination)?.[1];
      // first-party-apps is an explicit runtime asset tree; dependencies nested
      // beneath an installed app are not root server packages. Every other
      // immediate packages/ destination is closure-relevant even if renamed.
      if (rootPackageDestination && rootPackageDestination !== "first-party-apps") {
        out.add(packageDir);
      }
    }
  }
  return out;
}

function parseRuntimeBinCopies(dockerfile: string): Set<string> {
  const fromDeps = /^\s*COPY\s+(?:--[^\s]+\s+)*--from=deps\s+\/repo\/bin\/([\w.-]+)\s/gm;
  const fromContext = /^\s*COPY\s+(?:--[^\s=]+\s+)*bin\/([\w.-]+)\s/gm;
  const out = new Set<string>();
  for (const re of [fromDeps, fromContext]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(dockerfile))) {
      out.add(m[1]!);
    }
  }
  return out;
}

function pkgDirsByName(workspaces: ReadonlyMap<string, WorkspaceManifest>): Map<string, string> {
  // name -> subdir basename under packages/ (or undefined if not under packages/)
  const out = new Map<string, string>();
  for (const [name, entry] of workspaces) {
    if (entry.path.startsWith("packages/")) {
      out.set(name, entry.path.slice("packages/".length));
    }
  }
  return out;
}

function extractRuntimeStage(dockerfile: string): string {
  // The `runtime` stage body — every line between
  //   `FROM <image> AS runtime`
  // and the next `FROM ` (or end of file). Used to scope the closure
  // checks so they don't accidentally pick up `COPY packages/<name>`
  // lines from the `workbench-build` stage.
  const lines = dockerfile.split("\n");
  const fromRe = /^FROM\s+\S+\s+AS\s+(\S+)\s*$/i;
  let inRuntime = false;
  const out: string[] = [];
  for (const line of lines) {
    const m = fromRe.exec(line.trim());
    if (m) {
      inRuntime = m[1] === "runtime";
      continue;
    }
    if (inRuntime) out.push(line);
  }
  return out.join("\n");
}

describe("M118 runtime image closure", () => {
  const workspaces = loadWorkspaceManifests();
  const closure = computeProductionClosure(SERVER_BIN_NAME, workspaces);
  const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");
  const runtimeBody = extractRuntimeStage(dockerfile);
  const runtimePackages = parseRuntimePackageCopies(runtimeBody);
  const runtimeBins = parseRuntimeBinCopies(runtimeBody);
  const pkgDirByName = pkgDirsByName(workspaces);

  test("workspace `@nautilo/server-bin` exists", () => {
    expect(workspaces.has(SERVER_BIN_NAME)).toBe(true);
  });

  test("runtime stage copies exactly the transitive closure under packages/", () => {
    const expected = new Set<string>();
    for (const name of closure) {
      const sub = pkgDirByName.get(name);
      if (sub) expected.add(sub);
    }
    const missing = [...expected].filter((s) => !runtimePackages.has(s)).sort();
    const extras = [...runtimePackages]
      .filter((s) => !expected.has(s) && !NON_WORKSPACE_RUNTIME_PACKAGE_ASSETS.has(s))
      .sort();
    expect({ missing, extras }).toEqual({ missing: [], extras: [] });
  });

  test("classifies package copies by their root-server destination", () => {
    const appLocal = parseRuntimePackageCopies(`
      COPY packages/generated-media-ui \\
           ./repo/packages/first-party-apps/video/node_modules/@nautilo/generated-media-ui
      COPY packages/db/src/migrations ./migrations
    `);
    expect([...appLocal]).toEqual([]);

    const rootServer = parseRuntimePackageCopies(`
      COPY packages/generated-media-ui ./repo/packages/generated-media-ui
      COPY packages/lattice-crypto/package.json ./repo/packages/lattice-crypto/package.json
      COPY packages/lattice-crypto/LICENSE packages/lattice-crypto/NOTICE ./repo/packages/lattice-crypto/
    `);
    expect([...rootServer].sort()).toEqual(["generated-media-ui", "lattice-crypto"]);
    const expected = new Set([...closure].flatMap((name) => pkgDirByName.get(name) ?? []));
    const extras = [...rootServer].filter((name) => !expected.has(name) && !NON_WORKSPACE_RUNTIME_PACKAGE_ASSETS.has(name));
    expect(extras).toEqual(["generated-media-ui"]);
    expect([...parseRuntimePackageCopies("COPY packages/generated-media-ui ./repo/packages/unexpected-name")]).toEqual(["generated-media-ui"]);
  });

  test("runtime stage copies only `nautilo-server` from bin/", () => {
    expect([...runtimeBins].sort()).toEqual(["nautilo-server"]);
  });

  test("runtime stage does NOT copy the full /repo/packages tree (any source)", () => {
    // Catches regressions to either of the pre-fix shapes:
    //   COPY --from=server-deps /repo/packages ./repo/packages   (pre-M118)
    //   COPY --from=deps /repo/packages packages                 (incomplete-M118)
    //   COPY packages ./repo/packages                            (context-bulk)
    const fromDeps = /^\s*COPY\s+(?:--[^\s]+\s+)*--from=deps\s+\/repo\/packages\s+/m;
    const fromContext = /^\s*COPY\s+(?:--[^\s=]+\s+)*packages\s+/m;
    expect(fromDeps.test(runtimeBody)).toBe(false);
    expect(fromContext.test(runtimeBody)).toBe(false);
  });

  test("runtime stage does NOT copy the full /repo/bin tree (any source)", () => {
    const fromDeps = /^\s*COPY\s+(?:--[^\s]+\s+)*--from=deps\s+\/repo\/bin\s+/m;
    const fromContext = /^\s*COPY\s+(?:--[^\s=]+\s+)*bin\s+/m;
    expect(fromDeps.test(runtimeBody)).toBe(false);
    expect(fromContext.test(runtimeBody)).toBe(false);
  });

  test("runtime stage restores workspace-local links from the generated install", () => {
    expect(runtimeBody).toContain(
      "COPY --from=runtime-deps /repo/bin/nautilo-server ./repo/bin/nautilo-server",
    );
    expect(runtimeBody).toContain("COPY --from=runtime-deps /repo/packages ./repo/packages");
  });

  test("production install layers remove source maps and build logs before export", () => {
    expect(dockerfile).toContain("find /repo/packages/first-party-apps -type f -name '*.map' -delete");
    expect(dockerfile).toContain("find /repo/node_modules /repo/bin /repo/packages -type f -name '*.map' -delete");
    expect(dockerfile.match(/-name __tests__/g)).toHaveLength(2);
    expect(dockerfile.match(/-name examples/g)).toHaveLength(2);
    expect(dockerfile.match(/! -exec test -f '\{}\/package\.json' ';'/g)).toHaveLength(2);
  });

  test("runtime refreshes base packages and owns its source revision label", () => {
    expect(runtimeBody).toContain("apt-get upgrade -y --no-install-recommends");
    expect(runtimeBody).toContain("ARG NAUTILO_SOURCE_SHA\n");
    expect(runtimeBody).toContain("grep -Eq '^[0-9a-f]{40}([0-9a-f]{24})?$'");
    expect(runtimeBody).toContain("org.opencontainers.image.revision=\"${NAUTILO_SOURCE_SHA}\"");
    expect(runtimeBody).not.toContain("ca-certificates curl");
    expect(runtimeBody).toContain("CMD bun -e");
  });

  test("runtime retains the OfficeCLI headless screenshot backend", () => {
    expect(runtimeBody).toContain("chromium-headless-shell");
    expect(runtimeBody).toContain("ln -s /usr/bin/chromium-headless-shell /usr/bin/chromium");
  });

  test("runtime copies only the vendored Lattice crypto surface, not its builder tree", () => {
    expect(runtimeBody).toContain("COPY packages/lattice-crypto/vendor");
    expect(runtimeBody).not.toContain("COPY packages/lattice-crypto      ");
    expect(runtimeBody).not.toContain("packages/lattice-crypto/openmls-wasm");
  });
});
