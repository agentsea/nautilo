import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { GitHubInstallation, GitHubInstallationInvocation } from "./github-broker/installation";

export const GITHUB_DEVICE_URL = "https://github.com/login/device";

export interface GitHubCliStatus {
  installed: boolean;
  authenticated: boolean;
  login: string | null;
  version: string | null;
  loginPending: boolean;
}

export interface GitHubCliInvocation extends GitHubInstallationInvocation {
  readonly argv: readonly string[];
}
function execInstalled(input: GitHubCliInvocation): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    if (!input.isCurrent()) throw new Error("GitHub installation is unavailable.");
    execFile(input.executable, [...input.argv],
      { cwd: input.cwd, env: input.env, timeout: 15_000, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }));
  });
}

function versionFrom(text: string): string | null {
  return text.match(/^gh version ([^\s]+)/m)?.[1] ?? null;
}

function loginFrom(text: string): string | null {
  return text.match(/Logged in to github\.com account ([^\s(]+)/i)?.[1] ?? null;
}

export function createAdmittedGitHubCliConnection(options: {
  readonly openExternal: (url: string) => Promise<void>;
  readonly getInstallation: () => Promise<GitHubInstallation>;
  readonly subscribeAuthorityChanges: (listener: () => void) => () => void;
  readonly spawnProcess?: typeof spawn;
  readonly runCommand?: typeof execInstalled;
}) {
  let loginProcess: ChildProcessWithoutNullStreams | null = null;
  const runCommand = options.runCommand ?? execInstalled;
  let attempt: symbol | null = null;
  let cancelActive: (() => void) | null = null;

  return {
    async status(): Promise<GitHubCliStatus> {
      const unavailable: GitHubCliStatus = { installed: false, authenticated: false, login: null, version: null, loginPending: attempt !== null };
      try {
        const installation = await options.getInstallation();
        const versionInput = await installation.verify();
        if (!versionInput.isCurrent()) return unavailable;
        const versionResult = await runCommand({ ...versionInput, argv: ["--version"] });
        if (!versionInput.isCurrent()) return unavailable;
        const version = versionFrom(versionResult.stdout);
        if (versionResult.code !== 0 || version === null) return unavailable;
        const authInput = await installation.verify();
        if (!authInput.isCurrent()) return unavailable;
        const auth = await runCommand({ ...authInput, argv: ["auth", "status", "--hostname", "github.com"] });
        if (!authInput.isCurrent()) return unavailable;
        return { installed: true, authenticated: auth.code === 0,
          login: auth.code === 0 ? loginFrom(`${auth.stdout}\n${auth.stderr}`) : null,
          version, loginPending: attempt !== null };
      } catch { return unavailable; }
    },

    async connect(): Promise<{ url: string; code: string }> {
      if (attempt !== null) throw new Error("A GitHub sign-in is already in progress.");
      const ownAttempt = Symbol("GitHub sign-in");
      attempt = ownAttempt;
      let invocation: GitHubInstallationInvocation;
      try {
        const installation = await options.getInstallation();
        invocation = await installation.verify();
        if (attempt !== ownAttempt || !invocation.isCurrent()) throw new Error("Unavailable");
      } catch {
        if (attempt === ownAttempt) attempt = null;
        throw new Error("GitHub installation is unavailable.");
      }
      const spawnProcess = options.spawnProcess ?? spawn;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnProcess(invocation.executable,
          ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--clipboard"],
          { cwd: invocation.cwd, env: invocation.env, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        if (attempt === ownAttempt) attempt = null;
        throw new Error("GitHub CLI could not start device sign-in.");
      }
      loginProcess = child;

      return await new Promise<{ url: string; code: string }>((resolve, reject) => {
        let output = "";
        let settled = false;
        let unsubscribe = () => {};
        let cancelled = false;
        const cleanup = () => {
          unsubscribe(); unsubscribe = () => {};
          clearTimeout(timer);
          if (cancelActive === cancelOwn) cancelActive = null;
        };
        const cancelOwn = () => {
          cleanup();
          finishError(new Error("GitHub sign-in is no longer current."));
          if (!cancelled) {
            cancelled = true;
            child.kill("SIGTERM");
          }
        };
        cancelActive = cancelOwn;
        const finishError = (error: Error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        const inspect = () => {
          if (attempt !== ownAttempt || !invocation.isCurrent()) {
            cancelOwn();
            return;
          }
          const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
          if (!code || settled) return;
          settled = true;
          output = "";
          void options.openExternal(GITHUB_DEVICE_URL).catch(() => undefined);
          resolve({ url: GITHUB_DEVICE_URL, code });
          // gh sometimes waits for Enter before opening the browser. The app
          // owns browser opening, so advance it into device polling directly.
          child.stdin.write("\n");
        };
        child.stdout.on("data", (chunk: Buffer) => {
          if (settled) return;
          output = (output + chunk.toString("utf8")).slice(-64 * 1024);
          inspect();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (settled) return;
          output = (output + chunk.toString("utf8")).slice(-64 * 1024);
          inspect();
        });
        child.once("error", () => {
          cleanup();
          finishError(new Error("GitHub CLI could not start device sign-in."));
        });
        child.once("close", (code) => {
          cleanup();
          if (attempt === ownAttempt) { attempt = null; loginProcess = null; }
          if (!settled) {
            finishError(
              new Error(
                code === 0
                  ? "GitHub sign-in completed before a device code was returned."
                  : "GitHub CLI could not start device sign-in.",
              ),
            );
          }
        });
        const timer = setTimeout(() => {
          if (!settled) {
            finishError(new Error("Timed out waiting for GitHub CLI to return a device code."));
            cancelOwn();
          }
        }, 20_000);
        timer.unref();
        try {
          unsubscribe = options.subscribeAuthorityChanges(() => {
            if (!invocation.isCurrent()) cancelOwn();
          });
        } catch { cancelOwn(); return; }
        if (attempt !== ownAttempt || !invocation.isCurrent()) cancelOwn();
      });
    },

    async openDevicePage(): Promise<void> {
      await options.openExternal(GITHUB_DEVICE_URL);
    },

    cancel(): void {
      if (loginProcess !== null) {
        cancelActive?.();
        return;
      }
      attempt = null;
    },
  };
}

// Compatibility owner until legacy execution retirement closes its cleanup boundary.
function execLoginShell(command: string, timeout = 15_000): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    execFile(
      "/bin/zsh",
      ["-l", "-c", command],
      { env: { ...process.env }, timeout, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code:
            error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : error
                ? 1
                : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}


export function createGitHubCliConnection(options: {
  readonly openExternal: (url: string) => Promise<void>;
  readonly spawnProcess?: typeof spawn;
  readonly runCommand?: typeof execLoginShell;
}) {
  let loginProcess: ChildProcessWithoutNullStreams | null = null;
  const runCommand = options.runCommand ?? execLoginShell;

  return {
    async status(): Promise<GitHubCliStatus> {
      const versionResult = await runCommand("gh --version");
      const version = versionFrom(versionResult.stdout);
      if (versionResult.code !== 0 || version === null) {
        return {
          installed: false,
          authenticated: false,
          login: null,
          version: null,
          loginPending: loginProcess !== null,
        };
      }
      const auth = await runCommand("gh auth status --hostname github.com");
      const combined = `${auth.stdout}\n${auth.stderr}`;
      return {
        installed: true,
        authenticated: auth.code === 0,
        login: loginFrom(combined),
        version,
        loginPending: loginProcess !== null,
      };
    },

    async connect(): Promise<{ url: string; code: string }> {
      if (loginProcess !== null) {
        throw new Error("A GitHub sign-in is already in progress.");
      }
      const spawnProcess = options.spawnProcess ?? spawn;
      const child = spawnProcess(
        "/bin/zsh",
        [
          "-l",
          "-c",
          "exec gh auth login --hostname github.com --git-protocol https --web --clipboard",
        ],
        { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] },
      );
      loginProcess = child;

      return await new Promise<{ url: string; code: string }>((resolve, reject) => {
        let output = "";
        let settled = false;
        const finishError = (error: Error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        const inspect = () => {
          const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
          if (!code || settled) return;
          settled = true;
          void options.openExternal(GITHUB_DEVICE_URL).catch(() => undefined);
          resolve({ url: GITHUB_DEVICE_URL, code });
          // gh sometimes waits for Enter before opening the browser. The app
          // owns browser opening, so advance it into device polling directly.
          child.stdin.write("\n");
        };
        child.stdout.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString("utf8")).slice(-64 * 1024);
          inspect();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString("utf8")).slice(-64 * 1024);
          inspect();
        });
        child.once("error", (error) => {
          loginProcess = null;
          finishError(error);
        });
        child.once("close", (code) => {
          loginProcess = null;
          if (!settled) {
            finishError(
              new Error(
                code === 0
                  ? "GitHub sign-in completed before a device code was returned."
                  : "GitHub CLI could not start device sign-in.",
              ),
            );
          }
        });
        const timer = setTimeout(() => {
          if (!settled) {
            child.kill("SIGTERM");
            finishError(new Error("Timed out waiting for GitHub CLI to return a device code."));
          }
        }, 20_000);
        timer.unref();
        child.once("close", () => clearTimeout(timer));
      });
    },

    async openDevicePage(): Promise<void> {
      await options.openExternal(GITHUB_DEVICE_URL);
    },

    cancel(): void {
      loginProcess?.kill("SIGTERM");
      loginProcess = null;
    },
  };
}
