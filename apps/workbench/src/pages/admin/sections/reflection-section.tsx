import { ReflectionHealthCard } from "./reflection-health-card";

export function ReflectionSection() {
  return (
    <section id="reflection" data-testid="admin-reflection-section" aria-label="Reflection">
      <ReflectionHealthCard />
      <a href="/admin#memory" className="mt-3 inline-flex text-xs font-medium text-primary hover:underline">
        View Memory recovery
      </a>
    </section>
  );
}
