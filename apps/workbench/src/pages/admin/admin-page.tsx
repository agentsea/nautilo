import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useCan } from "../../hooks/use-can";
import {
  ADMIN_PAGE_CAPS,
  ADMIN_DESTINATIONS,
  ADMIN_SECTIONS,
  adminDestinationAvailable,
  type AdminSectionId,
} from "./admin-sections";
import { ServerSection } from "./sections/server-section";
import { UsersSection } from "./sections/users-section";
import { ModerationSection } from "./sections/moderation-section";
import { InvitesSection } from "./sections/invites-section";
import { AuditLogSection } from "./sections/audit-log-section";
import { ModelsSection } from "./sections/models-section";
import { SecuritySection } from "./sections/security-section";
import { EncryptionSection } from "./sections/encryption-section";
import { OfficialMcpSection } from "./sections/official-mcp-section";
import { ReflectionSection } from "./sections/reflection-section";
import { SearchSection } from "./sections/search-section";
import { CostsSummarySection } from "./sections/costs-summary-section";
import { MemorySection } from "./sections/memory-health-card";
import { StenographerSection } from "./sections/stenographer-section";
import { ReportsSection } from "./sections/reports-section";
import { ProviderCredentialsSection } from "./sections/provider-credentials-section";
import { apiClient } from "../../lib/api";
import { useAuth } from "../../hooks/use-auth";

function hasAdminAccess(can: (cap: (typeof ADMIN_PAGE_CAPS)[number]) => boolean): boolean {
  return ADMIN_PAGE_CAPS.some((cap) => can(cap));
}

export function adminSectionForHash(hash: string): AdminSectionId | null {
  const section = hash.replace(/^#/, "");
  return ADMIN_SECTIONS.some((candidate) => candidate.id === section)
    ? section as AdminSectionId
    : null;
}

export function AdminPage() {
  const can = useCan();
  const auth = useAuth();
  const location = useLocation();
  const allowed = hasAdminAccess(can);
  const [managedByCloud, setManagedByCloud] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiClient.getSetupStatus()
      .then((status) => {
        if (!cancelled) {
          setManagedByCloud(status.providers?.managedByCloud ?? true);
        }
      })
      .catch(() => {
        if (!cancelled) setManagedByCloud(true);
      });
    return () => { cancelled = true; };
  }, []);

  const visibleSections = useMemo(
    () => ADMIN_SECTIONS.filter((section) => adminDestinationAvailable(
      section,
      auth.viewer.capabilities,
      managedByCloud,
    )),
    [auth.viewer.capabilities, managedByCloud],
  );
  const visibleDestinations = useMemo(
    () => ADMIN_DESTINATIONS.filter((destination) => adminDestinationAvailable(
      destination,
      auth.viewer.capabilities,
      managedByCloud,
    )),
    [auth.viewer.capabilities, managedByCloud],
  );

  const [active, setActive] = useState<AdminSectionId>(
    () => visibleSections[0]?.id ?? "server",
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hashSection = adminSectionForHash(location.hash);
  const scrollDestination = visibleSections.some((section) => section.id === hashSection)
    ? hashSection
    : null;

  useEffect(() => {
    if (visibleSections.some((s) => s.id === active)) return;
    const first = visibleSections[0]?.id;
    if (first) setActive(first);
  }, [active, visibleSections]);

  // `/admin#server` and `/admin#invites` are real destinations, not merely
  // browser anchors. The actual scroll container is this page, so settle it
  // after the permitted sections mount on every history/hash change.
  // Permission refreshes recreate the section array even when access is unchanged.
  // Only actual navigation or newly available target access should move the reader.
  useEffect(() => {
    const id = scrollDestination;
    if (!id) return;
    const timer = setTimeout(() => {
      const element = rootRef.current?.querySelector(`#${id}`);
      if (!element) return;
      element.scrollIntoView({ behavior: "auto", block: "start" });
      setActive(id);
    }, 0);
    return () => clearTimeout(timer);
  }, [location.key, scrollDestination]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || visibleSections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) {
          const nextId = visible[0].target.id as AdminSectionId;
          setActive((prev) => (prev === nextId ? prev : nextId));
        }
      },
      {
        root,
        rootMargin: "-20% 0px -60% 0px",
        threshold: [0, 0.25, 0.5, 1.0],
      },
    );

    for (const { id } of visibleSections) {
      const el = root.querySelector(`#${id}`);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [visibleSections]);

  const scrollTo = useCallback((id: AdminSectionId) => {
    setActive(id);
    const el = rootRef.current?.querySelector(`#${id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  if (!allowed) {
    return (
      <div
        data-testid="admin-access-denied"
        className="flex h-full min-h-0 items-center justify-center px-6"
      >
        <p className="text-sm text-foreground-muted">
          You don&apos;t have access to server admin.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0" data-testid="admin-page">
      <nav
        aria-label="Server admin sections"
        className="hidden w-48 shrink-0 border-r border-border px-3 py-4 md:block"
      >
        <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-foreground-dim">
          Server admin
        </div>
        <ul className="flex flex-col gap-0.5">
          {visibleDestinations.map((destination) => {
            const className = [
              "block w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              destination.kind === "section" && active === destination.id
                ? "bg-background-element font-medium text-foreground"
                : "text-foreground-muted hover:bg-background-element hover:text-foreground",
            ].join(" ");
            return (
              <li key={destination.id}>
                {destination.kind === "route" ? (
                  <Link to={destination.href} className={className}>
                    {destination.label}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => scrollTo(destination.id)}
                    aria-current={active === destination.id ? "true" : undefined}
                    className={className}
                  >
                    {destination.label}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <div ref={rootRef} className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-6">
          <header>
            <h1 className="text-2xl font-semibold tracking-tight">Server admin</h1>
            <p className="mt-1 text-sm text-foreground-muted">
              Manage server identity, background services, integrations, search, access, and security.
            </p>
          </header>
          {visibleSections.map((s) => {
            switch (s.id) {
              case "server":
                return <ServerSection key={s.id} />;
              case "memory":
                return <MemorySection key={s.id} />;
              case "stenographer":
                return <StenographerSection key={s.id} />;
              case "reflection":
                return <ReflectionSection key={s.id} />;
              case "search":
                return <SearchSection key={s.id} />;
              case "costs":
                return <CostsSummarySection key={s.id} />;
              case "users":
                return <UsersSection key={s.id} />;
              case "moderation":
                return <ModerationSection key={s.id} />;
              case "invites":
                return <InvitesSection key={s.id} />;
              case "reports":
                return <ReportsSection key={s.id} />;
              case "audit-log":
                return <AuditLogSection key={s.id} />;
              case "models":
                return <ModelsSection key={s.id} />;
              case "provider-credentials":
                return <ProviderCredentialsSection key={s.id} />;
              case "official-mcps":
                return <OfficialMcpSection key={s.id} />;
              case "security":
                return <SecuritySection key={s.id} />;
              case "encryption":
                return <EncryptionSection key={s.id} />;
            }
          })}
        </div>
      </div>
    </div>
  );
}
