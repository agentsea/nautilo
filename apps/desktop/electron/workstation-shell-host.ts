import * as fs from "node:fs";
import type {
  WorkstationShellConsentStore,
  WorkstationShellFolderIdentity,
  WorkstationShellSubject,
} from "./workstation-shell-consent-store.ts";

function folderIdentity(workspacePath: string): WorkstationShellFolderIdentity | null {
  try {
    const canonicalRoot = fs.realpathSync(workspacePath);
    const stat = fs.statSync(canonicalRoot);
    if (!stat.isDirectory()) return null;
    return {
      canonicalRoot,
      ...(Number.isSafeInteger(stat.dev) && stat.dev >= 0
        && Number.isSafeInteger(stat.ino) && stat.ino >= 0
        ? { device: stat.dev, inode: stat.ino }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Compatibility owner for historical unsandboxed host-command consent.
 *
 * New command execution is owned by the managed local-execution host. This
 * adapter only reads and revokes receipts written by older Desktop versions so
 * upgrades can display and remove that authority without retaining a second
 * process runner.
 */
export function createWorkstationShellHost(options: {
  readonly consentStore?: WorkstationShellConsentStore | undefined;
  readonly resolveSubject: () => Promise<WorkstationShellSubject | null>;
}) {
  return {
    async revoke(workspacePath: string, subject?: WorkstationShellSubject | null): Promise<void> {
      const identity = folderIdentity(workspacePath);
      const canonicalRoot = identity?.canonicalRoot ?? workspacePath;
      if (options.consentStore && subject) {
        await options.consentStore.revoke({
          instanceId: subject.instanceId,
          userId: subject.userId,
          canonicalRoot,
        });
      }
    },
    async consentStatus(workspacePath: string): Promise<"none" | "durable"> {
      const identity = folderIdentity(workspacePath);
      if (!identity || !options.consentStore) return "none";
      let subject: WorkstationShellSubject | null;
      try {
        subject = await options.resolveSubject();
      } catch {
        return "none";
      }
      if (!subject) return "none";
      const stored = await options.consentStore.has({ subject, identity });
      return stored.ok && stored.data ? "durable" : "none";
    },
  };
}
