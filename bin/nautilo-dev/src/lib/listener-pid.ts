/**
 * Defensive port→PID lookup so `server:start/stop/status` can work with
 * a server that was started outside `server:start` (e.g. a foreground
 * `bun run server` shell, or a `desktop:all` child).
 *
 * macOS + Linux only — both ship `lsof` and `ps`. We're in dev tooling;
 * Bun on Windows is not supported by this monorepo.
 */
import { execSync } from "node:child_process";

/**
 * Returns the first PID listening on the given TCP port, or null.
 * Accepts IPv4 + IPv6 listeners; takes the lowest PID when multiple
 * processes claim the same port (rare, but possible with forked workers).
 */
export function findListenerPid(port: number): number | null {
  if (!Number.isInteger(port) || port <= 0) return null;
  try {
    const out = execSync(`lsof -nP -t -iTCP:${port} -sTCP:LISTEN`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (out === "") return null;
    const pids = out
      .split(/\s+/)
      .map((s) => Number.parseInt(s, 10))
      .filter((n): n is number => Number.isInteger(n) && n > 0);
    if (pids.length === 0) return null;
    return Math.min(...pids);
  } catch {
    // `lsof` exits non-zero when nothing matches — treat as "no listener".
    return null;
  }
}

/**
 * Returns the full command line for the given PID, or null if the
 * process is gone / can't be inspected.
 */
function readProcessCmdline(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execSync(`ps -p ${pid} -o command=`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/**
 * Heuristic check that a PID belongs to a Nautilo server process —
 * either the source-mode `bun bin/nautilo-server/...` invocation or
 * a packaged equivalent. Refuses anything that obviously isn't ours
 * (e.g. a stray docker proxy, an unrelated bun script).
 *
 * Errs on the side of refusing to act: returns false when the cmdline
 * cannot be read at all (we don't sigkill processes we can't identify).
 */
export function looksLikeNautiloServer(pid: number): boolean {
  const cmd = readProcessCmdline(pid);
  if (cmd === null) return false;
  return /nautilo-server\b/.test(cmd);
}
