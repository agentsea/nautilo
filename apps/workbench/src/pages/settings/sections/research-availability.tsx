import { useEffect, useState } from "react";
import { apiClient } from "../../../lib/api";
import { useAuth } from "../../../hooks/use-auth";
import { useCan } from "../../../hooks/use-can";
import { StatusPill } from "../ui";

type ResearchStatus = {
  desktopReaderAvailable: boolean;
  keylessSearchAvailable: boolean;
};

/** Caller-scoped research relay status; never exposes server provider policy. */
export function ResearchAvailability() {
  const { viewer } = useAuth();
  const can = useCan();
  const entitled = can("use_research_tools");
  const [status, setStatus] = useState<ResearchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!viewer.isVerified || !entitled) return;
    let cancelled = false;
    void apiClient.getResearchStatus()
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Research availability could not be loaded.");
      });
    return () => { cancelled = true; };
  }, [entitled, viewer.isVerified]);

  return (
    <section className="mt-4 border-t border-border/40 pt-4" aria-labelledby="research-availability-title">
      <h4 id="research-availability-title" className="text-sm font-medium">Web research availability</h4>
      {!entitled ? (
        <p className="mt-1 text-sm text-foreground-muted">Web research is not included in your current access.</p>
      ) : error ? (
        <p className="mt-1 text-sm text-[var(--error)]" role="alert">{error}</p>
      ) : !status ? (
        <p className="mt-1 text-sm text-foreground-muted">Checking connected work computers…</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <StatusPill tone={status.desktopReaderAvailable ? "ok" : "muted"}>
            Page reader {status.desktopReaderAvailable ? "available" : "unavailable"}
          </StatusPill>
          <StatusPill tone={status.keylessSearchAvailable ? "ok" : "muted"}>
            Keyless search {status.keylessSearchAvailable ? "available" : "unavailable"}
          </StatusPill>
        </div>
      )}
    </section>
  );
}
