import { execFile } from "node:child_process";
import { fstatSync, writeSync } from "node:fs";
import type { GitHubInstallation, GitHubInstallationInvocation } from "./installation";
import { isGitHubBranchName, isGitHubRepositoryName } from "../../../../packages/types/src/github-broker";

export interface GitHubApiResponse { readonly status: number; readonly data: unknown }
export type GitHubApiBody = Readonly<{ body: string }> | Readonly<{ title: string; body: string; head: string; head_repo: string; base: string; draft: boolean; maintainer_can_modify: false }>;
export interface GitHubApiClient {
  request(method: "GET" | "POST", path: string, body?: GitHubApiBody): Promise<GitHubApiResponse>;
}
/** Credentials never leave this process-private callback's client. */
export interface GitHubCredentialProvider {
  withClient<T>(signal: AbortSignal | undefined, action: (client: GitHubApiClient) => Promise<T>): Promise<T>;
}
/** Only the whole-operation Desktop driver receives this private port. The
 * consumer gets no token string or reusable environment/configuration. */
export interface GitHubGitCredentialProvider {
  withGitClient<T>(signal: AbortSignal | undefined, action: (client: {
    readonly api: GitHubApiClient;
    readonly writeCredential: (descriptor: number) => Promise<void>;
    readonly isCurrent: () => boolean;
  }) => Promise<T>): Promise<T>;
}
export interface GitHubAuthTokenInvocation {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}
function executeAuthToken(input: GitHubAuthTokenInvocation): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(input.executable, [...input.argv], { cwd: input.cwd, env: input.env, timeout: input.timeoutMs,
      maxBuffer: input.maxOutputBytes, ...(input.signal === undefined ? {} : { signal: input.signal }) },
    (error, stdout) => error ? reject(new Error("GITHUB_ACCOUNT_UNAVAILABLE")) : resolve(stdout));
  });
}
function supportedPath(method: string, path: string): boolean {
  if (method === "GET" && path === "/user") return true;
  if (method === "GET") {
    const branch = /^\/repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/([^/]+)$/.exec(path);
    if (branch) {
      try { const ref = decodeURIComponent(branch[2]!); return isGitHubRepositoryName(branch[1]) && isGitHubBranchName(ref) && encodeURIComponent(ref) === branch[2]; }
      catch { return false; }
    }
  }
  const match = method === "GET" ? /^\/repos\/([^/]+\/[^/]+)(?:\/(?:issues|pulls)\/([1-9][0-9]*))?$/.exec(path)
    : method === "POST" ? /^\/repos\/([^/]+\/[^/]+)\/(?:issues\/([1-9][0-9]*)\/comments|pulls)$/.exec(path) : null;
  return match !== null && isGitHubRepositoryName(match[1])
    && (match[2] === undefined || Number.isSafeInteger(Number(match[2])));
}

function validBody(path: string, value: GitHubApiBody): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (path.endsWith("/comments")) return Object.keys(value).length === 1 && typeof value.body === "string";
  if (!path.endsWith("/pulls") || !("title" in value) || Object.keys(value).length !== 7) return false;
  if (typeof value.head !== "string" || typeof value.head_repo !== "string") return false;
  const [login, ...parts] = value.head.split(":");
  return typeof value.title === "string" && value.title.trim().length > 0 && typeof value.body === "string"
    && value.maintainer_can_modify === false && typeof value.draft === "boolean" && isGitHubBranchName(value.base)
    && /^[A-Za-z0-9-]+$/.test(login ?? "") && parts.length === 1 && isGitHubBranchName(parts[0])
    && typeof value.head_repo === "string" && isGitHubRepositoryName(`${login}/${value.head_repo}`)
    && Object.keys(value).every(key => ["title", "body", "head", "head_repo", "base", "draft", "maintainer_can_modify"].includes(key));
}

/** The caller supplies an admitted installation identity and existing budgets.
 * No PATH search, login shell, project cwd, inherited token or redirect fallback. */
export function createGitHubCredentialProvider(options: {
  readonly installation: GitHubInstallation;
  readonly timeoutMs: number;
  readonly maxCredentialOutputBytes: number;
  readonly maxResponseBytes: number;
  readonly fetch?: typeof fetch;
  readonly runAuthToken?: (input: GitHubAuthTokenInvocation) => Promise<string>;
}): GitHubCredentialProvider & GitHubGitCredentialProvider {
  if (![options.timeoutMs, options.maxCredentialOutputBytes, options.maxResponseBytes].every(value => Number.isSafeInteger(value) && value > 0)
    || options.timeoutMs > 2_147_483_647) throw new Error("Invalid GitHub custody configuration");
  const transport = options.fetch ?? fetch;
  const withPrivateClient = async <T>(signal: AbortSignal | undefined, action: (client: GitHubApiClient,
    writeCredential: (descriptor: number) => Promise<void>, isCurrent: () => boolean) => Promise<T>): Promise<T> => {
      let token = "";
      let retired = false;
      let installation: GitHubInstallationInvocation;
      try {
        signal?.throwIfAborted();
        installation = await options.installation.verify(signal);
        if (!installation.isCurrent()) throw new Error("Unavailable");
        token = (await (options.runAuthToken ?? executeAuthToken)({ executable: installation.executable, argv: ["auth", "token", "--hostname", "github.com"],
          cwd: installation.cwd, env: installation.env,
          signal, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxCredentialOutputBytes })).trim();
        if (!installation.isCurrent()) throw new Error("Unavailable");
        if (!token || /[\r\n\0]/.test(token) || Buffer.byteLength(token) > options.maxCredentialOutputBytes) throw new Error("Unavailable");
      } catch { throw new Error("GITHUB_ACCOUNT_UNAVAILABLE"); }
      const client: GitHubApiClient = {
        async request(method, path, body) {
          try {
            if (retired || !installation.isCurrent() || signal?.aborted || !supportedPath(method, path) || (method === "POST") !== (body !== undefined)
              || (body !== undefined && !validBody(path, body))) throw new Error("GITHUB_REQUEST_UNAVAILABLE");
            // A retained client cannot outlive the exact admitted installation or
            // Desktop authority that retrieved its token.
            const current = await options.installation.verify(signal);
            if (retired || !installation.isCurrent() || !current.isCurrent()) throw new Error("GITHUB_REQUEST_UNAVAILABLE");
            const url = `https://api.github.com${path}`;
            const response = await transport(url, { method, redirect: "error", signal: signal ?? null,
              headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Nautilo", "X-GitHub-Api-Version": "2022-11-28",
                ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            if (retired || !installation.isCurrent() || !current.isCurrent() || signal?.aborted || response.redirected || (response.url && response.url !== url)) throw new Error("GITHUB_REQUEST_UNAVAILABLE");
            const reader = response.body?.getReader();
            let size = 0;
            const chunks: Uint8Array[] = [];
            if (reader) {
              try {
                while (true) {
                  const part = await reader.read();
                  if (part.done) break;
                  size += part.value.byteLength;
                  if (size > options.maxResponseBytes) throw new Error("GITHUB_RESPONSE_UNAVAILABLE");
                  chunks.push(part.value);
                }
              } catch { await reader.cancel().catch(() => undefined); throw new Error("GITHUB_RESPONSE_UNAVAILABLE"); }
            }
            if (retired || !installation.isCurrent() || !current.isCurrent() || signal?.aborted) throw new Error("GITHUB_REQUEST_UNAVAILABLE");
            let data: unknown;
            try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("GITHUB_RESPONSE_UNAVAILABLE"); }
            return { status: response.status, data };
          } catch { throw new Error("GITHUB_REQUEST_UNAVAILABLE"); }
        },
      };
      const isCurrent = () => !retired && installation.isCurrent() && !signal?.aborted;
      const writeCredential = async (descriptor: number) => {
        try {
          if (!isCurrent()) throw new Error("GITHUB_REQUEST_UNAVAILABLE");
          const current = await options.installation.verify(signal);
          if (!current.isCurrent()) throw new Error("GITHUB_REQUEST_UNAVAILABLE");
          if (!isCurrent() || !Number.isSafeInteger(descriptor) || descriptor < 0) throw new Error("GITHUB_REQUEST_UNAVAILABLE");
          const info = fstatSync(descriptor);
          // The driver already proved protected scratch authority and unlinked
          // this file. Reject named files, pipes and any shared/readable file.
          if (!info.isFile() || info.nlink !== 0 || info.size !== 0 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("GITHUB_REQUEST_UNAVAILABLE");
          const bytes = Buffer.from(`username=x-access-token\npassword=${token}\n\n`);
          // Explicit positioned writes leave the inherited descriptor at byte0.
          // The one private helper read must not inherit an already consumed FD.
        try {
            for (let offset = 0; offset < bytes.length;) {
              const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
              if (written <= 0) throw new Error("GITHUB_REQUEST_UNAVAILABLE");
              offset += written;
            }
          }
          finally { bytes.fill(0); }
        } catch { throw new Error("GITHUB_REQUEST_UNAVAILABLE"); }
      };
      try { return await action(client, writeCredential, isCurrent); }
      finally { retired = true; token = ""; }
  };
  return {
    withClient: (signal, action) => withPrivateClient(signal, client => action(client)),
    withGitClient: (signal, action) => withPrivateClient(signal, (api, writeCredential, isCurrent) => action({ api, writeCredential, isCurrent })),
  };
}
