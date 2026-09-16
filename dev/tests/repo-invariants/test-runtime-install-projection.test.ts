import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RUNTIME_INSTALL_DIR,
  computeProductionClosure,
  generateRuntimeInstall,
  loadWorkspaceManifests,
  type WorkspaceManifest,
} from "../../../packaging/docker/generate-runtime-install";

const ENTRY = "@nautilo/server-bin";
const ROOT_DIR = join(import.meta.dir, "../../..");

type NanoIdResolution = { key: string; version: string };

function nanoIdResolutions(lock: string): NanoIdResolution[] {
  return [...lock.matchAll(/^\s*"([^"]*nanoid)": \["nanoid@([^"]+)"/gm)]
    .map((match) => ({ key: match[1]!, version: match[2]! }))
    .filter(({ key }) => key === "nanoid" || key.endsWith("/nanoid"));
}

function isAffectedNanoId(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (major < 3) return true;
  if (major === 3) return minor < 3 || (minor === 3 && patch < 16);
  if (major === 4) return true;
  return major === 5 && (minor < 1 || (minor === 1 && patch < 16));
}

function cloneWorkspaces(source: ReadonlyMap<string, WorkspaceManifest>): Map<string, WorkspaceManifest> {
  return new Map([...source].map(([name, workspace]) => [name, structuredClone(workspace)]));
}

describe("D490 generated runtime install projection", () => {
  test("checked-in generated files reconstruct exactly", () => {
    expect(() => generateRuntimeInstall({ check: true })).not.toThrow();
  });

  test("follows production workspace dependencies and excludes test-only workspaces", () => {
    const closure = computeProductionClosure(ENTRY, loadWorkspaceManifests());
    expect(closure.size).toBe(41);
    expect(closure.has("@nautilo/office-docs")).toBe(true);
    expect(closure.has("@nautilo/office-core")).toBe(true);
    expect(closure.has("@nautilo/api-client")).toBe(true);
    expect(closure.has("@nautilo/computer-use-host-protocol")).toBe(true);
    expect(closure.has("@nautilo/encryption-invariants")).toBe(true);
    expect(closure.has("@nautilo/event-feed")).toBe(true);
    expect(closure.has("@nautilo/realtime-client")).toBe(false);
    expect(closure.has("@nautilo/server")).toBe(true);
    expect(closure.has("@nautilo/reflection")).toBe(true);
    expect(closure.has("@nautilo/reflection-bridge")).toBe(true);
  });

  test("adding a dev dependency cannot alter runtime inventory", () => {
    const workspaces = cloneWorkspaces(loadWorkspaceManifests());
    const baseline = [...computeProductionClosure(ENTRY, workspaces)].sort();
    workspaces.get(ENTRY)!.manifest.devDependencies = {
      ...workspaces.get(ENTRY)!.manifest.devDependencies,
      "@nautilo/realtime-client": "workspace:*",
    };
    expect([...computeProductionClosure(ENTRY, workspaces)].sort()).toEqual(baseline);
  });

  test("a missing required production edge fails closed", () => {
    const workspaces = cloneWorkspaces(loadWorkspaceManifests());
    workspaces.get(ENTRY)!.manifest.dependencies = {
      ...workspaces.get(ENTRY)!.manifest.dependencies,
      "@nautilo/missing-runtime-workspace": "workspace:*",
    };
    expect(() => computeProductionClosure(ENTRY, workspaces)).toThrow(
      "requires missing production workspace @nautilo/missing-runtime-workspace",
    );
  });

  test("local file dependencies must resolve to the registered workspace", () => {
    const workspaces = cloneWorkspaces(loadWorkspaceManifests());
    workspaces.get("@nautilo/office-docs")!.manifest.dependencies!["@nautilo/office-core"] = "file:../unrelated";
    expect(() => computeProductionClosure(ENTRY, workspaces)).toThrow("does not name its registered workspace");
  });

  test("owned package version pins cannot silently fall back to a registry version", () => {
    const workspaces = cloneWorkspaces(loadWorkspaceManifests());
    workspaces.get("@nautilo/office-docs")!.manifest.dependencies!["@nautilo/office-core"] = "0.4.9";
    expect(() => computeProductionClosure(ENTRY, workspaces)).toThrow("not its registered workspace version");
  });

  test("projected manifests contain no development dependency or script input", () => {
    const projection = JSON.parse(
      readFileSync(join(RUNTIME_INSTALL_DIR, "projection.json"), "utf8"),
    ) as { workspaces: Array<{ path: string }> };
    for (const workspace of projection.workspaces) {
      const manifest = JSON.parse(
        readFileSync(join(RUNTIME_INSTALL_DIR, workspace.path, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(manifest["devDependencies"]).toBeUndefined();
      expect(manifest["scripts"]).toBeUndefined();
    }
  });

  test("encryption inventory keeps its TypeScript parser in the server runtime", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(
          RUNTIME_INSTALL_DIR,
          "packages/encryption-invariants/package.json",
        ),
        "utf8",
      ),
    ) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies?.["typescript"]).toBe("5.9.3");
  });

  test("rejects the affected Nano ID resolution and accepts the patched resolution", () => {
    const affected = nanoIdResolutions('    "nanoid": ["nanoid@5.1.11", ""]');
    const patched = nanoIdResolutions('    "nanoid": ["nanoid@5.1.16", ""]');

    expect(affected.filter(({ version }) => isAffectedNanoId(version))).toEqual(affected);
    expect(patched.filter(({ version }) => isAffectedNanoId(version))).toEqual([]);
  });

  test("server and packaged Desktop Nano ID inputs stay on their reviewed boundaries", () => {
    const runtime = nanoIdResolutions(readFileSync(join(RUNTIME_INSTALL_DIR, "bun.lock"), "utf8"));
    const root = nanoIdResolutions(readFileSync(join(ROOT_DIR, "bun.lock"), "utf8"));
    const devOnly = root.filter(({ key }) => key === "@withtyped/server/nanoid");
    const packaged = root.filter(({ key }) => key !== "@withtyped/server/nanoid");

    expect(runtime).toEqual([{ key: "nanoid", version: "5.1.16" }]);
    expect(runtime.filter(({ version }) => isAffectedNanoId(version))).toEqual([]);
    expect(packaged.filter(({ version }) => isAffectedNanoId(version))).toEqual([]);
    expect(devOnly).toEqual([{ key: "@withtyped/server/nanoid", version: "4.0.2" }]);
  });
});
