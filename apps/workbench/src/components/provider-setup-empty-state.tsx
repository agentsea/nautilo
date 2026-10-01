import type { SetupStatusResponse } from "@nautilo/api-client/browser";
import type { RoomMemberDto } from "@nautilo/types";

export type PersonalChatReadiness =
  | "checking"
  | "ready"
  | "missing-key"
  | "missing-model"
  | "disabled"
  | "unavailable";

/** A personal-only Human cannot use a configured server key as a chat fallback. */
export function needsPersonalChatReadiness(
  canUsePersonalKeys: boolean,
): boolean {
  return canUsePersonalKeys;
}

export function personalChatNeedsSetup(state: PersonalChatReadiness): boolean {
  return state !== "ready";
}

export function shouldShowProviderSetupEmptyState(
  status: SetupStatusResponse | null,
  members: readonly RoomMemberDto[],
): boolean {
  const modelProviderMissing =
    status?.setupState === "server-needs-keys" || status?.providers?.hasLlm === false;
  const roomNeedsModel = members.length === 0 || members.some((member) => member.kind === "agent");
  return modelProviderMissing && roomNeedsModel;
}

export function ProviderSetupEmptyState({
  canManageProviders,
  personalState,
  onRetry,
}: {
  readonly canManageProviders: boolean;
  readonly personalState?: PersonalChatReadiness;
  readonly onRetry?: () => void;
}) {
  const personalMessage = personalState === "checking"
    ? "Checking which models you can use…"
    : personalState === "missing-key"
      ? "Add one of your provider keys in Settings to chat with your Genie."
      : personalState === "missing-model"
        ? "Your saved key does not currently make a text-chat model available. Check the provider and choose an eligible model in Settings."
        : personalState === "disabled"
          ? "Personal provider keys are disabled on this server. Ask a server administrator to enable them."
          : "Your personal chat setup could not be checked. Try again in a moment.";
  if (personalState && personalState !== "ready") {
    return (
      <div
        className="relative flex h-full min-h-0 flex-1 flex-col items-center justify-center bg-background px-6 pb-24 text-center"
        data-testid="personal-provider-setup-empty-state"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-background-element text-lg text-foreground-muted" aria-hidden>✦</div>
        <h2 className="mt-4 text-xl font-semibold text-foreground">
          {personalState === "checking" ? "Checking chat access" : "Set up your chat model"}
        </h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-foreground-muted">{personalMessage}</p>
        {personalState !== "checking" && personalState !== "disabled" && personalState !== "unavailable" ? (
          <a
            href={personalState === "missing-model" ? "/settings#model" : "/settings#personal-provider-keys"}
            className="mt-6 inline-flex min-h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-[var(--on-primary)] hover:bg-primary-hover"
          >
            {personalState === "missing-model" ? "Choose a model" : "Set up your key"}
          </a>
        ) : null}
        {personalState === "unavailable" && onRetry ? (
          <button type="button" onClick={onRetry} className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-[var(--on-primary)]">
            Try again
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div
      className="relative flex h-full min-h-0 flex-1 flex-col items-center justify-center bg-background px-6 pb-24 text-center"
      data-testid="provider-setup-empty-state"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-background-element text-lg text-foreground-muted" aria-hidden>
        ✦
      </div>
      <h2 className="mt-4 text-xl font-semibold text-foreground">
        Models aren’t configured yet
      </h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-foreground-muted">
        {canManageProviders
          ? "Add a model provider to start chatting. Everything else in Nautilo remains available while you finish setup."
          : "This server needs a model provider before you can chat. Ask your server administrator to finish setup."}
      </p>
      {canManageProviders ? (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <a
            href="/admin#provider-credentials"
            className="inline-flex min-h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-[var(--on-primary)] hover:bg-primary-hover"
          >
            API Keys
          </a>
          <a
            href="/help/server"
            className="inline-flex min-h-10 items-center justify-center rounded-md border border-border-strong px-4 text-sm font-medium text-foreground hover:bg-background-element"
          >
            Open Server Guide
          </a>
        </div>
      ) : null}
      <div className="absolute inset-x-6 bottom-6 mx-auto flex min-h-14 max-w-2xl items-center rounded-xl border border-border bg-background-element px-4 text-left text-sm text-foreground-muted opacity-75" aria-disabled="true">
        Configure a model provider to send a message
      </div>
    </div>
  );
}
