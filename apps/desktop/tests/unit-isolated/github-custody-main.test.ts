import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { GitHubInstallationAuthority } from "../../electron/github-broker/installation";

const source = readFileSync(new URL("../../electron/main.ts", import.meta.url), "utf8");
const begin = source.indexOf("let githubInstallationOwner:");
const end = source.indexOf('ipcMain.handle("githubCli:status"', begin);
if (begin < 0 || end < begin) throw new Error("GitHub custody composition missing");
const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(`
let miniAppRecoveryAuthGeneration = 0;
let currentFolderPath = "/workspace/current";
let currentFolderRevision = 1;
let genieWorkspaceRoot = "/workspace/default";
${source.slice(begin, end)}
return { custody: githubAccountCustody, invalidate: () => { miniAppRecoveryAuthGeneration++; githubAccountCustody.retire(); },
 changeFolder: () => { currentFolderPath = "/workspace/new"; currentFolderRevision++; } };
`);
function fixture() {
  const session = { signedIn: true };
  const serverSessions = { active: session };
  const binding = { humanId: "human-a", authority: { scope: "https://server.example", serverFingerprint: "fingerprint-a", revision: 1, connectionAttemptId: "attempt-a" } };
  let revision = 0;
  let probe = () => ({ ok: true, binaryPath: "/app/gh", executableSha256: "a".repeat(64), version: "fixture" });
  let bindingBarrier = async () => {};
  let probes = 0;
  let created = 0;
  let retired = 0;
  let listBarrier = async () => {};
  let retainedIds: string[] = [];
  const grants = [
    { status: "active", grant: { id: "write", canonicalRoot: "/tools/install", access: ["create_modify"] } },
    { status: "active", grant: { id: "delete", canonicalRoot: "/tools/delete", access: ["delete"] } },
    { status: "active", grant: { id: "read", canonicalRoot: "/tools/readonly", access: ["read"] } },
    { status: "revoked", grant: { id: "old", canonicalRoot: "/tools/old", access: ["create_modify"] } },
  ];
  const deps = { serverSessions, app: { isPackaged: false, getPath: () => "/tmp/test-user" },
    resolveReadyToWorkBindingForSession: async () => { await bindingBarrier(); return structuredClone(binding); }, currentReadyBinding: () => binding,
    probeDesktopGitHubRuntime: () => { probes++; return probe(); },
    createGitHubInstallation: (options: { authority: () => Promise<GitHubInstallationAuthority> }) => {
      created++;
      return { verify: () => options.authority(), retire: () => { retired++; } };
    },
    desktopFilesystemGrantStore: { getRevision: () => revision, list: async () => { await listBarrier(); return { ok: true, data: { grants, revision } }; } },
    getLocalExecutionCustodyScope: () => ({ roots: ["/workspace/old-running"], grantIds: retainedIds, isCurrent: () => true }),
  };
  const factory = runInNewContext(`(function(${Object.keys(deps).join(",")}) {${javascript}})`) as (...values: unknown[]) => {
    custody: { getInstallation: () => Promise<{ verify: () => Promise<GitHubInstallationAuthority> }>; retire: () => void };
    invalidate: () => void; changeFolder: () => void;
  };
  return { ...factory(...Object.values(deps)), deps, binding, grants,
    bumpRevision: () => { revision++; }, counts: () => ({ probes, created, retired }),
    setBindingBarrier: (next: typeof bindingBarrier) => { bindingBarrier = next; },
    setProbe: (next: typeof probe) => { probe = next; },
    setListBarrier: (next: typeof listBarrier) => { listBarrier = next; },
    retain: (ids: string[]) => { retainedIds = ids; },
  };
}
async function failure(work: Promise<unknown>) {
  expect(await work.then(() => null, error => error instanceof Error ? error.message : String(error))).toContain("GITHUB_INSTALLATION_UNAVAILABLE");
}

test("one exact authenticated context shares installation without requiring Development", async () => {
  const f = fixture();
  const first = await f.custody.getInstallation();
  expect(await f.custody.getInstallation()).toBe(first);
  expect(f.counts()).toEqual({ probes: 1, created: 1, retired: 0 });
  const authority = await first.verify();
  expect(authority.writableRoots).toEqual(["/workspace/default", "/workspace/current", "/workspace/old-running", "/tools/install", "/tools/delete"]);
  expect(authority.isCurrent()).toBe(true);
  f.bumpRevision();
  expect(authority.isCurrent()).toBe(false);
});

test("only unreleased retained grants keep revoked write roots in custody checks", async () => {
  const f = fixture();
  const installation = await f.custody.getInstallation();
  f.retain(["old"]);
  expect((await installation.verify()).writableRoots).toContain("/tools/old");
  f.retain([]);
  expect((await installation.verify()).writableRoots).not.toContain("/tools/old");
});

test("auth invalidation and exact server replacement fence captured authority", async () => {
  for (const replace of [false, true]) {
    const f = fixture();
    const installation = await f.custody.getInstallation();
    const authority = await installation.verify();
    if (replace) f.deps.serverSessions.active = { signedIn: true };
    else f.invalidate();
    expect(authority.isCurrent()).toBe(false);
    await failure(installation.verify());
  }
});

test("late binding resolution after auth invalidation does not create a custody handle", async () => {
  const f = fixture();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  f.setBindingBarrier(async () => { began(); await barrier; });
  const pending = f.custody.getInstallation();
  await started; f.invalidate(); release();
  await failure(pending);
  expect(f.counts().created).toBe(0);
});

test("missing runtime repairs without caching an unverified identity", async () => {
  const f = fixture();
  f.setProbe(() => { throw new Error("missing"); });
  await failure(f.custody.getInstallation());
  f.setProbe(() => ({ ok: true, binaryPath: "/app/gh", executableSha256: "a".repeat(64), version: "fixture" }));
  await f.custody.getInstallation();
  expect(f.counts().created).toBe(1);
});

test("folder selection changed during grant read cannot authorize the old captured view", async () => {
  const f = fixture(); const installation = await f.custody.getInstallation();
  f.setListBarrier(async () => { f.changeFolder(); });
  const authority = await installation.verify();
  expect(authority.isCurrent()).toBe(false);
});
