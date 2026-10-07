import { useEffect, useState } from "react";
import type { PersonalCostsSummary } from "@nautilo/api-client/browser";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { apiClient } from "../../../lib/api";
import { PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT } from "../../../lib/caller-model-availability";
import { useAuth } from "../../../hooks/use-auth";
import { CostsCompactSummary } from "../../costs/costs-dashboard";
import { normalizePersonalCosts } from "../../costs/costs-view-model";
import { SectionCard } from "../ui";

export function PersonalCostsSection() {
  const identityGeneration = useAuth().viewerGeneration;
  const [loaded, setLoaded] = useState<{
    identityGeneration: number;
    data: PersonalCostsSummary;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let generation = 0;
    let active = true;
    const load = () => {
      const request = ++generation;
      setLoading(true);
      setError(false);
      setLoaded(null);
      void apiClient
        .getPersonalCosts("30d")
        .then((summary) => {
          if (active && request === generation) {
            setLoaded({ identityGeneration, data: summary });
          }
        })
        .catch(() => {
          if (active && request === generation) setError(true);
        })
        .finally(() => {
          if (active && request === generation) setLoading(false);
        });
    };
    void identityGeneration;
    load();
    window.addEventListener(PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT, load);
    return () => {
      active = false;
      generation += 1;
      window.removeEventListener(
        PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT,
        load,
      );
    };
  }, [identityGeneration]);
  const data =
    loaded !== null && loaded.identityGeneration === identityGeneration ? loaded.data : null;
  return (
    <SectionCard
      id="personal-costs"
      title="Your costs"
      description="Personal provider-key spend and usage from the last 30 days."
    >
      {loading ? (
        <p className="py-3 text-sm text-foreground-muted">
          Loading your costs…
        </p>
      ) : null}
      {error ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-error">
            Your costs could not be loaded.
          </p>
          <Link className="text-sm text-primary hover:underline" to="/account/costs">
            Open the full dashboard to try again
          </Link>
        </div>
      ) : null}
      {!loading && !error && data && !data.entry.available ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-foreground-muted">
            Add a personal API key to pay for eligible work from your own
            provider account. Past cost history will remain here if you later
            remove or replace a key.
          </p>
          <div>
            <Link
              className="text-sm text-primary hover:underline"
              to="/settings#personal-provider-keys"
            >
              Manage personal API keys
            </Link>
          </div>
        </div>
      ) : null}
      {!loading && !error && data?.entry.available ? (
        <CostsCompactSummary
          data={normalizePersonalCosts(data)}
          periodLabel="30d"
          footer={
            !data.entry.hasPersonalCredentials && data.entry.hasHistory ? (
              <p className="text-xs text-foreground-muted">
                This history remains available even though no personal API key
                is currently saved.
              </p>
            ) : null
          }
          action={
            <Link
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              to="/account/costs"
            >
              View full cost dashboard
              <ArrowRight className="h-4 w-4" />
            </Link>
          }
        />
      ) : null}
    </SectionCard>
  );
}
