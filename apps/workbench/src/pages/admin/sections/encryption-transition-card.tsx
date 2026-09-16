import { useCallback, useEffect, useRef, useState } from "react";
import {
  DISABLE_SHADOW_ENCRYPTION_CONFIRMATION,
  ENABLE_SHADOW_ENCRYPTION_CONFIRMATION,
  ENABLE_FULL_ENCRYPTION_CONFIRMATION,
  ENABLE_STRICT_SHADOW_CONFIRMATION,
  USE_FALLBACK_SHADOW_CONFIRMATION,
  type EncryptionTransitionStatus,
  type LiveShadowEncryptionTransitionBehavior,
  type LiveShadowEncryptionTransitionMode,
  type StenographerProtectionStatus,
} from "@nautilo/api-client/browser";

import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";
import { StenographerProtectionStatusPanel } from "./stenographer-health-card";

const AUTO_REFRESH_MS = 10_000;

type EffectiveEncryptionChoice =
  "plain" | "fallback_shadow" | "strict_shadow" | "fully_encrypted";

type EncryptionTarget = Readonly<{
  mode: LiveShadowEncryptionTransitionMode;
  shadowBehavior: LiveShadowEncryptionTransitionBehavior;
}>;

function effectiveChoice(
  policy: EncryptionTransitionStatus["policy"],
): EffectiveEncryptionChoice {
  if (policy.mode === "plaintext_only") return "plain";
  if (policy.mode === "encrypted_only") return "fully_encrypted";
  return policy.shadowBehavior === "strict"
    ? "strict_shadow"
    : "fallback_shadow";
}

function targetForChoice(
  choice: EffectiveEncryptionChoice,
  currentShadowBehavior: LiveShadowEncryptionTransitionBehavior,
): EncryptionTarget {
  switch (choice) {
    case "plain":
      return { mode: "plaintext_only", shadowBehavior: "fallback" };
    case "fallback_shadow":
      return { mode: "shadow_encryption", shadowBehavior: "fallback" };
    case "strict_shadow":
      return { mode: "shadow_encryption", shadowBehavior: "strict" };
    case "fully_encrypted":
      return {
        mode: "encrypted_only",
        shadowBehavior: currentShadowBehavior,
      };
  }
}

function confirmationForChoice(
  choice: EffectiveEncryptionChoice,
  current: EffectiveEncryptionChoice,
): string {
  switch (choice) {
    case "plain":
      return DISABLE_SHADOW_ENCRYPTION_CONFIRMATION;
    case "fallback_shadow":
      return current === "strict_shadow"
        ? USE_FALLBACK_SHADOW_CONFIRMATION
        : ENABLE_SHADOW_ENCRYPTION_CONFIRMATION;
    case "strict_shadow":
      return ENABLE_STRICT_SHADOW_CONFIRMATION;
    case "fully_encrypted":
      return ENABLE_FULL_ENCRYPTION_CONFIRMATION;
  }
}

function attemptRatio(value: {
  readonly verified: string;
  readonly eligible: string;
  readonly percent: number | null;
}): string {
  return value.percent === null
    ? "No eligible attempts yet"
    : `${value.verified} / ${value.eligible} verified (${value.percent}%)`;
}

function pendingTurns(
  value: Readonly<{
    turns: string;
    oldestPendingAt: string | null;
  }>,
): string {
  if (value.turns === "0") return "None";
  if (value.oldestPendingAt === null) return `${value.turns} pending`;
  const ageMs = Math.max(0, Date.now() - Date.parse(value.oldestPendingAt));
  const minutes = Math.floor(ageMs / 60_000);
  const age =
    minutes < 1
      ? "under 1 minute"
      : minutes < 60
        ? `${minutes} minutes`
        : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${value.turns} pending · oldest ${age}`;
}

function reasonLabel(reason: string): string {
  return reason
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function stageLabel(stage: string, full = false): string {
  if (full && stage === "server_human_open_parity")
    return "Server Human Authentication";
  if (full && stage === "browser_durable_transcript_parity")
    return "Device Transcript Authentication";
  return reasonLabel(stage);
}

function historyReadHeadline(
  reads: EncryptionTransitionStatus["historyReads"],
): string {
  if (reads.pagesAttempted === "0") {
    return "No foreground history page has been checked yet";
  }
  if (reads.eligible === "0") {
    const pages = reads.pagesAttempted === "1" ? "page" : "pages";
    const messages = reads.selected === "1" ? "message" : "messages";
    return `${reads.pagesAttempted} ${pages} checked · ${reads.selected} ${messages} loaded · no protected copies found`;
  }
  return `${reads.verified} / ${reads.eligible} eligible protected reads verified${
    reads.percent === null ? "" : ` (${reads.percent}%)`
  }`;
}

function liveFallbackCount(
  fallbacks: EncryptionTransitionStatus["liveTurns"]["fallbacks"],
): string {
  return fallbacks
    .reduce((sum, fallback) => sum + BigInt(fallback.count), 0n)
    .toString();
}

function publicationFailureSummary(
  input: Readonly<{
    fallback: string;
    failed: string;
  }>,
  full: boolean,
): string {
  return full
    ? `${input.failed} protected failures · ${input.fallback} ordinary fallbacks`
    : `${input.fallback} plaintext fallbacks · ${input.failed} protected failures`;
}

function transitionUpdateError(cause: unknown): string {
  const code =
    cause !== null && typeof cause === "object" && "code" in cause
      ? cause.code
      : cause instanceof Error
        ? cause.message
        : null;
  if (code === "encryption_transition_busy") {
    return "Encryption mode cannot change while work is active. Try again when current work has finished.";
  }
  return cause instanceof Error
    ? cause.message
    : "Encryption transition update failed";
}

const BOUNDARY_LABELS: Readonly<Record<string, string>> = {
  "artifact.api.workspace": "Workspace artifacts",
  "background.memory.review": "Automatic memory review",
  "background.reflection.worker": "Reflection processing",
  "background.stenographer.worker": "Stenographer processing",
  "background.task.observer": "Task scheduling",
};

export function EncryptionTransitionCard() {
  const can = useCan();
  const canManage = can("manage_server_settings");
  const canRead = can("read_server_settings") || canManage;
  const [status, setStatus] = useState<EncryptionTransitionStatus | null>(null);
  const [protectionStatus, setProtectionStatus] =
    useState<StenographerProtectionStatus | null>(null);
  const [protectionUnavailable, setProtectionUnavailable] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [loading, setLoading] = useState(canRead);
  const [pendingChoice, setPendingChoice] =
    useState<EffectiveEncryptionChoice | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const refreshing = useRef(false);
  const currentChoice = status === null ? null : effectiveChoice(status.policy);
  const confirmation =
    pendingChoice === null || currentChoice === null
      ? null
      : confirmationForChoice(pendingChoice, currentChoice);

  const refresh = useCallback(async () => {
    if (!canRead) return;
    if (refreshing.current) return;
    refreshing.current = true;
    setLoading(true);
    setRefreshError(null);
    const [statusResult, protectionResult] = await Promise.allSettled([
      apiClient.admin.encryptionTransition.get(),
      apiClient.admin.stenographerStatus.getProtection(),
    ]);
    if (statusResult.status === "fulfilled") {
      setStatus(statusResult.value);
      setLastUpdatedAt(new Date());
      if (protectionResult.status === "fulfilled") {
        setProtectionStatus(protectionResult.value);
        setProtectionUnavailable(false);
      } else {
        setProtectionStatus(null);
        setProtectionUnavailable(true);
      }
    } else {
      const cause: unknown = statusResult.reason;
      setRefreshError(
        cause instanceof Error
          ? cause.message
          : "Encryption transition is unavailable",
      );
    }
    setLoading(false);
    refreshing.current = false;
  }, [canRead]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), AUTO_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const apply = async () => {
    if (
      status === null ||
      pendingChoice === null ||
      confirmation === null ||
      !canManage
    )
      return;
    const target = targetForChoice(pendingChoice, status.policy.shadowBehavior);
    setSaving(true);
    setUpdateError(null);
    try {
      setStatus(
        await apiClient.admin.encryptionTransition.update({
          requestVersion: 2,
          expectedRevision: status.policy.revision,
          targetMode: target.mode,
          targetShadowBehavior: target.shadowBehavior,
          confirmation,
        }),
      );
      setPendingChoice(null);
    } catch (cause) {
      setUpdateError(transitionUpdateError(cause));
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  if (!canRead) return null;

  return (
    <div
      className="rounded-md border border-border bg-background-element p-4"
      data-testid="encryption-transition-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Encryption mode</h3>
          <p className="mt-1 text-xs text-foreground-muted">
            Choose how the server stores and handles supported content. Changes
            require explicit confirmation.
          </p>
        </div>
        <button
          type="button"
          className="rounded-md border border-border px-2.5 py-1 text-xs"
          onClick={() => void refresh()}
          disabled={loading || saving}
        >
          Refresh
        </button>
      </div>

      {loading && status === null ? (
        <p className="mt-3 text-sm">Loading…</p>
      ) : null}
      {refreshError ? (
        <p className="mt-3 text-sm text-error" role="alert">
          {refreshError}
        </p>
      ) : null}
      {updateError ? (
        <p className="mt-3 text-sm text-error" role="alert">
          {updateError}
        </p>
      ) : null}
      {status ? (
        <>
          <fieldset className="mt-4 grid gap-2" disabled={!canManage || saving}>
            <legend className="sr-only">Server encryption mode</legend>
            {(
              [
                {
                  choice: "plain",
                  label: "No encryption",
                  description:
                    "Only uses plaintext. Stable, but your data is not encrypted by this mode. Previously encrypted copies are not erased.",
                  tone: "border-border bg-background-panel",
                },
                {
                  choice: "fallback_shadow",
                  label: "Fallback Shadow mode",
                  description:
                    "Uses encrypted data when available; falls back to plaintext when encrypted data is unavailable. Keeps both copies where possible. Use this mode during transition. Plaintext remains available to the server operator, so it adds no confidentiality from the operator.",
                  tone: "border-info/50 bg-info/10",
                },
                {
                  choice: "strict_shadow",
                  label: "Strict Shadow mode",
                  description:
                    "Requires encrypted data and still writes plaintext copies. Fails visibly instead of falling back. Use this mode for diagnostics before fully switching to encryption. Waiting for keys is a normal state, not corruption.",
                  tone: "border-warning/50 bg-warning/10",
                },
                {
                  choice: "fully_encrypted",
                  label: "Fully Encrypted mode",
                  description:
                    "Store only encrypted copies for supported content. Browser and Desktop chats and memories are supported. Public rooms, subtasks, artifacts, and mobile are unsupported. Existing plaintext is not erased. The only plaintext exceptions are Custom Soul and authored Skills. This mode is unstable—do not use it yet.",
                  tone: "border-error/50 bg-error/10",
                },
              ] as const
            ).map(({ choice, label, description, tone }) => (
              <label
                key={choice}
                className={`flex cursor-pointer gap-3 rounded-md border p-3 ${tone}`}
              >
                <input
                  type="radio"
                  name="encryption-transition-mode"
                  aria-label={label}
                  aria-describedby={`encryption-mode-${choice}-description`}
                  disabled={!canManage || saving}
                  checked={(pendingChoice ?? currentChoice) === choice}
                  onChange={() => {
                    setPendingChoice(choice);
                    setUpdateError(null);
                  }}
                />
                <span>
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {label}
                    {choice === "fully_encrypted" ? (
                      <span className="rounded-full border border-error/50 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-error">
                        Experimental
                      </span>
                    ) : null}
                  </span>
                  <span
                    id={`encryption-mode-${choice}-description`}
                    className="block text-xs text-foreground-muted"
                  >
                    {description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          {status.policy.mode === "encrypted_only" ? (
            <div
              className="mt-3 space-y-1 rounded-md border border-error/40 bg-error/10 p-3 text-xs text-foreground-muted"
              role="status"
            >
              <p>
                Fully Encrypted mode is active. Verified in this mode means
                authenticated ciphertext, not comparison with a plaintext copy.
              </p>
            </div>
          ) : null}

          {pendingChoice !== null && pendingChoice !== currentChoice ? (
            <div className="mt-3 rounded-md border border-warning/50 bg-warning/10 p-3">
              <p className="text-sm">{confirmation}</p>
              {pendingChoice === "strict_shadow" ? (
                <p className="mt-2 text-xs">
                  Readiness preview: {status.coverageReadiness.protected}{" "}
                  protected
                  {" · "}
                  {status.coverageReadiness.unsupported} unsupported
                  {" · "}
                  {status.coverageReadiness.unexercised} not yet classified.{" "}
                  These are registered boundaries, not runtime success counts.
                </p>
              ) : null}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)]"
                  onClick={() => void apply()}
                  disabled={saving}
                >
                  {saving ? "Applying…" : "Confirm change"}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-1.5 text-sm"
                  onClick={() => {
                    setPendingChoice(null);
                    setUpdateError(null);
                  }}
                  disabled={saving}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {!canManage ? (
            <p className="mt-3 text-xs text-foreground-muted">
              Read-only — server settings permission is required to change mode.
            </p>
          ) : null}

          <section
            className="mt-4"
            aria-labelledby="encryption-activity-summary"
          >
            <h4
              id="encryption-activity-summary"
              className="text-xs font-medium uppercase tracking-wide text-foreground-muted"
            >
              Recorded activity by scope
            </h4>
            <div className="mt-2 divide-y divide-border rounded-md border border-border bg-background-panel">
              <div className="grid gap-1 p-3 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(0,2fr)]">
                <p className="text-sm font-medium">
                  Supported foreground messages
                </p>
                <p className="text-xs text-foreground-muted">
                  {status.liveTurns.completeRoundTrip.eligible === "0"
                    ? "No eligible attempts yet — no health conclusion."
                    : `${attemptRatio(status.liveTurns.completeRoundTrip)}.`}{" "}
                  {pendingTurns(status.liveTurns.pending)} ·{" "}
                  {liveFallbackCount(status.liveTurns.fallbacks)} fallback
                  attempts
                </p>
              </div>
              <div className="grid gap-1 p-3 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(0,2fr)]">
                <p className="text-sm font-medium">
                  Human-only protected writes
                </p>
                <p className="text-xs text-foreground-muted">
                  {status.humanPeerLive.writes.eligible === "0"
                    ? "No eligible writes yet — no health conclusion."
                    : `${status.humanPeerLive.writes.published} / ${status.humanPeerLive.writes.eligible} published.`}{" "}
                  <span
                    className={
                      status.humanPeerLive.writes.pending === "0"
                        ? undefined
                        : "text-warning"
                    }
                  >
                    {status.humanPeerLive.writes.pending} pending
                  </span>{" "}
                  · {status.humanPeerLive.writes.fallback}{" "}
                  {status.policy.mode === "encrypted_only"
                    ? "ordinary fallbacks"
                    : "plaintext fallbacks"}{" "}
                  ·{" "}
                  <span
                    className={
                      status.humanPeerLive.writes.failed === "0"
                        ? undefined
                        : "text-error"
                    }
                  >
                    {status.humanPeerLive.writes.failed} protected failures
                  </span>
                </p>
              </div>
              <div className="grid gap-1 p-3 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(0,2fr)]">
                <p className="text-sm font-medium">
                  Shared Room + Agent protected writes
                </p>
                <p className="text-xs text-foreground-muted">
                  {status.sharedAgentLive.writes.eligible === "0"
                    ? "No eligible writes yet — no health conclusion."
                    : `${status.sharedAgentLive.writes.published} / ${status.sharedAgentLive.writes.eligible} published.`}{" "}
                  <span
                    className={
                      status.sharedAgentLive.writes.pending === "0"
                        ? undefined
                        : "text-warning"
                    }
                  >
                    {status.sharedAgentLive.writes.pending} pending
                  </span>{" "}
                  · {status.sharedAgentLive.writes.fallback}{" "}
                  {status.policy.mode === "encrypted_only"
                    ? "ordinary fallbacks"
                    : "plaintext fallbacks"}{" "}
                  ·{" "}
                  <span
                    className={
                      status.sharedAgentLive.writes.failed === "0"
                        ? undefined
                        : "text-error"
                    }
                  >
                    {status.sharedAgentLive.writes.failed} protected failures
                  </span>
                </p>
              </div>
              <div className="grid gap-1 p-3 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(0,2fr)]">
                <p className="text-sm font-medium">
                  Protected-operation checks
                </p>
                <div className="text-xs text-foreground-muted">
                  {status.runtimeHealth.lastObservedAt === null ? (
                    <>
                      No boundary activity in this policy revision — no health
                      conclusion. ·{" "}
                      <span
                        className={
                          status.runtimeHealth.unsupported === "0"
                            ? undefined
                            : "text-error"
                        }
                      >
                        {status.runtimeHealth.unsupported} unsupported
                      </span>
                    </>
                  ) : (
                    <>
                      {status.runtimeHealth.verified} verified ·{" "}
                      <span
                        className={
                          status.runtimeHealth.waitingForAuthority === "0"
                            ? undefined
                            : "text-warning"
                        }
                      >
                        {status.runtimeHealth.waitingForAuthority} waiting for
                        authority
                      </span>{" "}
                      · {status.runtimeHealth.repairing} repairing ·{" "}
                      <span
                        className={
                          status.runtimeHealth.failed === "0"
                            ? undefined
                            : "text-error"
                        }
                      >
                        {status.runtimeHealth.failed} failed
                      </span>{" "}
                      ·{" "}
                      <span
                        className={
                          status.runtimeHealth.unsupported === "0"
                            ? undefined
                            : "text-error"
                        }
                      >
                        {status.runtimeHealth.unsupported} unsupported
                      </span>
                      .
                    </>
                  )}
                  <p className="mt-1">
                    Counts operation types, not messages or failed jobs. Checks
                    run in both Shadow modes and Fully Encrypted mode, including
                    background checks with no work queued.
                  </p>
                  {status.runtimeHealth.boundaries.some((boundary) => boundary.state === "unsupported") && (
                    <>
                      <p className="mt-1 font-medium">Unsupported protected handling:</p>
                      <ul className="mt-1 list-disc pl-4">
                        {status.runtimeHealth.boundaries
                          .filter((boundary) => boundary.state === "unsupported")
                          .map((boundary) => (
                            <li key={boundary.boundaryId}>
                              {BOUNDARY_LABELS[boundary.boundaryId] ?? boundary.boundaryId}
                            </li>
                          ))}
                      </ul>
                      <p className="mt-1">
                        Fallback Shadow permits plaintext at these checks; Strict
                        Shadow and Fully Encrypted mode block unsupported handling.
                      </p>
                    </>
                  )}
                </div>
              </div>
              <div className="grid gap-1 p-3 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(0,2fr)]">
                <p className="text-sm font-medium">Domain key delivery</p>
                <p className="text-xs text-foreground-muted">
                  {status.domainKeyAuthority.catchUp.requested === "0"
                    ? "No catch-up deliveries requested yet — no health conclusion."
                    : `${status.domainKeyAuthority.catchUp.acknowledged} / ${status.domainKeyAuthority.catchUp.requested} acknowledged.`}{" "}
                  <span
                    className={
                      status.domainKeyAuthority.catchUp.waiting === "0"
                        ? undefined
                        : "text-warning"
                    }
                  >
                    {status.domainKeyAuthority.catchUp.waiting} waiting
                  </span>{" "}
                  · {status.domainKeyAuthority.catchUp.stale} stale ·{" "}
                  {status.domainKeyAuthority.catchUp.expired} expired ·{" "}
                  <span
                    className={
                      status.domainKeyAuthority.catchUp.unrecoverable === "0"
                        ? undefined
                        : "text-error"
                    }
                  >
                    {status.domainKeyAuthority.catchUp.unrecoverable}{" "}
                    unrecoverable
                  </span>
                </p>
              </div>
              <div className="grid gap-1 p-3 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(0,2fr)]">
                <p className="text-sm font-medium">
                  Foreground message history reads
                </p>
                <p className="text-xs text-foreground-muted">
                  {historyReadHeadline(status.historyReads)} ·{" "}
                  <span
                    className={
                      status.historyReads.pending === "0"
                        ? undefined
                        : "text-warning"
                    }
                  >
                    {status.historyReads.pending} pending
                  </span>{" "}
                  ·{" "}
                  <span
                    className={
                      status.historyReads.unavailable === "0"
                        ? undefined
                        : "text-error"
                    }
                  >
                    {status.historyReads.unavailable} unavailable
                  </span>
                </p>
              </div>
            </div>
          </section>

          <StenographerProtectionStatusPanel
            status={protectionStatus}
            unavailable={protectionUnavailable}
            headingId="encryption-transition-stenographer-protection-heading"
          />

          <p className="mt-1 text-xs text-foreground-muted" aria-live="polite">
            Auto-refreshes every 10 seconds
            {lastUpdatedAt === null
              ? "."
              : ` · Last updated ${lastUpdatedAt.toLocaleTimeString()}`}
            .
          </p>

          <details className="mt-3 rounded-md border border-border bg-background-panel p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Diagnostics Details
            </summary>
            <h4 className="mt-3 text-sm font-medium">
              Activity and coverage details
            </h4>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <section className="rounded-md border border-border bg-background-element p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                  Coverage readiness
                </p>
                <p className="mt-2 text-base font-semibold">
                  {status.coverageReadiness.protected} protected ·{" "}
                  {status.coverageReadiness.unsupported} unsupported
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  {status.coverageReadiness.registered} registered boundaries ·{" "}
                  {status.coverageReadiness.unexercised} not yet classified.
                  This is implementation coverage, not recent runtime success.
                </p>
              </section>

              <section className="rounded-md border border-border bg-background-element p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                  Runtime health
                </p>
                <p className="mt-2 text-base font-semibold">
                  {status.runtimeHealth.verified} verified ·{" "}
                  {status.runtimeHealth.waitingForAuthority} waiting ·{" "}
                  {status.runtimeHealth.repairing} repairing
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  {status.runtimeHealth.failed} failed ·{" "}
                  {status.runtimeHealth.unsupported} unsupported ·{" "}
                  {status.runtimeHealth.unexercised} not exercised in policy
                  revision {status.runtimeHealth.policyRevision}
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  {status.runtimeHealth.lastObservedAt === null
                    ? "No protected-operation check has been observed yet."
                    : `Last observed ${new Date(status.runtimeHealth.lastObservedAt).toLocaleString()}.`}
                </p>
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer font-medium">
                    Protected-operation check details
                  </summary>
                  <div className="mt-2 space-y-2">
                    {status.runtimeHealth.boundaries.filter(
                      (boundary) => boundary.state !== "unexercised",
                    ).length === 0 ? (
                      <p className="text-foreground-muted">
                        No registered boundary has been exercised in this policy
                        revision.
                      </p>
                    ) : (
                      status.runtimeHealth.boundaries
                        .filter((boundary) => boundary.state !== "unexercised")
                        .map((boundary) => (
                          <p
                            key={boundary.boundaryId}
                            className="break-all text-foreground-muted"
                          >
                            <span className="font-mono text-foreground">
                              {boundary.boundaryId}
                            </span>{" "}
                            · {boundary.family}/{boundary.operation} ·{" "}
                            {boundary.state}/{reasonLabel(boundary.reason)} ·{" "}
                            {boundary.occurrenceCount} observations
                          </p>
                        ))
                    )}
                  </div>
                </details>
              </section>

              <section className="rounded-md border border-border bg-background-element p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                  V2 Domain key catch-up
                </p>
                <p className="mt-2 text-base font-semibold">
                  {status.domainKeyAuthority.catchUp.acknowledged} /{" "}
                  {status.domainKeyAuthority.catchUp.requested} requested
                  deliveries acknowledged
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  {status.domainKeyAuthority.catchUp.waiting} waiting for an
                  online authorized device ·{" "}
                  {status.domainKeyAuthority.catchUp.delivered} delivered ·{" "}
                  {status.domainKeyAuthority.catchUp.stale} stale ·{" "}
                  {status.domainKeyAuthority.catchUp.expired} expired ·{" "}
                  {status.domainKeyAuthority.catchUp.unrecoverable}{" "}
                  unrecoverable
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Current authority:{" "}
                  {status.domainKeyAuthority.authority.humanDomainHeads} Human +{" "}
                  {status.domainKeyAuthority.authority.aiDomainHeads} AI Domain
                  heads ·{" "}
                  {status.domainKeyAuthority.authority.humanNamespaceBundles}{" "}
                  Human +{" "}
                  {status.domainKeyAuthority.authority.aiNamespaceBundles} AI
                  Namespace bundles
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Membership advances:{" "}
                  {
                    status.domainKeyAuthority.authority
                      .humanNamespaceBundleAdvances
                  }{" "}
                  Human +{" "}
                  {
                    status.domainKeyAuthority.authority
                      .aiNamespaceBundleAdvances
                  }{" "}
                  AI bundle heads
                </p>
              </section>

              <section className="rounded-md border border-border bg-background-element p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                  New foreground messages
                </p>
                <p className="mt-2 text-base font-semibold">
                  {attemptRatio(status.liveTurns.completeRoundTrip)}
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  {pendingTurns(status.liveTurns.pending)} ·{" "}
                  {liveFallbackCount(status.liveTurns.fallbacks)} fallback
                  attempts
                </p>
              </section>

              <section className="rounded-md border border-border bg-background-element p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                  Human-only protected writes
                </p>
                <p className="mt-2 text-base font-semibold">
                  {status.humanPeerLive.writes.eligible === "0"
                    ? "No eligible Human-only writes yet"
                    : `${status.humanPeerLive.writes.published} / ${
                        status.humanPeerLive.writes.eligible
                      } published (${status.humanPeerLive.writes.percent}%)`}
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  {status.humanPeerLive.writes.pending} pending ·{" "}
                  {publicationFailureSummary(
                    status.humanPeerLive.writes,
                    status.policy.mode === "encrypted_only",
                  )}
                </p>
              </section>

              <section className="rounded-md border border-border bg-background-element p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                  Human-only recipient reads
                </p>
                <p className="mt-2 text-base font-semibold">
                  {status.humanPeerLive.recipientReads.attempted === "0"
                    ? "No recipient device has checked a message yet"
                    : `${status.humanPeerLive.recipientReads.verified} / ${
                        status.humanPeerLive.recipientReads.attempted
                      } ${status.policy.mode === "encrypted_only" ? "authenticated" : "verified by parity"} (${status.humanPeerLive.recipientReads.percent}%)`}
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Counted independently for every receiving enrolled device ·{" "}
                  {status.humanPeerLive.recipientReads.fallback}{" "}
                  {status.policy.mode === "encrypted_only"
                    ? "protected read failures"
                    : "plaintext fallbacks"}
                </p>
              </section>

              <section className="rounded-md border border-border bg-background-element p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                  Shared Room + Agent protected writes
                </p>
                <p className="mt-2 text-base font-semibold">
                  {status.sharedAgentLive.writes.eligible === "0"
                    ? "No eligible shared-Room writes yet"
                    : `${status.sharedAgentLive.writes.published} / ${
                        status.sharedAgentLive.writes.eligible
                      } published (${status.sharedAgentLive.writes.percent}%)`}
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  {status.sharedAgentLive.writes.pending} pending ·{" "}
                  {publicationFailureSummary(
                    status.sharedAgentLive.writes,
                    status.policy.mode === "encrypted_only",
                  )}{" "}
                  · Human reads {status.sharedAgentLive.recipientReads.verified}{" "}
                  / {status.sharedAgentLive.recipientReads.attempted}{" "}
                  {status.policy.mode === "encrypted_only"
                    ? "authenticated"
                    : "verified by parity"}
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Recipient coverage{" "}
                  {status.sharedAgentLive.recipientCoverage.protectedHumans} /{" "}
                  {status.sharedAgentLive.recipientCoverage.totalHumans}{" "}
                  protected ·{" "}
                  {status.sharedAgentLive.recipientCoverage.plaintextOnlyHumans}{" "}
                  {status.policy.mode === "encrypted_only"
                    ? "not protected"
                    : "plaintext-only"}{" "}
                  · {status.sharedAgentLive.recipientCoverage.protectedDevices}{" "}
                  eligible devices
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Protected planning unavailable{" "}
                  {status.sharedAgentLive.planningFallbacks.unavailable} ·
                  device{" "}
                  {status.sharedAgentLive.planningFallbacks.deviceUnavailable} ·
                  Namespace{" "}
                  {
                    status.sharedAgentLive.planningFallbacks
                      .namespaceUnavailable
                  }{" "}
                  · recipient sync{" "}
                  {
                    status.sharedAgentLive.planningFallbacks
                      .recipientSyncRequired
                  }
                </p>
              </section>

              <section className="rounded-md border border-border bg-background-element p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                  Shared Room Conductor + Agent
                </p>
                <p className="mt-2 text-base font-semibold">
                  {status.sharedAgentLive.conductor.currentInputVerified} /{" "}
                  {status.sharedAgentLive.conductor.eligible} protected inputs
                  verified · {status.sharedAgentLive.conductor.fallback}{" "}
                  ordinary fallbacks
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Runtime authorization{" "}
                  {status.sharedAgentLive.conductor.authorizationEstablished}{" "}
                  established ·{" "}
                  {status.sharedAgentLive.conductor.authorizationReused} reused
                  · {status.sharedAgentLive.conductor.awaitingAuthorization}{" "}
                  awaiting device
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Protected routing{" "}
                  {status.sharedAgentLive.conductor.deterministic} deterministic
                  · {status.sharedAgentLive.conductor.floorManager} Floor
                  Manager · history{" "}
                  {status.sharedAgentLive.conductor.historyVerified} verified ·{" "}
                  {status.sharedAgentLive.conductor.historyNotRequested} not
                  requested ·{" "}
                  {status.sharedAgentLive.conductor.historyUnavailable}{" "}
                  unavailable
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Protected outcomes{" "}
                  {status.sharedAgentLive.conductor.verifiedWake} wake ·{" "}
                  {status.sharedAgentLive.conductor.verifiedAwaitingUser}{" "}
                  awaiting a Human choice ·{" "}
                  {status.sharedAgentLive.conductor.verifiedSilent} silent →{" "}
                  {status.sharedAgentLive.conductor.selectedAgentExecutions}{" "}
                  selected Agent executions
                </p>
                {status.sharedAgentLive.conductor.fallbackReasons.length > 0 ? (
                  <p className="mt-1 text-xs text-foreground-muted">
                    Exact protected fallbacks{" "}
                    {status.sharedAgentLive.conductor.fallbackReasons
                      .map((entry) => `${entry.reason}: ${entry.count}`)
                      .join(" · ")}
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-foreground-muted">
                  Human-operation receipts{" "}
                  {status.sharedAgentLive.conductor.selected} selected ·{" "}
                  {status.sharedAgentLive.conductor.notSelected} silent ·{" "}
                  {status.sharedAgentLive.conductor.awaitingUser} awaiting
                  choice · {status.sharedAgentLive.conductor.unavailable}{" "}
                  unavailable · {status.sharedAgentLive.executions.completed}{" "}
                  executions completed ·{" "}
                  {status.sharedAgentLive.executions.fallback} plaintext
                  fallbacks
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Authorization{" "}
                  {status.sharedAgentLive.authorization.established} established
                  · {status.sharedAgentLive.authorization.reused} reused ·{" "}
                  {status.sharedAgentLive.authorization.unavailable} unavailable
                  · {status.sharedAgentLive.authorization.expired} expired ·{" "}
                  {status.sharedAgentLive.authorization.revoked} revoked
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Protected resumes {status.sharedAgentLive.resumes.completed} /{" "}
                  {status.sharedAgentLive.resumes.attempted} completed ·{" "}
                  {status.sharedAgentLive.resumes.awaitingAuthorization}{" "}
                  awaiting device authorization ·{" "}
                  {status.sharedAgentLive.resumes.fallback} plaintext fallbacks
                  · {status.sharedAgentLive.resumes.failed} failed
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Output {status.sharedAgentLive.outputStages.streamCompleted} /{" "}
                  {status.sharedAgentLive.outputStages.streamStarted} streams
                  complete ·{" "}
                  {status.sharedAgentLive.outputStages.assistantPublished}{" "}
                  assistant rows ·{" "}
                  {status.sharedAgentLive.outputStages.toolResultsPublished}{" "}
                  tool-result rows · Agent/tool reads{" "}
                  {status.sharedAgentLive.agentRecipientReads.verified} /{" "}
                  {status.sharedAgentLive.agentRecipientReads.attempted}{" "}
                  {status.policy.mode === "encrypted_only"
                    ? "authenticated"
                    : "verified by parity"}
                </p>
              </section>

              <section className="rounded-md border border-border bg-background-element p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                  Foreground message history
                </p>
                <p className="mt-2 text-base font-semibold">
                  {historyReadHeadline(status.historyReads)}
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  {status.historyReads.pagesAttempted} cumulative page checks ·{" "}
                  {status.historyReads.selected} rows selected ·{" "}
                  {status.historyReads.pending} eligible reads pending ·{" "}
                  {status.historyReads.unavailable} protected reads unavailable.
                  Reloading a page checks its eligible rows again.
                </p>
              </section>
            </div>
            <section className="mt-3 rounded-md border border-border bg-background-panel p-3 text-xs">
              <h4 className="font-medium">Technical verification details</h4>
              <p className="mt-2 text-foreground-muted">
                A new turn is successful only after Human preparation, Agent
                processing, tool boundaries, durable transcript mapping,
                foreground-device decryption, and terminal{" "}
                {status.policy.mode === "encrypted_only"
                  ? "authentication"
                  : "parity"}{" "}
                all verify. History is measured separately for every foreground
                page request.
              </p>
              <div className="mt-3 grid gap-4 lg:grid-cols-2">
                <div className="overflow-x-auto">
                  <p className="mb-2 font-medium">New-turn stages</p>
                  <table className="w-full text-left">
                    <tbody>
                      {status.liveTurns.stages.map((stage) => (
                        <tr
                          key={stage.stage}
                          className="border-t border-border"
                        >
                          <th scope="row" className="py-2 pr-3">
                            {stageLabel(
                              stage.stage,
                              status.policy.mode === "encrypted_only",
                            )}
                          </th>
                          <td>{attemptRatio(stage)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <p className="font-medium">History outcomes</p>
                  <p className="mt-2 text-foreground-muted">
                    {status.historyReads.outcomes.length === 0
                      ? "No eligible protected history outcomes yet."
                      : status.historyReads.outcomes
                          .map(
                            (outcome) =>
                              `${
                                outcome.outcome === "verified"
                                  ? "Verified"
                                  : reasonLabel(outcome.reason)
                              }: ${outcome.count}`,
                          )
                          .join(", ")}
                  </p>
                  <p className="mt-3 font-medium">New-turn fallbacks</p>
                  <p className="mt-2 text-foreground-muted">
                    {status.liveTurns.fallbacks.length === 0
                      ? "None"
                      : status.liveTurns.fallbacks
                          .map(
                            (fallback) =>
                              `${stageLabel(fallback.stage)} · ${reasonLabel(fallback.reason)}: ${fallback.count}`,
                          )
                          .join(", ")}
                  </p>
                </div>
              </div>
            </section>
          </details>
        </>
      ) : null}
    </div>
  );
}
