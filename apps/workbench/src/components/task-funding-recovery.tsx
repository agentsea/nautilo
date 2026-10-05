import type { ReactElement } from "react";
import type { TaskFundingFailureCode } from "@nautilo/types";

export interface TaskFundingRecovery {
  readonly message: string;
  readonly personalKeysAction: boolean;
  readonly requiresFreshTask: boolean;
}

const RECOVERY: Readonly<Record<TaskFundingFailureCode, TaskFundingRecovery>> = {
  personal_credentials_disabled: {
    message: "Personal API keys are disabled on this server. Ask an administrator to enable them before resuming.",
    personalKeysAction: false,
    requiresFreshTask: false,
  },
  personal_credentials_forbidden: {
    message: "Your access to personal API keys changed. Ask an administrator to restore it before resuming.",
    personalKeysAction: false,
    requiresFreshTask: false,
  },
  personal_credential_missing: {
    message: "This task needs a personal API key. Add the missing key, then resume it.",
    personalKeysAction: true,
    requiresFreshTask: false,
  },
  server_credentials_forbidden: {
    message: "This task needs permission to use server provider credentials. Ask an administrator before resuming.",
    personalKeysAction: false,
    requiresFreshTask: false,
  },
  provider_credentials_missing: {
    message: "The provider key for this task is missing. Add your Personal API key or ask an administrator to configure the server key.",
    personalKeysAction: true,
    requiresFreshTask: false,
  },
  personal_credential_stale: {
    message: "The Personal API key saved for this run changed. Start a fresh task after updating the key; this run cannot resume.",
    personalKeysAction: true,
    requiresFreshTask: true,
  },
  personal_credential_unavailable: {
    message: "The Personal API key for this task is temporarily unavailable. Check the key, then try resuming.",
    personalKeysAction: true,
    requiresFreshTask: false,
  },
  personal_provider_unavailable: {
    message: "The personal provider could not complete this task. Check your key, quota, and provider status, then resume with the same key.",
    personalKeysAction: true,
    requiresFreshTask: false,
  },
  funding_source_changed: {
    message: "This run no longer matches its saved funding source. Start a fresh task instead of resuming it.",
    personalKeysAction: false,
    requiresFreshTask: true,
  },
  unsupported_workload: {
    message: "This work cannot use personal funding. Start a fresh text-only task without paid tools.",
    personalKeysAction: false,
    requiresFreshTask: true,
  },
  unsupported_provider: {
    message: "This provider cannot fund the task. Start a fresh task with a supported text model.",
    personalKeysAction: false,
    requiresFreshTask: true,
  },
  funding_interrupted_uncertain: {
    message: "The provider outcome is uncertain. Review any saved result before deciding whether to start fresh.",
    personalKeysAction: false,
    requiresFreshTask: true,
  },
};

export function taskFundingRecovery(code: TaskFundingFailureCode): TaskFundingRecovery {
  return RECOVERY[code];
}

export function TaskFundingRecoveryNotice({
  code,
  compact = false,
}: {
  readonly code: TaskFundingFailureCode;
  readonly compact?: boolean;
}): ReactElement {
  const recovery = taskFundingRecovery(code);
  return (
    <p
      className={compact
        ? "text-[10px] leading-snug text-[var(--warning)]"
        : "rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/5 px-2 py-1.5 text-xs leading-snug text-foreground"}
      data-testid="task-funding-recovery"
      role="status"
    >
      {recovery.message}{recovery.personalKeysAction ? (
        <>{" "}<a
          href="/settings#personal-provider-keys"
          className="font-medium text-primary hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          Personal API keys
        </a></>
      ) : null}
    </p>
  );
}
