import { afterEach, expect, test } from "bun:test";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubInstallation } from "../../electron/github-broker/installation";
import { createGitHubCredentialProvider, type GitHubApiClient, type GitHubAuthTokenInvocation } from "../../electron/github-broker/credentials";

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function rejects(promise: Promise<unknown>, message: string): Promise<void> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe(message); return;
  }
  throw new Error("Expected custody to fail closed");
}
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "github-custody-fixture-"))); paths.push(dir);
  const executable = join(dir, "gh"); const bytes = "#!/bin/sh\nexit 1\n";
  await writeFile(executable, bytes); await chmod(executable, 0o700);
  const invocations: GitHubAuthTokenInvocation[] = [];
  const requests: { url: string; input: RequestInit | undefined }[] = [];
  const installationOptions = { executable, executableSha256: createHash("sha256").update(bytes).digest("hex"), homeDir: dir,
    authority: async () => ({ writableRoots: [] as readonly string[], isCurrent: () => true }) };
  const options = { installation: createGitHubInstallation(installationOptions), timeoutMs: 1000, maxCredentialOutputBytes: 1024, maxResponseBytes: 1024,
    runAuthToken: async (input: GitHubAuthTokenInvocation) => { invocations.push(input); return "synthetic-provider-value"; },
    fetch: (async (url: string | URL | Request, input?: RequestInit) => {
      requests.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, input }); return new Response(JSON.stringify({ id: 10, login: "fixture-user" }), { status: 200 });
    }) as typeof fetch };
  return { dir, options, installationOptions, invocations, requests };
}
test.skipIf(process.platform === "win32")("custody selects exact validated executable and never projects an inherited credential", async () => {
  const f = await fixture(); const provider = createGitHubCredentialProvider(f.options);
  const result = await provider.withClient(undefined, client => client.request("GET", "/user"));
  expect(result).toEqual({ status: 200, data: { id: 10, login: "fixture-user" } });
  expect(JSON.stringify(result)).not.toContain("synthetic-provider-value");
  expect(f.invocations[0]!.executable).toBe(f.installationOptions.executable);
  expect(f.invocations[0]!.argv).toEqual(["auth", "token", "--hostname", "github.com"]);
  expect(f.invocations[0]!.env["GH_TOKEN"]).toBeUndefined(); expect(f.invocations[0]!.env["GITHUB_TOKEN"]).toBeUndefined();
  expect(f.invocations[0]!.cwd).toBe(f.dir);
  expect(f.requests[0]!.url).toBe("https://api.github.com/user"); expect(f.requests[0]!.input!.redirect).toBe("error");
  expect((f.requests[0]!.input!.headers as Record<string, string>)["X-GitHub-Api-Version"]).toBe("2022-11-28");
});
test.skipIf(process.platform === "win32")("binary drift, symlink and project executable fail before credential retrieval", async () => {
  const f = await fixture();
  for (const installation of [createGitHubInstallation({ ...f.installationOptions, executableSha256: "0".repeat(64) }),
    createGitHubInstallation({ ...f.installationOptions, authority: async () => ({ writableRoots: [f.dir], isCurrent: () => true }) })]) {
    await rejects(createGitHubCredentialProvider({ ...f.options, installation }).withClient(undefined, client => client.request("GET", "/user")), "GITHUB_ACCOUNT_UNAVAILABLE");
  }
  const linked = join(f.dir, "linked-gh"); await symlink(f.installationOptions.executable, linked);
  await rejects(createGitHubCredentialProvider({ ...f.options, installation: createGitHubInstallation({ ...f.installationOptions, executable: linked }) }).withClient(undefined, client => client.request("GET", "/user")), "GITHUB_ACCOUNT_UNAVAILABLE");
  expect(f.invocations).toHaveLength(0);
  expect(() => createGitHubInstallation({ ...f.installationOptions, executable: "gh" })).toThrow();
  const childDir = join(f.dir, "..inside"); await mkdir(childDir);
  const child = join(childDir, "gh"); await writeFile(child, "#!/bin/sh\nexit 1\n"); await chmod(child, 0o700);
  await rejects(createGitHubCredentialProvider({ ...f.options, installation: createGitHubInstallation({ ...f.installationOptions, executable: child, authority: async () => ({ writableRoots: [f.dir], isCurrent: () => true }) }) }).withClient(undefined, client => client.request("GET", "/user")), "GITHUB_ACCOUNT_UNAVAILABLE");
  expect(f.invocations).toHaveLength(0);
});
test.skipIf(process.platform === "win32")("private client rejects arbitrary destinations, endpoints and post-callback reuse", async () => {
  const f = await fixture(); const provider = createGitHubCredentialProvider(f.options); let old!: GitHubApiClient;
  await provider.withClient(undefined, async client => {
    old = client;
    for (const path of ["https://other.example/user", "/user?x=1", "/repos/fixture-org/project/git/refs", "/repos/../project", "/repos/fixture-org/..",
      "/repos/fixture-org/project/issues/9007199254740992"]) {
      await rejects(client.request("GET", path), "GITHUB_REQUEST_UNAVAILABLE");
    }
    await rejects(client.request("POST", "/user", { body: "Comment" }), "GITHUB_REQUEST_UNAVAILABLE");
  });
  await rejects(old.request("GET", "/user"), "GITHUB_REQUEST_UNAVAILABLE"); expect(f.requests).toHaveLength(0);
});
test.skipIf(process.platform === "win32")("response budget, redirect and transport errors expose only fixed safe errors", async () => {
  const f = await fixture();
  const transports = [
    (async () => new Response(JSON.stringify({ value: "x".repeat(2048) }))) as typeof fetch,
    (async () => { const response = new Response("{}"); Object.defineProperty(response, "url", { value: "https://other.example/user" }); return response; }) as typeof fetch,
    (async () => { throw new Error("synthetic-provider-value"); }) as typeof fetch,
  ];
  for (const transport of transports) {
    await rejects(createGitHubCredentialProvider({ ...f.options, fetch: transport }).withClient(undefined, client => client.request("GET", "/user")), "GITHUB_REQUEST_UNAVAILABLE");
  }
});
test("aborted custody never starts credential process or HTTP", async () => {
  const f = await fixture(); const signal = AbortSignal.abort();
  await rejects(createGitHubCredentialProvider(f.options).withClient(signal, client => client.request("GET", "/user")), "GITHUB_ACCOUNT_UNAVAILABLE");
  expect(f.invocations).toHaveLength(0); expect(f.requests).toHaveLength(0);
});

test.skipIf(process.platform !== "win32")("Windows rejects POSIX GitHub custody before credential or network access", async () => {
  const f = await fixture();
  await rejects(createGitHubCredentialProvider(f.options).withClient(undefined, client => client.request("GET", "/user")), "GITHUB_ACCOUNT_UNAVAILABLE");
  expect(f.invocations).toHaveLength(0);
  expect(f.requests).toHaveLength(0);
});

test.skipIf(process.platform === "win32")("PR custody allows only exact fixed create endpoint and encoded validated branch GET", async () => {
  const f = await fixture(); const provider = createGitHubCredentialProvider(f.options);
  await provider.withClient(undefined, async client => {
    await client.request("GET", "/repos/fixture-user/fork/git/ref/heads/feature%2Ftopic");
    await client.request("POST", "/repos/fixture-org/project/pulls", { title: "Reviewed", body: "Full body", head: "fixture-user:feature/topic", head_repo: "fork", base: "main", draft: false, maintainer_can_modify: false });
    for (const path of ["/repos/fixture-org/project/git/ref/heads/%2E%2E", "/repos/fixture-org/project/git/ref/heads/main?x=1", "/repos/fixture-org/project/git/ref/tags/main"]) {
      await rejects(client.request("GET", path), "GITHUB_REQUEST_UNAVAILABLE");
    }
    await rejects(client.request("POST", "/repos/fixture-org/project/pulls", { body: "Only comment" }), "GITHUB_REQUEST_UNAVAILABLE");
    await rejects(client.request("POST", "/repos/fixture-org/project/issues/12/comments", { title: "Reviewed", body: "Full body", head: "fixture-user:feature", head_repo: "fork", base: "main", draft: false, maintainer_can_modify: false }), "GITHUB_REQUEST_UNAVAILABLE");
  });
  expect(f.requests).toHaveLength(2); expect(f.requests[0]!.url).toBe("https://api.github.com/repos/fixture-user/fork/git/ref/heads/feature%2Ftopic");
  expect(JSON.parse(f.requests[1]!.input!.body as string)).toEqual({ title: "Reviewed", body: "Full body", head: "fixture-user:feature/topic", head_repo: "fork", base: "main", draft: false, maintainer_can_modify: false });
});

test.skipIf(process.platform === "win32")("retirement during token retrieval releases no client or HTTP authority", async () => {
  const f = await fixture();
  let retrieved!: () => void;
  const barrier = new Promise<void>(resolve => { retrieved = resolve; });
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  let callbacks = 0;
  const provider = createGitHubCredentialProvider({ ...f.options, runAuthToken: async () => {
    started(); await barrier; return "synthetic-provider-value";
  } });
  const pending = provider.withClient(undefined, async client => { callbacks += 1; return await client.request("GET", "/user"); });
  await began;
  f.options.installation.retire();
  retrieved();
  await rejects(pending, "GITHUB_ACCOUNT_UNAVAILABLE");
  expect(callbacks).toBe(0);
  expect(f.requests).toHaveLength(0);
});

test.skipIf(process.platform === "win32")("a private retained client rechecks executable and authority before another request", async () => {
  const f = await fixture();
  await createGitHubCredentialProvider(f.options).withClient(undefined, async client => {
    await client.request("GET", "/user");
    await writeFile(f.installationOptions.executable, "changed runtime");
    await rejects(client.request("GET", "/user"), "GITHUB_REQUEST_UNAVAILABLE");
  });
  expect(f.requests).toHaveLength(1);
});


test.skipIf(process.platform === "win32")("private Git credential response writes once to an unlinked fd and expires with custody", async () => {
  const f = await fixture(); const provider = createGitHubCredentialProvider(f.options);
  const path = join(f.dir, "private-response"); let writer!: (descriptor: number) => Promise<void>;
  writeFileSync(path, "", {mode:0o600}); const descriptor = openSync(path, "r+"); unlinkSync(path);
  try {
    await provider.withGitClient(undefined, async client => {
      writer = client.writeCredential; await client.writeCredential(descriptor);
      expect(readFileSync(descriptor, "utf8")).toBe("username=x-access-token\npassword=synthetic-provider-value\n\n");
      await rejects(client.writeCredential(descriptor), "GITHUB_REQUEST_UNAVAILABLE");
    });
    await rejects(writer(descriptor), "GITHUB_REQUEST_UNAVAILABLE"); expect(f.requests).toHaveLength(0);
  } finally { closeSync(descriptor); }
});
test.skipIf(process.platform === "win32")("Git custody refuses named/shared descriptors and revoked private authority", async () => {
  const f = await fixture(); const path = join(f.dir, "response"); writeFileSync(path, "", {mode:0o600}); const descriptor = openSync(path, "r+");
  try {
    await createGitHubCredentialProvider(f.options).withGitClient(undefined, async client => {
      await rejects(client.writeCredential(descriptor), "GITHUB_REQUEST_UNAVAILABLE");
      unlinkSync(path); f.options.installation.retire(); await rejects(client.writeCredential(descriptor), "GITHUB_REQUEST_UNAVAILABLE");
      expect(readFileSync(descriptor, "utf8")).toBe("");
    });
  } finally { closeSync(descriptor); }
});
