import { EncryptionTransitionCard } from "./encryption-transition-card";

export function EncryptionSection() {
  return (
    <section
      id="encryption"
      data-testid="admin-encryption-section"
      className="rounded-lg border border-border bg-background-panel"
      aria-labelledby="encryption-title"
    >
      <header className="border-b border-border px-5 py-3">
        <h2 id="encryption-title" className="text-sm font-semibold">
          Encryption
        </h2>
        <p className="mt-1 text-xs text-foreground-muted">
          Server-wide encryption mode, recorded activity, and verification
          evidence.
        </p>
      </header>
      <div className="px-5 py-4">
        <EncryptionTransitionCard />
      </div>
    </section>
  );
}
