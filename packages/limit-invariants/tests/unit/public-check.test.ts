import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { runPublicLimitCheck } from "../../src/node/public-check";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const TOKEN = "test-token-never-logged";
const REPOSITORY = "nautilo-ai/nautilo";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function write(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

async function repository(
  baseSource: string,
  headSource: string | null,
  additionalHeadFiles: Readonly<Record<string, string>> = {},
): Promise<{
  root: string;
  base: string;
  head: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "public-limit-check-test-"));
  roots.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Limit Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await write(root, "packages/example/src/limit.ts", baseSource);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "base");
  const base = await git(root, "rev-parse", "HEAD");
  if (headSource === null) await rm(join(root, "packages/example/src/limit.ts"));
  else await write(root, "packages/example/src/limit.ts", headSource);
  for (const [path, content] of Object.entries(additionalHeadFiles)) await write(root, path, content);
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "head");
  return { root, base, head: await git(root, "rev-parse", "HEAD") };
}

function status(
  sha: string,
  state: string,
  createdAt: string,
  id: number,
  context = "limit-policy-reviewed",
): Record<string, unknown> {
  return {
    url: `https://api.github.com/repos/NAUTILO-AI/NAUTILO/statuses/${sha}`,
    state,
    context,
    created_at: createdAt,
    id,
    target_url: "https://private.invalid/evidence",
  };
}

function pages(payloads: readonly unknown[][], requests: string[] = []): typeof fetch {
  return (async (request: Parameters<typeof fetch>[0]) => {
    const url = typeof request === "string" ? request
      : request instanceof URL ? request.href : request.url;
    requests.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    return Response.json(payloads[page - 1] ?? []);
  }) as typeof fetch;
}

async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

describe("public limit companion", () => {
  test.each([
    {
      name: "unchanged",
      headSource: "// unrelated committed edit\nexport const PAYLOAD_LIMIT = 10;\n",
      expected: { unchanged: 1, removed: 0 },
    },
    { name: "removed", headSource: null, expected: { unchanged: 0, removed: 1 } },
  ] as const)("$name observations need no new public admission", async ({ headSource, expected }) => {
    const repo = await repository("export const PAYLOAD_LIMIT = 10;\n", headSource);
    let requests = 0;
    const result = await runPublicLimitCheck({
      sourceRoot: repo.root,
      base: repo.base,
      head: repo.head,
      repository: REPOSITORY,
      token: TOKEN,
    }, { fetch: (async () => { requests += 1; return Response.json([]); }) as unknown as typeof fetch });
    expect(result).toMatchObject({ ...expected, added: 0, changed: 0, reviewedStatusRequired: false });
    expect(requests).toBe(0);
  });

  test("scout and evidence-only observations do not require public review", async () => {
    const repo = await repository(
      "export const ordinary = 1;\n",
      "setInterval(() => undefined, 5000);\n",
      { "packages/example/tests/evidence.test.ts": "export const PAYLOAD_LIMIT = 10;\n" },
    );
    let requests = 0;
    const result = await runPublicLimitCheck({
      sourceRoot: repo.root,
      base: repo.base,
      head: repo.head,
      repository: REPOSITORY,
      token: TOKEN,
    }, { fetch: (async () => { requests += 1; return Response.json([]); }) as unknown as typeof fetch });

    expect(result).toEqual({
      baseObservations: 0,
      headObservations: 0,
      unchanged: 0,
      removed: 0,
      added: 0,
      changed: 0,
      reviewedStatusRequired: false,
    });
    expect(requests).toBe(0);
  });

  test.each([
    {
      name: "new",
      baseSource: "export const ordinary = 1;\n",
      headSource: "export const PAYLOAD_LIMIT = 10;\n",
      expected: { added: 1, changed: 0 },
    },
    {
      name: "changed",
      baseSource: "export const PAYLOAD_LIMIT = 10;\n",
      headSource: "export const PAYLOAD_LIMIT = 20;\n",
      expected: { added: 0, changed: 1 },
    },
  ] as const)("$name observations require success on the exact head SHA", async ({ baseSource, headSource, expected }) => {
    const repo = await repository(baseSource, headSource);
    const result = await runPublicLimitCheck({
      sourceRoot: repo.root,
      base: repo.base,
      head: repo.head,
      repository: REPOSITORY,
      token: TOKEN,
    }, { fetch: pages([[status(repo.head, "success", "2026-09-18T10:00:00Z", 1)]]) });
    expect(result).toMatchObject({ ...expected, reviewedStatusRequired: true });
  });

  test("reads every status page and the latest matching context wins", async () => {
    const repo = await repository("export const PAYLOAD_LIMIT = 10;\n", "export const PAYLOAD_LIMIT = 20;\n");
    const requests: string[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => index === 0
      ? status(repo.head, "success", "2026-09-18T10:00:00Z", 1)
      : status(repo.head, "success", "2026-09-18T10:00:00Z", index + 2, `other-${index}`));
    const message = await failure(runPublicLimitCheck({
      sourceRoot: repo.root,
      base: repo.base,
      head: repo.head,
      repository: REPOSITORY,
      token: TOKEN,
    }, { fetch: pages([firstPage, [status(repo.head, "failure", "2026-09-18T11:00:00Z", 500)]], requests) }));
    expect(message).toContain("Latest limit-policy-reviewed status");
    expect(message).toContain("is failure");
    expect(message).toContain("added=0 changed=1 unchanged=0 removed=0");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain(`/commits/${repo.head}/statuses?`);
    expect(requests[1]).toContain("page=2");
  });

  test.each([
    { name: "missing", response: "missing", expected: "Missing limit-policy-reviewed" },
    { name: "pending", response: "pending", expected: "is pending" },
    { name: "failed", response: "failure", expected: "is failure" },
    { name: "wrong SHA", response: "wrong-sha", expected: "does not belong to exact HEAD" },
    { name: "malformed", response: "malformed", expected: "malformed status items" },
    { name: "API failure", response: "api-failure", expected: "HTTP 503" },
  ] as const)("rejects $name status evidence", async ({ response, expected }) => {
    const repo = await repository("export const PAYLOAD_LIMIT = 10;\n", "export const PAYLOAD_LIMIT = 20;\n");
    const options = { sourceRoot: repo.root, base: repo.base, head: repo.head, repository: REPOSITORY, token: TOKEN };
    const fetchImpl = response === "missing" ? pages([[]])
      : response === "wrong-sha" ? pages([[status("0".repeat(40), "success", "2026-09-18T10:00:00Z", 1)]])
      : response === "malformed" ? pages([[null]])
      : response === "api-failure"
        ? (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch
        : pages([[status(repo.head, response, "2026-09-18T10:00:00Z", 1)]]);
    expect(await failure(runPublicLimitCheck(options, { fetch: fetchImpl }))).toContain(expected);
  });

  test("fails closed for abbreviated refs, non-head revisions, and dirty source", async () => {
    const repo = await repository("export const PAYLOAD_LIMIT = 10;\n", "export const PAYLOAD_LIMIT = 20;\n");
    const options = { sourceRoot: repo.root, base: repo.base, head: repo.head, repository: REPOSITORY, token: TOKEN };
    expect(await failure(runPublicLimitCheck({ ...options, base: repo.base.slice(0, 12) }))).toContain("40-character");
    expect(await failure(runPublicLimitCheck({ ...options, head: repo.base }))).toContain("must equal the checked-out HEAD");
    await write(repo.root, "dirty.txt", "uncommitted\n");
    expect(await failure(runPublicLimitCheck(options))).toContain("Source repository is dirty");
  });
});
