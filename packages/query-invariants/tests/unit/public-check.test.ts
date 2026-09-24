import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runPublicQueryCheck } from "../../src/node/public-check";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("query changes require their own exact-head review without private files", async () => {
  const root = await mkdtemp(join(tmpdir(), "query-public-check-"));
  roots.push(root);
  const git = async (...args: string[]) => (await exec("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  const source = join(root, "packages/example/src");
  await mkdir(source, { recursive: true });
  const file = join(source, "queries.ts");
  await writeFile(file, 'export const version = "base";\n');
  await git("add", ".");
  await git("commit", "-qm", "base");
  const base = await git("rev-parse", "HEAD");
  await writeFile(file, 'export async function read(db) { return db.execute("SELECT id FROM rooms"); }\n');
  await git("add", ".");
  await git("commit", "-qm", "head");
  const head = await git("rev-parse", "HEAD");
  const repository = "example/project";
  const options = { sourceRoot: root, base, head, repository, token: "test-token" };
  const status = (context: string, sha = head, state = "success") => ({
    context, state, url: `https://api.github.com/repos/${repository}/statuses/${sha}`,
    id: 1, created_at: "2026-01-01T00:00:00Z",
  });
  const fetchStatuses = (statuses: unknown[]) => (async () => Response.json(statuses)) as unknown as typeof fetch;
  for (const statuses of [[], [status("limit-policy-reviewed")], [status("query-policy-reviewed", base)], [status("query-policy-reviewed", head, "failure")]]) {
    const error = await runPublicQueryCheck(options, { fetch: fetchStatuses(statuses) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
  }
  const result = await runPublicQueryCheck(options, { fetch: fetchStatuses([status("query-policy-reviewed")]) });
  expect(result.added).toBeGreaterThan(0);
  expect(result.reviewedStatusRequired).toBe(true);
  const unchanged = await runPublicQueryCheck({ ...options, base: head }, {
    fetch: (async () => { throw new Error("Unchanged queries need no new status lookup"); }) as unknown as typeof fetch,
  });
  expect(unchanged.reviewedStatusRequired).toBe(false);
});
