import type { CodexHostStatus } from "@nautilo/relay";
import type {
  CodexAdminHostFacts,
  CodexAdminProfileFacts,
  CodexAdminControlPlane,
} from "./admin-control-plane";
import { CodexAdminControlFailure } from "./admin-control-plane";

export type CodexExecutionProfileFacts = CodexAdminProfileFacts;

export interface CodexExecutionPreflightPort {
  prepare(profile: CodexExecutionProfileFacts): Promise<void>;
}

export interface CodexExecutionPreflightDeps {
  readonly control: Pick<
    CodexAdminControlPlane,
    "inspectRuntime" | "activateRuntime" | "readAccount"
  >;
  readonly readHostStatus: (
    userId: string,
    relayId: string,
  ) => CodexHostStatus | null;
}

/**
 * Rehydrates the desktop-only Codex controller state needed by execution.
 *
 * Persisted profile rows intentionally outlive Electron controllers. This
 * restores only that exact owner/profile identity through the admin protocol,
 * then leaves strict authority to prove the fresh relay snapshot, workspace
 * receipt, generations, and Task binding.
 */
export class CodexExecutionPreflight implements CodexExecutionPreflightPort {
  constructor(private readonly deps: CodexExecutionPreflightDeps) {}

  async prepare(profile: CodexExecutionProfileFacts): Promise<void> {
    const host: CodexAdminHostFacts = {
      userId: profile.userId,
      relayId: profile.relayId,
    };
    const status = this.deps.readHostStatus(host.userId, host.relayId);
    if (!hasSelectedRuntime(status)) {
      const inspected = await this.deps.control.inspectRuntime(host);
      if (
        inspected.state !== "ready" ||
        inspected.runtimeGeneration === undefined
      ) {
        throw new CodexAdminControlFailure("CODEX_STALE");
      }
      await this.deps.control.activateRuntime({
        ...host,
        runtimeGeneration: inspected.runtimeGeneration,
      });
    }

    // This owns the idempotent profile_create (when absent) ->
    // ensure_profile_child -> account_read sequence.
    const account = await this.deps.control.readAccount(profile);
    if (
      account.state !== "signed_in" ||
      account.accountGeneration !== profile.accountGeneration
    ) {
      throw new CodexAdminControlFailure("CODEX_STALE");
    }
  }
}

function hasSelectedRuntime(status: CodexHostStatus | null): boolean {
  return Boolean(
    status &&
    (status.state === "ready" || status.state === "limited") &&
    status.runtime?.state === "ready" &&
    Number.isSafeInteger(status.runtimeGeneration) &&
    status.runtimeGeneration! >= 0,
  );
}
