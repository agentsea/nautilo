import { ContextRetentionCard } from "./context-retention-card";
import { StenographerHealthCard } from "./stenographer-health-card";

export function StenographerSection() {
  return (
    <section id="stenographer" data-testid="admin-stenographer-section" aria-label="Stenographer">
      <StenographerHealthCard />
      <ContextRetentionCard />
      <a href="/admin#memory" className="mt-3 inline-flex text-xs font-medium text-primary hover:underline">
        View Memory recovery
      </a>
    </section>
  );
}
