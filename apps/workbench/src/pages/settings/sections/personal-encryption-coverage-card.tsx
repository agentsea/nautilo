import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MessageBackfillProgress,
  PersonalEncryptionCoverageV1,
} from "@nautilo/api-client/browser";

import { useAuth } from "../../../hooks/use-auth";
import { addAuthTransitionListener } from "../../../lib/auth-transition";
import { apiClient } from "../../../lib/api";
import { Button } from "../ui";
import { MessageHistoryBackfillProgress } from "./message-history-backfill-progress";

const REFRESH_INTERVAL_MS = 60_000;

const FAMILY_ROWS = Object.freeze([
  ["message", "Messages"],
  ["memory", "Memories"],
  ["journal_event", "Stenographer journal events"],
  ["reflection_record", "Reflection records"],
  ["artifact", "Workspace artifacts"],
  ["task", "Tasks and subtasks"],
] as const);

type CoverageFamily = (typeof FAMILY_ROWS)[number][0];

export interface PersonalEncryptionCoveragePort {
  getPersonal(
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PersonalEncryptionCoverageV1>;
  getMessageBackfillProgress?(
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<MessageBackfillProgress>;
}

const DEFAULT_PORT: PersonalEncryptionCoveragePort = {
  getPersonal: (options) => apiClient.encryptionCoverage.getPersonal(options),
  getMessageBackfillProgress: (options) =>
    apiClient.getMessageBackfillProgress(options),
};

function formatCount(value: string): string {
  return new Intl.NumberFormat().format(BigInt(value));
}

function formatCoverage(encrypted: string, accessible: string): string {
  const denominator = BigInt(accessible);
  if (denominator === 0n) return "—";
  const tenths = (BigInt(encrypted) * 1_000n + denominator / 2n) / denominator;
  const whole = tenths / 10n;
  const fraction = tenths % 10n;
  return fraction === 0n ? `${whole}%` : `${whole}.${fraction}%`;
}

function formatLastUpdated(computedAt: string, now: number): string {
  const timestamp = Date.parse(computedAt);
  if (!Number.isFinite(timestamp)) return "Last updated just now";
  const minutes = Math.max(0, Math.floor((now - timestamp) / REFRESH_INTERVAL_MS));
  if (minutes < 1) return "Last updated just now";
  return `Last updated ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

export function PersonalEncryptionCoverageCard({
  coveragePort = DEFAULT_PORT,
}: Readonly<{
  coveragePort?: PersonalEncryptionCoveragePort;
}> = {}) {
  const auth = useAuth();
  const [snapshot, setSnapshot] = useState<PersonalEncryptionCoverageV1 | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [messageProgress, setMessageProgress] = useState<MessageBackfillProgress | null>(null);
  const [messageProgressUnavailable, setMessageProgressUnavailable] = useState(false);
  const [liveStatus, setLiveStatus] = useState("");
  const [scopeGeneration, setScopeGeneration] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const mounted = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const lastSuccessfulAt = useRef<number | null>(null);
  const policy = useRef<PersonalEncryptionCoverageV1["policy"] | null>(null);

  const eligible = auth.viewer.isVerified && !auth.viewer.staleWhoami;
  const accountKey = auth.viewer.sessionUserId;

  const refresh = useCallback((): Promise<void> => {
    if (!eligible) return Promise.resolve();
    if (inFlight.current !== null) return inFlight.current;

    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    setLoading(true);
    let coverageSettled = false;
    let progressSettled = false;
    const releaseController = () => {
      if (coverageSettled && progressSettled
        && controller.current === requestController) controller.current = null;
    };
    const progressRequest = coveragePort.getMessageBackfillProgress === undefined
      ? Promise.resolve()
      : coveragePort.getMessageBackfillProgress({ signal: requestController.signal })
        .then((progress) => {
          if (!mounted.current || requestController.signal.aborted) return;
          setMessageProgress(progress);
          setMessageProgressUnavailable(false);
        })
        .catch((cause: unknown) => {
          if (!mounted.current || requestController.signal.aborted || isAbortError(cause)) return;
          setMessageProgress(null);
          setMessageProgressUnavailable(true);
        });
    void progressRequest.finally(() => {
      progressSettled = true;
      releaseController();
    });
    const request = coveragePort.getPersonal({ signal: requestController.signal })
      .then((next) => {
        if (!mounted.current || requestController.signal.aborted) return;
        const completedAt = Date.now();
        setSnapshot(next);
        policy.current = next.policy;
        lastSuccessfulAt.current = completedAt;
        setClock(completedAt);
        setWarning(null);
        setLiveStatus(next.policy === "plaintext_only"
          ? "Content encryption coverage is not active."
          : "Encryption coverage refreshed.");
      })
      .catch((cause: unknown) => {
        if (!mounted.current || requestController.signal.aborted || isAbortError(cause)) {
          return;
        }
        setWarning(lastSuccessfulAt.current === null
          ? "Coverage could not be loaded. Try refreshing again."
          : "Coverage could not be refreshed. The last successful results are still shown.");
        setClock(Date.now());
        setLiveStatus("Encryption coverage refresh failed.");
      })
      .finally(() => {
        coverageSettled = true;
        const ownsActiveRequest = controller.current === requestController;
        if (mounted.current && ownsActiveRequest) setLoading(false);
        if (inFlight.current === request) inFlight.current = null;
        releaseController();
      });
    inFlight.current = request;
    return request;
  }, [coveragePort, eligible]);

  useEffect(() => {
    mounted.current = true;
    policy.current = null;
    lastSuccessfulAt.current = null;
    setSnapshot(null);
    setWarning(null);
    setMessageProgress(null);
    setMessageProgressUnavailable(false);
    setLiveStatus("");
    if (document.visibilityState !== "hidden") void refresh();

    const interval = window.setInterval(() => {
      if (document.visibilityState !== "hidden"
        && policy.current !== "plaintext_only"
        && (lastSuccessfulAt.current === null
          || Date.now() - lastSuccessfulAt.current >= REFRESH_INTERVAL_MS)) {
        setClock(Date.now());
        void refresh();
      }
    }, REFRESH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden"
        || policy.current === "plaintext_only") return;
      const lastUpdated = lastSuccessfulAt.current;
      if (lastUpdated === null || Date.now() - lastUpdated >= REFRESH_INTERVAL_MS) {
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      mounted.current = false;
      controller.current?.abort();
      controller.current = null;
      inFlight.current = null;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [accountKey, coveragePort, eligible, refresh, scopeGeneration]);

  useEffect(() => addAuthTransitionListener((detail) => {
    if (detail.reason === "credential-refreshed") return;
    controller.current?.abort();
    if (detail.reason === "signed-out") {
      setSnapshot(null);
      setMessageProgress(null);
      setMessageProgressUnavailable(false);
      return;
    }
    setScopeGeneration((current) => current + 1);
  }), []);

  if (!eligible) return null;

  const inactive = snapshot?.policy === "plaintext_only";
  const families = snapshot === null
    ? new Map<CoverageFamily, PersonalEncryptionCoverageV1["families"][number]>()
    : new Map(snapshot.families.map((family) => [family.family, family]));

  return (
    <section
      className="mt-5 border-t border-border pt-5"
      aria-labelledby="personal-encryption-coverage-title"
      data-testid="personal-encryption-coverage"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="personal-encryption-coverage-title" className="text-sm font-semibold">
            Your encryption coverage
          </h3>
          {!inactive ? (
            <p className="mt-1 text-xs text-foreground-muted">
              Plaintext and encrypted counts overlap: the same item can appear in both while Shadow encryption is active.
            </p>
          ) : null}
        </div>
        {!inactive ? (
          <Button
            onClick={() => void refresh()}
            loading={loading}
            disabled={loading}
          >
            Refresh now
          </Button>
        ) : null}
      </div>

      {inactive ? (
        <p className="mt-4 text-sm text-foreground-muted">
          Content encryption coverage is not active while this server uses plaintext-only mode.
        </p>
      ) : snapshot === null && loading ? (
        <p className="mt-4 text-sm text-foreground-muted">Loading coverage…</p>
      ) : snapshot === null ? (
        <p className="mt-4 text-sm text-foreground-muted">
          Coverage is temporarily unavailable. Try refreshing again.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <caption className="sr-only">
              Counts of data you can access and its current encryption coverage
            </caption>
            <thead>
              <tr className="border-b border-border text-foreground-muted">
                <th scope="col" className="pb-2 pr-3 font-medium">Data</th>
                <th scope="col" className="px-3 pb-2 text-right font-medium">You can access</th>
                <th scope="col" className="px-3 pb-2 text-right font-medium">Plaintext present</th>
                <th scope="col" className="px-3 pb-2 text-right font-medium">Encrypted counterpart</th>
                <th scope="col" className="pb-2 pl-3 text-right font-medium">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {FAMILY_ROWS.map(([familyId, label]) => {
                const family = families.get(familyId);
                if (family === undefined || family.measurement === "unavailable") {
                  return (
                    <tr key={familyId} className="border-b border-border/40 last:border-b-0">
                      <th scope="row" className="py-2 pr-3 font-medium text-foreground">{label}</th>
                      <td colSpan={4} className="py-2 pl-3 text-right text-foreground-muted">
                        Temporarily unavailable
                      </td>
                    </tr>
                  );
                }
                if (family.measurement === "unsupported") {
                  return (
                    <tr key={familyId} className="border-b border-border/40 last:border-b-0">
                      <th scope="row" className="py-2 pr-3 font-medium text-foreground">{label}</th>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCount(family.accessible)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCount(family.plaintextPresent)}</td>
                      <td colSpan={2} className="py-2 pl-3 text-right text-foreground-muted">
                        Not supported yet
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={familyId} className="border-b border-border/40 last:border-b-0">
                    <th scope="row" className="py-2 pr-3 font-medium text-foreground">{label}</th>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCount(family.accessible)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCount(family.plaintextPresent)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCount(family.encryptedCounterpart)}</td>
                    <td className="py-2 pl-3 text-right tabular-nums">{formatCoverage(family.encryptedCounterpart, family.accessible)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <MessageHistoryBackfillProgress
        progress={messageProgress}
        unavailable={messageProgressUnavailable}
      />

      {warning ? (
        <p className="mt-3 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2 text-xs text-foreground" role="alert">
          {warning}
        </p>
      ) : null}
      {snapshot?.computedAt ? (
        <p className="mt-3 text-xs text-foreground-muted">
          {formatLastUpdated(snapshot.computedAt, clock)}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-foreground-muted">
        Whole-product and internal security coverage is broader than this personal percentage and remains available to administrators.
      </p>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveStatus}
      </p>
    </section>
  );
}
