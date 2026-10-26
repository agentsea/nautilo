import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installGitHooks } from "./install-git-hooks";

const fixtures: string[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hook-install-"));
  fixtures.push(root);
  const hooks = join(root, "custom-hooks");
  mkdirSync(hooks);
  return { root, hooks };
}
function writeHook(path: string) { writeFileSync(path, "#!/bin/sh\nexit 0\n"); chmodSync(path, 0o700); }

test("ordinary clones still install Lefthook", () => {
  let installs = 0;
  installGitHooks("/path/to/project", { configuredHooksPath: () => null, installLefthook() { installs++; }, announce() {} });
  expect(installs).toBe(1);
});
test("configured executable hooks and delegation links are preserved byte for byte", () => {
  const { root, hooks } = fixture();
  const commit = join(root, "downstream-pre-commit"); writeHook(commit);
  symlinkSync(commit, join(hooks, "pre-commit")); writeHook(join(hooks, "pre-push"));
  const before = readFileSync(join(hooks, "pre-push"));
  let installs = 0; const messages: string[] = [];
  installGitHooks(root, { configuredHooksPath: () => "custom-hooks", installLefthook() { installs++; }, announce(message) { messages.push(message); } });
  expect(installs).toBe(0);
  expect(readFileSync(join(hooks, "pre-push"))).toEqual(before);
  expect(messages).toHaveLength(1);
});
test("incomplete or non-executable custom setup fails instead of installing over it", () => {
  const { root, hooks } = fixture();
  let installs = 0;
  const dependencies = { configuredHooksPath: () => hooks, installLefthook() { installs++; }, announce() {} };
  expect(() => installGitHooks(root, dependencies)).toThrow("pre-commit");
  writeHook(join(hooks, "pre-commit"));
  expect(() => installGitHooks(root, dependencies)).toThrow("pre-push");
  writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\n"); chmodSync(join(hooks, "pre-push"), 0o600);
  expect(() => installGitHooks(root, dependencies)).toThrow("pre-push");
  expect(installs).toBe(0);
});
test("dangling custom hooks are rejected", () => {
  const { root, hooks } = fixture();
  symlinkSync(join(root, "missing"), join(hooks, "pre-commit"));
  expect(() => installGitHooks(root, { configuredHooksPath: () => hooks, installLefthook() {}, announce() {} })).toThrow("pre-commit");
});
