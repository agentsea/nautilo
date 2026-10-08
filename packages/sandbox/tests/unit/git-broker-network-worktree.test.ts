import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitBroker } from "../../src/git-broker/broker";
import type { GitNetworkTransport } from "../../src/git-broker/network";
import { compileGitNetworkWorktreeProfile } from "../../src/git-broker/profile";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const limits = { fileCount: 100, blobBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 };
function fixture(objectFormat: "sha1" | "sha256" = "sha1") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "github-worktree-"))); roots.push(root);
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const git = spawnSync("/usr/bin/xcrun", ["--find", "git"], { env, encoding: "utf8" }).stdout.trim();
  if (!git.startsWith("/")) throw new Error("Fixture Apple Git unavailable");
  const run = (cwd: string, args: readonly string[], stdin?: string) => {
    const out = spawnSync(git, [...args], { cwd, env, encoding: "utf8", ...(stdin === undefined ? {} : { input: stdin }) });
    if (out.status !== 0) throw new Error(`Fixture Git failed: ${out.stderr}`);
    return out.stdout.trim();
  };
  const source = join(root, "source"); const folder = join(root, "folder"); const storage = join(root, "protected");
  for (const path of [source, folder, storage]) mkdirSync(path);
  run(source, ["init", `--object-format=${objectFormat}`, "-b", "main"]);
  const commit = () => { run(source, ["add", "--all"]); run(source, ["-c", "user.name=Synthetic", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]); return run(source, ["rev-parse", "HEAD"]); };
  writeFileSync(join(source, "a.txt"), "old\n"); const initial = commit();
  let onFetch: (() => void) | undefined;
  const transport: GitNetworkTransport = {
    inspect: async input => ({ repository: input.repository, branch: input.branch, repositoryId: 12, accountId: 5, accountLogin: "fixture-user", oid: run(source, ["rev-parse", "HEAD"]) }),
    withFetchedObjects: async (input, consume) => {
      const clean = join(storage, `repo-${readdirSync(storage).length}`);
      run(storage, ["clone", "--bare", "--no-hardlinks", source, clean]);
      const emptyTreeOid = run(storage, [`--git-dir=${clean}`, "mktree"], "");
      onFetch?.();
      if (!input.isCurrent()) throw new Error("Revoked fixture transport");
      return consume(join(clean, "objects"), { gitDir: clean, objectFormat, emptyTreeOid });
    },
    push: async () => { throw new Error("Unexpected publishing"); },
  };
  const broker = (repository = folder, executable = git, extraProtected: readonly string[] = []) => new GitBroker({ authority: { repository, grantedRoots: [folder], protectedPaths: [storage, ...extraProtected] }, gitExecutable: executable, networkExecution: { timeoutMs: 15000, captureBytes: 256 * 1024 } });
  const input = { repository: "fixture-org/project", branch: "main", limits, isCurrent: () => true };
  return { root, folder, source, storage, git, env, run, commit, initial, transport, broker, input, setOnFetch: (callback: () => void) => { onFetch = callback; } };
}

test.skipIf(process.platform !== "darwin")("clone creates one absent child under granted Folder through actual sandbox", async () => {
  const f = fixture();
  const result = await f.broker().clone({ ...f.input, directory: "project" }, f.transport);
  expect(result).toMatchObject({ ok: true, sideEffectStarted: true, retrySafe: false, oldOid: null, newOid: f.initial });
  const target = join(f.folder, "project");
  expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("old\n");
  expect(f.run(target, ["rev-parse", "HEAD"])).toBe(f.initial);
  expect(f.run(target, ["status", "--porcelain"])).toBe("");
  expect(readdirSync(target).some(path => path.startsWith(".nautilo-network-"))).toBe(false);
});

test.skipIf(process.platform !== "darwin")("pull applies fast-forward files, preserves noncolliding untracked and uses clean attributes", async () => {
  const f = fixture(); const target = join(f.folder, "project");
  expect((await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).ok).toBe(true);
  writeFileSync(join(target, "keep.txt"), "untracked");
  writeFileSync(join(f.source, "a.txt"), "new\n"); writeFileSync(join(f.source, "b.txt"), "added\n");
  const next = f.commit();
  const result = await f.broker(target).pull(f.input, f.transport);
  expect(result).toMatchObject({ ok: true, oldOid: f.initial, newOid: next, retrySafe: false });
  expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("new\n");
  expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("untracked");
  expect(f.run(target, ["rev-parse", "HEAD"])).toBe(next);
  expect(f.run(target, ["diff", "--exit-code"])).toBe("");
});

test.skipIf(process.platform !== "darwin")("clone refuses occupied/dangling child without overwriting it", async () => {
  const f = fixture(); const target = join(f.folder, "project");
  symlinkSync(join(f.root, "missing"), target);
  expect(await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).toMatchObject({ ok: false, sideEffectStarted: false, retrySafe: true });
  expect(existsSync(target)).toBe(false);
});

test.skipIf(process.platform !== "darwin")("dirty tracked/index and colliding untracked paths refuse pull without changing bytes or HEAD", async () => {
  for (const state of ["tracked", "staged", "collision"] as const) {
    const f = fixture(); const target = join(f.folder, "project");
    expect((await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).ok).toBe(true);
    writeFileSync(join(f.source, "a.txt"), "new\n"); writeFileSync(join(f.source, "new.txt"), "remote\n"); f.commit();
    const edited = state === "collision" ? "new.txt" : "a.txt";
    writeFileSync(join(target, edited), "Human work\n");
    if (state === "staged") f.run(target, ["add", "a.txt"]);
    const index = readFileSync(join(target, ".git/index"));
    const result = await f.broker(target).pull(f.input, f.transport);
    expect(result).toMatchObject({ ok: false, sideEffectStarted: false, retrySafe: true });
    expect(readFileSync(join(target, edited), "utf8")).toBe("Human work\n");
    expect(readFileSync(join(target, ".git/index"))).toEqual(index);
    expect(f.run(target, ["rev-parse", "HEAD"])).toBe(f.initial);
  }
});

test.skipIf(process.platform !== "darwin")("delete/rename, executable and internal symlink transitions preserve literal bytes", async () => {
  const f = fixture(); const target = join(f.folder, "project");
  symlinkSync("a.txt", join(f.source, "link"));
  writeFileSync(join(f.source, "run.sh"), "#!/bin/sh\nexit 0\n"); chmodSync(join(f.source, "run.sh"), 0o755);
  writeFileSync(join(f.source, ".gitattributes"), "*.txt text eol=crlf\n");
  f.commit();
  expect((await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).ok).toBe(true);
  expect(readlinkSync(join(target, "link"))).toBe("a.txt");
  expect(readFileSync(join(target, "a.txt"))).toEqual(Buffer.from("old\n"));
  expect(lstatSync(join(target, "run.sh")).mode & 0o777).toBe(0o755);
  f.run(f.source, ["mv", "a.txt", "renamed.txt"]);
  rmSync(join(f.source, "link")); writeFileSync(join(f.source, "link"), "now regular\n");
  const next = f.commit();
  const result = await f.broker(target).pull(f.input, f.transport);
  expect(result).toMatchObject({ ok: true, newOid: next });
  expect(existsSync(join(target, "a.txt"))).toBe(false);
  expect(readFileSync(join(target, "renamed.txt"))).toEqual(Buffer.from("old\n"));
  expect(readFileSync(join(target, "link"), "utf8")).toBe("now regular\n");
});

test.skipIf(process.platform !== "darwin")("escaping/cyclic links and case-colliding manifests fail before clone creation", async () => {
  for (const state of ["escape", "cycle", "case"] as const) {
    const f = fixture();
    if (state === "escape") symlinkSync("../../outside", join(f.source, "link"));
    if (state === "cycle") { symlinkSync("link2", join(f.source, "link")); symlinkSync("link", join(f.source, "link2")); }
    if (state === "case") {
      const blob = f.run(f.source, ["hash-object", "-w", "--stdin"], "collision\n");
      f.run(f.source, ["update-index", "--add", "--cacheinfo", `100644,${blob},A.TXT`]);
      f.run(f.source, ["-c", "user.name=Synthetic", "-c", "user.email=fixture@example.invalid", "commit", "-m", "case fixture"]);
    } else f.commit();
    const result = await f.broker().clone({ ...f.input, directory: "project" }, f.transport);
    expect(result).toMatchObject({ ok: false, sideEffectStarted: false });
    expect(existsSync(join(f.folder, "project"))).toBe(false);
  }
});

test.skipIf(process.platform !== "darwin")("revocation and canonical Folder replacement during fetch fence clone without touching replacement", async () => {
  for (const state of ["revoked", "root"] as const) {
    const f = fixture(); let current = true;
    f.setOnFetch(() => {
      if (state === "revoked") current = false;
      else { renameSync(f.folder, join(f.root, "old-folder")); mkdirSync(f.folder); }
    });
    expect(await f.broker().clone({ ...f.input, isCurrent: () => current, directory: "project" }, f.transport))
      .toMatchObject({ ok: false, sideEffectStarted: false });
    expect(existsSync(join(f.folder, "project"))).toBe(false);
  }
});

test.skipIf(process.platform !== "darwin")("diverged pull refuses without promoting objects or changing attached HEAD", async () => {
  const f = fixture(); const target = join(f.folder, "project");
  expect((await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).ok).toBe(true);
  writeFileSync(join(target, "local.txt"), "local\n"); f.run(target, ["add", "local.txt"]);
  f.run(target, ["-c", "user.name=Synthetic", "-c", "user.email=fixture@example.invalid", "commit", "-m", "local branch"]);
  const local = f.run(target, ["rev-parse", "HEAD"]);
  writeFileSync(join(f.source, "remote.txt"), "remote\n"); f.commit();
  expect(await f.broker(target).pull(f.input, f.transport)).toMatchObject({ ok: false, reason: "not_fast_forward", sideEffectStarted: false });
  expect(f.run(target, ["rev-parse", "HEAD"])).toBe(local);
  expect(existsSync(join(target, "remote.txt"))).toBe(false);
});

test.skipIf(process.platform !== "darwin")("interrupted worktree apply reports residual index/lock and never rolls back concurrent bytes", async () => {
  const f = fixture(); const target = join(f.folder, "project");
  expect((await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).ok).toBe(true);
  writeFileSync(join(f.source, "a.txt"), "new\n"); const next = f.commit();
  const wrapper = join(f.root, "git-apply-interrupted");
  writeFileSync(wrapper, `#!/bin/sh\napply=false\nfor arg do [ "$arg" = '-u' ] && apply=true; done\nif $apply; then printf 'concurrent bytes\\n' > '${target}/a.txt'; exit 7; fi\nexec '${f.git}' "$@"\n`);
  chmodSync(wrapper, 0o700);
  const result = await f.broker(target, wrapper).pull(f.input, f.transport);
  expect(result).toMatchObject({ ok: false, reason: "outcome_unknown", sideEffectStarted: true, retrySafe: false, oldOid: f.initial, newOid: next });
  expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("concurrent bytes\n");
  expect(f.run(target, ["rev-parse", "HEAD"])).toBe(f.initial);
  expect(result.residualPaths).toContain(join(target, ".git/index.lock"));
  expect(result.residualPaths?.some(path => path.includes(".nautilo-network-"))).toBe(true);
});

test.skipIf(process.platform !== "darwin")("revocation after index publication keeps old ref and reports nonretryable partial state", async () => {
  const f = fixture(); const target = join(f.folder, "project");
  expect((await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).ok).toBe(true);
  const oldIndex = readFileSync(join(target, ".git/index"));
  writeFileSync(join(f.source, "a.txt"), "new\n"); const next = f.commit();
  const result = await f.broker(target).pull({ ...f.input, isCurrent: () => readFileSync(join(target, ".git/index")).equals(oldIndex) }, f.transport);
  expect(result).toMatchObject({ ok: false, reason: "outcome_unknown", sideEffectStarted: true, retrySafe: false, oldOid: f.initial, newOid: next });
  expect(f.run(target, ["rev-parse", "HEAD"])).toBe(f.initial);
  expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("new\n");
  expect(result.residualPaths?.some(path => path.includes(".nautilo-network-"))).toBe(true);
});

test.skipIf(process.platform !== "darwin")("concurrent branch CAS failure never replaces the new branch and reports applied state", async () => {
  const f = fixture(); const target = join(f.folder, "project");
  expect((await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).ok).toBe(true);
  writeFileSync(join(f.source, "a.txt"), "intermediate\n"); const competing = f.commit();
  writeFileSync(join(f.source, "a.txt"), "new\n"); const next = f.commit();
  const wrapper = join(f.root, "git-ref-interrupted");
  writeFileSync(wrapper, `#!/bin/sh\nfor arg do if [ "$arg" = 'update-ref' ]; then '${f.git}' -c core.hooksPath= -c core.logAllRefUpdates=false --git-dir='${target}/.git' update-ref refs/heads/main '${competing}' || exit 9; break; fi; done\nexec '${f.git}' "$@"\n`);
  chmodSync(wrapper, 0o700);
  const result = await f.broker(target, wrapper).pull(f.input, f.transport);
  expect(result).toMatchObject({ ok: false, reason: "outcome_unknown", retrySafe: false, oldOid: f.initial, newOid: next });
  expect(f.run(target, ["rev-parse", "HEAD"])).toBe(competing);
  expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("new\n");
});

test.skipIf(process.platform !== "darwin")("SHA256 clone and fast-forward pull retain exact object format", async () => {
  const f = fixture("sha256"); const target = join(f.folder, "project");
  expect((await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).ok).toBe(true);
  expect(f.run(target, ["rev-parse", "--show-object-format"])).toBe("sha256");
  writeFileSync(join(f.source, "a.txt"), "sha256 new\n"); const next = f.commit();
  expect(await f.broker(target).pull(f.input, f.transport)).toMatchObject({ ok: true, oldOid: f.initial, newOid: next });
  expect(f.run(target, ["rev-parse", "HEAD"])).toBe(next);
});

test.skipIf(process.platform !== "darwin")("materialization policy and absent clean-metadata capability refuse without target creation", async () => {
  const f = fixture();
  expect(await f.broker().clone({ ...f.input, directory: "budgeted", limits: { ...limits, blobBytes: 1 } }, f.transport))
    .toMatchObject({ ok: false, sideEffectStarted: false });
  const oldPeer: GitNetworkTransport = { ...f.transport,
    withFetchedObjects: (input, consume) => f.transport.withFetchedObjects(input, objects => consume(objects)) };
  expect(await f.broker().clone({ ...f.input, directory: "old-peer" }, oldPeer)).toMatchObject({ ok: false, sideEffectStarted: false });
  expect(readdirSync(f.folder)).toEqual([]);
});

test.skipIf(process.platform !== "darwin")("actual apply sandbox refuses a replaced worktree ancestor and keeps private sibling data denied", () => {
  const f = fixture(); const target = join(f.folder, "project"); mkdirSync(target);
  const metadata = join(f.storage, "clean"); mkdirSync(join(metadata, "objects"), { recursive: true });
  writeFileSync(join(metadata, "config"), "safe clean metadata"); writeFileSync(join(f.storage, "private-sibling"), "synthetic private data");
  const profile = compileGitNetworkWorktreeProfile({ identity: { workTree: target, gitDir: join(target, ".git"), commonDir: join(target, ".git"), isLinkedWorktree: false },
    gitExecutable: "/bin/sh", target, phase: "apply", paths: ["a.txt", ".secret", ".env.example"], metadataPath: metadata, objectsPath: join(metadata, "objects"), protectedPaths: [f.storage] });
  const run = (script: string, path: string) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script, "fixture", path], { env: f.env, encoding: "utf8" });
  expect(run('/bin/cat "$1"', join(metadata, "config")).stdout).toBe("safe clean metadata");
  expect(run('/bin/cat "$1"', join(f.storage, "private-sibling")).status).not.toBe(0);
  expect(run('printf forbidden > "$1"', join(target, ".secret")).status).not.toBe(0);
  expect(run('printf public > "$1"', join(target, ".env.example")).status).toBe(0);
  expect(readFileSync(join(target, ".env.example"), "utf8")).toBe("public");
  const outside = join(f.root, "outside"); mkdirSync(outside);
  renameSync(target, join(f.folder, "old-project")); symlinkSync(outside, target);
  expect(run('printf forbidden > "$1"', join(target, "a.txt")).status).not.toBe(0);
  expect(existsSync(join(outside, "a.txt"))).toBe(false);
});

test.skipIf(process.platform !== "darwin")("a concurrent tracked edit at native apply is preserved rather than overwritten", async () => {
  const f = fixture(); const target = join(f.folder, "project");
  expect((await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).ok).toBe(true);
  writeFileSync(join(f.source, "a.txt"), "remote\n"); f.commit();
  const wrapper = join(f.root, "git-concurrent-edit");
  writeFileSync(wrapper, `#!/bin/sh\nfor arg do if [ "$arg" = '-u' ]; then printf 'Human concurrent edit\\n' > '${target}/a.txt'; break; fi; done\nexec '${f.git}' "$@"\n`);
  chmodSync(wrapper, 0o700);
  expect(await f.broker(target, wrapper).pull(f.input, f.transport)).toMatchObject({ ok: false, reason: "outcome_unknown", retrySafe: false });
  expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("Human concurrent edit\n");
  expect(f.run(target, ["rev-parse", "HEAD"])).toBe(f.initial);
});

test.skipIf(process.platform !== "darwin")("pull refuses detached HEAD, staged broker work and wrong object format", async () => {
  const f = fixture(); const target = join(f.folder, "project");
  expect((await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).ok).toBe(true);
  f.run(target, ["checkout", "--detach", f.initial]);
  expect(await f.broker(target).pull(f.input, f.transport)).toMatchObject({ ok: false, sideEffectStarted: false });
  f.run(target, ["checkout", "main"]);
  const wrongFormat: GitNetworkTransport = { ...f.transport, inspect: async input => ({ ...await f.transport.inspect(input), oid: "a".repeat(64) }) };
  expect(await f.broker(target).pull(f.input, wrongFormat)).toMatchObject({ ok: false, reason: "repository_changed", sideEffectStarted: false });
  writeFileSync(join(target, "a.txt"), "broker staged\n");
  const active = f.broker(target);
  expect((await active.add(["a.txt"])).ok).toBe(true);
  expect(await active.pull(f.input, f.transport)).toMatchObject({ ok: false, reason: "repository_changed", sideEffectStarted: false });
});

test.skipIf(process.platform !== "darwin")("valid internal dangling links remain supported by later pull without widening legacy worktree rules", async () => {
  const f = fixture(); const target = join(f.folder, "project");
  symlinkSync("not-created-yet", join(f.source, "link")); f.commit();
  expect((await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).ok).toBe(true);
  writeFileSync(join(f.source, "a.txt"), "new\n"); f.commit();
  expect((await f.broker(target).pull(f.input, f.transport)).ok).toBe(true);
  expect(readlinkSync(join(target, "link"))).toBe("not-created-yet");
});

test.skipIf(process.platform !== "darwin")("file/directory replacements use native checks and retain colliding untracked children", async () => {
  for (const collision of [false, true]) {
    const f = fixture(); const target = join(f.folder, "project");
    mkdirSync(join(f.source, "old-dir")); writeFileSync(join(f.source, "old-dir", "tracked.txt"), "old child\n"); f.commit();
    expect((await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).ok).toBe(true);
    if (collision) writeFileSync(join(target, "old-dir", "Human.txt"), "Human child\n");
    rmSync(join(f.source, "old-dir"), { recursive: true }); writeFileSync(join(f.source, "old-dir"), "replacement leaf\n");
    rmSync(join(f.source, "a.txt")); mkdirSync(join(f.source, "a.txt")); writeFileSync(join(f.source, "a.txt", "new-child"), "new child\n"); f.commit();
    const old = f.run(target, ["rev-parse", "HEAD"]);
    const result = await f.broker(target).pull(f.input, f.transport);
    if (collision) {
      expect(result).toMatchObject({ ok: false, retrySafe: false });
      expect(readFileSync(join(target, "old-dir", "Human.txt"), "utf8")).toBe("Human child\n");
      expect(f.run(target, ["rev-parse", "HEAD"])).toBe(old);
    } else {
      expect(result.ok).toBe(true);
      expect(readFileSync(join(target, "old-dir"), "utf8")).toBe("replacement leaf\n");
      expect(readFileSync(join(target, "a.txt", "new-child"), "utf8")).toBe("new child\n");
    }
  }
});

test.skipIf(process.platform !== "darwin")("explicit remote branch fast-forwards the attached local branch without inferring an upstream", async () => {
  const f = fixture(); const target = join(f.folder, "project");
  expect((await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).ok).toBe(true);
  f.run(f.source, ["checkout", "-b", "release"]);
  writeFileSync(join(f.source, "a.txt"), "release branch\n"); const next = f.commit();
  expect(await f.broker(target).pull({ ...f.input, branch: "release" }, f.transport)).toMatchObject({ ok: true, newOid: next, remote: { branch: "release" } });
  expect(f.run(target, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
  expect(f.run(target, ["rev-parse", "HEAD"])).toBe(next);
});

test.skipIf(process.platform !== "darwin")("a manifest leaf cannot shadow a protected descendant even when it does not yet exist", async () => {
  const f = fixture(); const target = join(f.folder, "project");
  expect((await f.broker().clone({ ...f.input, directory: "project" }, f.transport)).ok).toBe(true);
  writeFileSync(join(f.source, "cache"), "would shadow protected directory\n"); f.commit();
  expect(await f.broker(target, f.git, [join(target, "cache", "private")]).pull(f.input, f.transport))
    .toMatchObject({ ok: false, reason: "authority_changed", sideEffectStarted: false });
  expect(existsSync(join(target, "cache"))).toBe(false);
  expect(f.run(target, ["rev-parse", "HEAD"])).toBe(f.initial);
});
