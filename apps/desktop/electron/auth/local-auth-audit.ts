/**
 * Append-only local audit log for desktop auth lifecycle events.
 *
 * Writes one JSON line per event to `~/.nautilo/audit.log` (operator-shared
 * home). Never includes token values — identity envelopes only.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AuthIdentity } from "./token-store";

const AUDIT_FILE_MODE = 0o600;

export interface AuthBundleClearedAuditRow {
  ts: string;
  kind: "auth.bundle_cleared";
  reason: "env_pinned_mismatch";
  expected: AuthIdentity;
  disk: AuthIdentity | null;
}

export interface LocalAuthAuditFsLike {
  mkdirSync: (dir: string, options?: { recursive?: boolean }) => void;
  appendFileSync: (
    filePath: string,
    data: string,
    options?: { mode?: number },
  ) => void;
  chmodSync: (filePath: string, mode: number) => void;
}

export interface AppendAuthBundleClearedAuditArgs {
  expected: AuthIdentity;
  disk: AuthIdentity | null;
  auditLogPath?: string;
  fs?: LocalAuthAuditFsLike;
  now?: () => Date;
}

export function defaultLocalAuthAuditLogPath(): string {
  return path.join(os.homedir(), ".nautilo", "audit.log");
}

/**
 * Append one `auth.bundle_cleared` row (env-pinned mismatch recovery).
 * Best-effort: failures are swallowed — audit must not block sign-in.
 */
export function appendAuthBundleClearedAudit(
  args: AppendAuthBundleClearedAuditArgs,
): AuthBundleClearedAuditRow {
  const row: AuthBundleClearedAuditRow = {
    ts: (args.now ?? (() => new Date()))().toISOString(),
    kind: "auth.bundle_cleared",
    reason: "env_pinned_mismatch",
    expected: args.expected,
    disk: args.disk,
  };
  const auditLogPath = args.auditLogPath ?? defaultLocalAuthAuditLogPath();
  const fsLike = args.fs ?? {
    mkdirSync: fs.mkdirSync,
    appendFileSync: fs.appendFileSync,
    chmodSync: fs.chmodSync,
  };
  try {
    fsLike.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    fsLike.appendFileSync(auditLogPath, `${JSON.stringify(row)}\n`, {
      mode: AUDIT_FILE_MODE,
    });
    fsLike.chmodSync(auditLogPath, AUDIT_FILE_MODE);
  } catch {
    /* best effort */
  }
  return row;
}
