import { ContextRetentionCard } from "./context-retention-card";
import { StenographerHealthCard } from "./stenographer-health-card";

export function StenographerSection() {
  return (
    <section id="stenographer" data-testid="admin-stenographer-section" aria-label="Stenographer">
      <StenographerHealthCard />
      <ContextRetentionCard />
    </section>
  );
}
