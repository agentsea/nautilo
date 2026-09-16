import { InviteManagement } from "../../settings/sections/members-section";

export function InvitesSection() {
  return (
    <section
      id="invites"
      data-testid="admin-invites-section"
      className="rounded-lg border border-border bg-background-panel"
      aria-labelledby="invites-title"
    >
      <header className="border-b border-border px-5 py-3">
        <h2 id="invites-title" className="text-sm font-semibold">
          Invites
        </h2>
        <p className="mt-1 text-xs text-foreground-muted">
          Generate and manage server invites.
        </p>
      </header>
      <div className="px-5 py-4">
        <InviteManagement adminSurface />
      </div>
    </section>
  );
}
