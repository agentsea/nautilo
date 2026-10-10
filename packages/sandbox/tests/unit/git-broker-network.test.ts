import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fetchNetwork, prepareNetworkPush, pushNetwork, type GitNetworkDependencies, type GitNetworkPushPreparation } from "../../src/git-broker/network";
import { captureNetworkRepository } from "../../src/git-broker/transaction";
import { compileGitBrokerProfile, compileGitNetworkObjectProfile } from "../../src/git-broker/profile";

function fixture() {
  let current = true; let coherent = true; let calls = 0; let sent = 0;
  const effects: string[] = [];
  const prepared: GitNetworkPushPreparation = {
    remote: { repository: "fixture-org/project", repositoryId: 12, accountId: 5, accountLogin: "fixture-user", branch: "main", oid: "a".repeat(40) },
    local: { identity: { workTree: "/fixture/project", gitDir: "/fixture/project/.git", commonDir: "/fixture/project/.git", isLinkedWorktree: false },
      sourceBranch: "main", sourceOid: "b".repeat(40), objectFormat: "sha1", indexHash: "c".repeat(64), repositoryStamp: "d".repeat(64) },
  };
  const deps: GitNetworkDependencies = {
    local: {
      capture: () => Promise.resolve(structuredClone(prepared.local)),
      revalidate: () => Promise.resolve(coherent), isCurrentNow: () => coherent,
      readTrackingRef: () => Promise.resolve(null),
      promote: () => { effects.push("objects"); return Promise.resolve(); },
      compareAndSwapTracking: (_snapshot, ref, oid, previous) => { effects.push(`ref:${ref}:${oid}:${previous}`); return Promise.resolve(true); },
      isAncestor: () => Promise.resolve(true),
    },
    transport: {
      inspect: () => { calls++; return Promise.resolve(structuredClone(prepared.remote)); },
      withFetchedObjects: async (_input, consume) => await consume("/fixture/private/objects"),
      push: input => {
        if (!input.beforeSend()) return Promise.resolve({ outcome: "rejected", sent: false });
        sent++; return Promise.resolve({ outcome: "pushed", sent: true });
      },
    },
  };
  return { prepared, deps, effects, isCurrent: () => current, revoke: () => { current = false; }, drift: () => { coherent = false; },
    calls: () => calls, sent: () => sent };
}

test("fetch promotes quarantine then CASes only a broker-owned tracking ref", async () => {
  const f = fixture();
  const result = await fetchNetwork({ repository: "fixture-org/project", branch: "main", isCurrent: f.isCurrent }, f.deps);
  expect(result).toMatchObject({ ok: true, sideEffectStarted: true, retrySafe: false, trackingRef: "refs/remotes/nautilo-github/12/main" });
  expect(f.effects).toEqual(["objects", `ref:refs/remotes/nautilo-github/12/main:${"a".repeat(40)}:null`]);
});
test("invalid destinations and source grammar never reach account transport", async () => {
  for (const branch of ["--upload-pack=evil", "../secret", "refs/../main", "main:other", "main\nnext"]) {
    const f = fixture();
    // Leading dash is forbidden by Git ref syntax at the broker boundary.
    const result = await prepareNetworkPush({ repository: "fixture-org/project", sourceBranch: branch, destinationBranch: "main", isCurrent: f.isCurrent }, f.deps);
    expect(result).toBeNull(); expect(f.calls()).toBe(0);
  }
});
test("authority loss during fetch leaves repository untouched", async () => {
  const f = fixture();
  f.deps.transport.withFetchedObjects = async (_input, consume) => { f.revoke(); return await consume("/fixture/private/objects"); };
  expect(await fetchNetwork({ repository: "fixture-org/project", branch: "main", isCurrent: f.isCurrent }, f.deps)).toMatchObject({ reason: "authority_changed", sideEffectStarted: false });
  expect(f.effects).toEqual([]);
});
test("ref drift after object promotion is not mislabeled retry-safe", async () => {
  const f = fixture();
  f.deps.local.compareAndSwapTracking = () => Promise.resolve(false);
  expect(await fetchNetwork({ repository: "fixture-org/project", branch: "main", isCurrent: f.isCurrent }, f.deps)).toMatchObject({ reason: "repository_changed", sideEffectStarted: true, retrySafe: false });
});
test("push preparation refuses non-fast-forward and changed local repository", async () => {
  const f = fixture();
  f.deps.local.isAncestor = () => Promise.resolve(false);
  expect(await prepareNetworkPush({ repository: "fixture-org/project", sourceBranch: "main", destinationBranch: "main", isCurrent: f.isCurrent }, f.deps)).toBeNull();
  f.deps.local.isAncestor = () => { f.drift(); return Promise.resolve(true); };
  expect(await prepareNetworkPush({ repository: "fixture-org/project", sourceBranch: "main", destinationBranch: "main", isCurrent: f.isCurrent }, f.deps)).toBeNull();
});
test("push has no transport effect without exact explicit approval", async () => {
  const f = fixture();
  expect(await pushNetwork({ prepared: f.prepared, approved: false, consume: () => { throw new Error("No consume"); }, isCurrent: f.isCurrent }, f.deps)).toMatchObject({ reason: "approval_required", sideEffectStarted: false });
  expect(f.calls()).toBe(0); expect(f.sent()).toBe(0);
});
test("changed remote account, repository, branch or OID reparks before consumption", async () => {
  for (const change of [{ accountId: 99 }, { repositoryId: 99 }, { branch: "other" }, { oid: "c".repeat(40) }]) {
    const f = fixture();
    f.deps.transport.inspect = () => Promise.resolve({ ...f.prepared.remote, ...change });
    expect(await pushNetwork({ prepared: f.prepared, approved: true, consume: () => { throw new Error("No consume"); }, isCurrent: f.isCurrent }, f.deps)).toMatchObject({ reason: "remote_changed", sideEffectStarted: false });
    expect(f.sent()).toBe(0);
  }
});
test("source drift during transport preparation fails final synchronous gate", async () => {
  const f = fixture(); let consumed = 0;
  f.deps.transport.push = input => { f.drift(); expect(input.beforeSend()).toBe(false); return Promise.resolve({ outcome: "rejected", sent: false }); };
  expect(await pushNetwork({ prepared: f.prepared, approved: true, consume: () => { consumed++; return true; }, isCurrent: f.isCurrent }, f.deps)).toMatchObject({ sideEffectStarted: false });
  expect(consumed).toBe(0);
});
test("one push cannot consume twice, and a lost reply stays unknown", async () => {
  const f = fixture(); let consumed = 0;
  f.deps.transport.push = input => { expect(input.beforeSend()).toBe(true); expect(input.beforeSend()).toBe(false); throw new Error("Reply lost"); };
  expect(await pushNetwork({ prepared: f.prepared, approved: true, consume: () => { consumed++; return true; }, isCurrent: f.isCurrent }, f.deps)).toMatchObject({ reason: "outcome_unknown", sideEffectStarted: true, retrySafe: false });
  expect(consumed).toBe(1);
});
test("post-send revocation suppresses success without making input retryable", async () => {
  const f = fixture();
  f.deps.transport.push = input => { expect(input.beforeSend()).toBe(true); f.revoke(); return Promise.resolve({ outcome: "pushed", sent: true }); };
  expect(await pushNetwork({ prepared: f.prepared, approved: true, consume: () => true, isCurrent: f.isCurrent }, f.deps)).toMatchObject({ reason: "outcome_unknown", retrySafe: false });
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-network-fixture-"))); roots.push(root);
  const workTree = join(root, "project"); const gitDir = join(workTree, ".git");
  mkdirSync(join(gitDir, "refs", "heads"), { recursive: true }); mkdirSync(join(gitDir, "objects"));
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n"); writeFileSync(join(gitDir, "refs", "heads", "main"), `${"a".repeat(40)}\n`);
  writeFileSync(join(gitDir, "config"), "[core]\n repositoryformatversion = 0\n");
  return { root, identity: { workTree, gitDir, commonDir: gitDir, isLinkedWorktree: false } };
}
test("canonical metadata stamp detects ref, index and config drift without executing Git", () => {
  const f = repository(); const original = captureNetworkRepository(f.identity, "main");
  for (const [path, content] of [["refs/heads/main", `${"b".repeat(40)}\n`], ["index", "changed"], ["config", "[include]\n path = hostile\n"]]) {
    writeFileSync(join(f.identity.gitDir, path!), content!);
    expect(captureNetworkRepository(f.identity, "main").repositoryStamp).not.toBe(original.repositoryStamp);
  }
});
test("metadata capture refuses a symlinked ref parent", () => {
  const f = repository(); const outside = join(f.root, "outside"); mkdirSync(outside);
  rmSync(join(f.identity.gitDir, "refs", "heads"), { recursive: true }); symlinkSync(outside, join(f.identity.gitDir, "refs", "heads"), process.platform === "win32" ? "junction" : "dir");
  expect(() => captureNetworkRepository(f.identity, "main")).toThrow("Unsafe ref parent");
});
test("network object and ref profiles revoke broader writes before exact allow", () => {
  const f = repository();
  const object = compileGitNetworkObjectProfile({ identity: f.identity, gitExecutable: "/usr/bin/git", objectsPath: "/fixture/private/objects", write: true });
  expect(object.lastIndexOf("(deny file-write*)")).toBeLessThan(object.lastIndexOf(`(allow file-write* (subpath ${JSON.stringify(join(f.identity.commonDir, "objects"))}))`));
  const ref = compileGitBrokerProfile({ operation: "commit", identity: f.identity, gitExecutable: "/usr/bin/git", networkRef: true, refName: "refs/remotes/nautilo-github/12/main" });
  expect(ref).toContain("(deny file-write*)\n(deny network*)");
  expect(ref.slice(ref.lastIndexOf("(deny file-write*)"))).not.toContain('(subpath');
});
test.skipIf(process.platform !== "darwin")("actual object sandbox rejects a swapped object-directory symlink outside repository", () => {
  const f = repository(); const outside = join(f.root, "outside"); mkdirSync(outside);
  const objectPath = join(f.identity.commonDir, "objects");
  const profile = compileGitNetworkObjectProfile({ identity: f.identity, gitExecutable: "/bin/sh", objectsPath: join(f.root, "source"), write: true });
  rmSync(objectPath, { recursive: true }); symlinkSync(outside, objectPath);
  const attempt = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", 'printf denied > "$1/probe"', "fixture", objectPath],
    { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8" });
  expect(attempt.status).not.toBe(0);
  expect(() => readFileSync(join(outside, "probe"))).toThrow();
});

test.skipIf(process.platform !== "darwin")("actual tracking-ref sandbox permits exact ref but denies a swapped parent", () => {
  const f = repository(); const outside = join(f.root, "outside"); mkdirSync(outside);
  const refName = "refs/remotes/nautilo-github/12/main";
  const refPath = join(f.identity.commonDir, refName); mkdirSync(join(f.identity.commonDir, "refs/remotes/nautilo-github/12"), { recursive: true });
  const profile = compileGitBrokerProfile({ operation: "commit", identity: f.identity, gitExecutable: "/bin/sh", networkRef: true, refName });
  const write = () => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", 'printf fixture > "$1"', "fixture", refPath],
    { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8" });
  expect(write().status).toBe(0);
  expect(readFileSync(refPath, "utf8")).toBe("fixture");
  rmSync(join(f.identity.commonDir, "refs/remotes/nautilo-github/12"), { recursive: true });
  symlinkSync(outside, join(f.identity.commonDir, "refs/remotes/nautilo-github/12"));
  expect(write().status).not.toBe(0);
  expect(() => readFileSync(join(outside, "main"))).toThrow();
});
test.skipIf(process.platform !== "darwin")("private object read exception does not open adjacent credential/config storage", () => {
  const f = repository(); const privateRoot = join(f.root, "private"); const objectsPath = join(privateRoot, "objects");
  mkdirSync(objectsPath, { recursive: true }); writeFileSync(join(objectsPath, "fixture"), "safe-object"); writeFileSync(join(privateRoot, "config"), "synthetic-config");
  const profile = compileGitNetworkObjectProfile({ identity: f.identity, gitExecutable: "/bin/cat", objectsPath, write: false, protectedPaths: [privateRoot] });
  const read = (path: string) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/cat", path], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  expect(read(join(objectsPath, "fixture")).stdout).toBe("safe-object");
  expect(read(join(privateRoot, "config")).status).not.toBe(0);
});

test.skipIf(process.platform !== "darwin")("real GitBroker fetch streams synthetic objects and CASes a tracking ref without changing HEAD or index", async () => {
  const { GitBroker } = await import("../../src/git-broker/broker");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-network-native-"))); roots.push(root);
  const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const git = spawnSync("/usr/bin/xcrun", ["--find", "git"], { env: environment, encoding: "utf8" }).stdout.trim();
  if (!git.startsWith("/")) throw new Error("Apple Git unavailable");
  const run = (cwd: string, args: readonly string[]) => {
    const result = spawnSync(git, [...args], { cwd, env: environment, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Fixture Git failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const source = join(root, "source"); const destination = join(root, "destination");
  mkdirSync(source); mkdirSync(destination);
  run(source, ["init", "-b", "main"]); run(destination, ["init", "-b", "main"]);
  writeFileSync(join(source, "fixture.txt"), "synthetic network Git fixture\n");
  run(source, ["add", "fixture.txt"]);
  run(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Synthetic fixture"]);
  const oid = run(source, ["rev-parse", "HEAD"]);
  const broker = new GitBroker({ authority: { repository: destination, grantedRoots: [destination], protectedPaths: [source] }, gitExecutable: git,
    networkExecution: { timeoutMs: 5_000, captureBytes: 4_096 } });
  const transport: GitNetworkDependencies["transport"] = {
    inspect: () => Promise.resolve({ repository: "fixture-org/project", repositoryId: 12, accountId: 5, accountLogin: "fixture-user", branch: "main", oid }),
    withFetchedObjects: async (_input, consume) => await consume(join(source, ".git", "objects")),
    push: () => { throw new Error("Fetch must never push"); },
  };
  const headBefore = readFileSync(join(destination, ".git", "HEAD"), "utf8");
  const fetched = await broker.fetch({ repository: "fixture-org/project", branch: "main", isCurrent: () => true }, transport);
  expect(fetched).toMatchObject({ ok: true, trackingRef: "refs/remotes/nautilo-github/12/main" });
  expect(run(destination, ["rev-parse", "refs/remotes/nautilo-github/12/main"])).toBe(oid);
  expect(run(destination, ["cat-file", "-p", `${oid}:fixture.txt`])).toBe("synthetic network Git fixture");
  expect(readFileSync(join(destination, ".git", "HEAD"), "utf8")).toBe(headBefore);
  expect(() => readFileSync(join(destination, ".git", "index"))).toThrow();
  expect(() => readFileSync(join(destination, "fixture.txt"))).toThrow();
  // Exact source commit review uses the same real Git ancestry path. All local
  // mutations below remain inside these synthetic disposable repositories.
  run(destination, ["update-ref", "refs/heads/main", oid]);
  const review = await broker.preparePush({ repository: "fixture-org/project", sourceBranch: "main", destinationBranch: "main", isCurrent: () => true }, transport);
  expect(review?.local.sourceOid).toBe(oid);
  if (!review) throw new Error("Push review unavailable");
  let sent = 0;
  transport.push = input => { expect(input.beforeSend()).toBe(true); sent++; return Promise.resolve({ outcome: "pushed", sent: true }); };
  expect(await broker.push({ prepared: review, approved: true, consume: () => true, isCurrent: () => true }, transport)).toMatchObject({ ok: true, retrySafe: false });
  writeFileSync(join(destination, ".git", "index"), "synthetic drift");
  expect(await broker.push({ prepared: review, approved: true, consume: () => { throw new Error("No consumption after drift"); }, isCurrent: () => true }, transport)).toMatchObject({ reason: "authority_changed", sideEffectStarted: false });
  expect(sent).toBe(1);
  const sha256 = join(root, "sha256"); mkdirSync(sha256); run(sha256, ["init", "--object-format=sha256", "-b", "main"]);
  const otherFormat = new GitBroker({ authority: { repository: sha256, grantedRoots: [sha256], protectedPaths: [source] }, gitExecutable: git,
    networkExecution: { timeoutMs: 5_000, captureBytes: 4_096 } });
  let fetchedObjects = false;
  transport.withFetchedObjects = async (_input, consume) => { fetchedObjects = true; return await consume(join(source, ".git", "objects")); };
  expect(await otherFormat.fetch({ repository: "fixture-org/project", branch: "main", isCurrent: () => true }, transport)).toMatchObject({ reason: "remote_changed", sideEffectStarted: false });
  expect(fetchedObjects).toBe(false);
}, 15_000);
