import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { IdentitySection } from "./sections/identity-section";
import { MyAgentsSection } from "./sections/my-agents-section";
import { PersonalDevicesSection } from "./sections/personal-devices-section";
import { EncryptedRecoverySection } from "./sections/encrypted-recovery-section";
import { InvitePeopleSection } from "./sections/members-section";
import { SecuritySection } from "./sections/security-section";
import { AboutSection } from "./sections/about-section";
import { YourAccessSection } from "./sections/your-access-section";
import { NotificationsSection } from "./sections/notifications-section";
import { ThisMacSection } from "./sections/this-mac-section";
import type { SectionId } from "./ui";
import type { UiTargetId } from "@nautilo/types";
import { apiClient } from "../../lib/api";
import { isDesktop } from "../../lib/desktop";
import { useCan } from "../../hooks/use-can";

/**
 * Settings nav items — all in-page scroll anchors. Connections is NOT here:
 * it's a dedicated rail destination (`/connections`, D384 umbrella of MCP
 * servers + Integrations), a peer of Skills/Memory/Commands — reached from
 * the navigation rail, not this scroll nav (keeps every item here a scroll
 * anchor, no mixed route/scroll behavior).
 */
export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SectionId; label: string; catalogueTarget: UiTargetId }> = [
  { id: "profile", label: "Profile", catalogueTarget: "settings.profile" },
  { id: "my-agents", label: "My Agents", catalogueTarget: "settings.my_agents" },
  { id: "this-mac", label: "This Mac", catalogueTarget: "settings.this_mac" },
  { id: "notifications", label: "Notifications", catalogueTarget: "settings.notifications" },
  { id: "your-access", label: "Your access", catalogueTarget: "settings.your_access" },
  { id: "devices", label: "Devices", catalogueTarget: "settings.devices" },
  { id: "encrypted-recovery", label: "Encryption", catalogueTarget: "settings.encrypted_recovery" },
  { id: "invite-people", label: "Invite people", catalogueTarget: "settings.invite_people" },
  { id: "security", label: "Account security", catalogueTarget: "settings.security" },
  { id: "about", label: "About", catalogueTarget: "settings.about" },
];

const NESTED_SECTION_PARENT: Readonly<Record<string, SectionId>> = {
  members: "invite-people",
  "profile-soul": "my-agents",
  model: "my-agents",
  fallback: "my-agents",
  startup: "this-mac",
  "current-folder": "this-mac",
  "desktop-permissions": "this-mac",
  "workstation-access": "this-mac",
  "mobile-access": "devices",
};

/** Stable catalogue destinations rendered inside the current Agent's details. */
export const SETTINGS_NESTED_SECTIONS = [
  { id: "model", label: "Model", catalogueTarget: "settings.model", parentId: "my-agents" },
  { id: "fallback", label: "Model fallback", catalogueTarget: "settings.fallback", parentId: "my-agents" },
  { id: "startup", label: "Ready at startup", catalogueTarget: "settings.startup", parentId: "this-mac" },
  { id: "current-folder", label: "Current folder", catalogueTarget: "settings.current_folder", parentId: "this-mac" },
  { id: "desktop-permissions", label: "macOS permissions", catalogueTarget: "settings.desktop_permissions", parentId: "this-mac" },
  { id: "workstation-access", label: "Workstation access", catalogueTarget: "settings.workstation_access", parentId: "this-mac" },
  { id: "mobile-access", label: "Mobile controllers", catalogueTarget: "settings.mobile_access", parentId: "devices" },
] as const satisfies ReadonlyArray<{
  id: SectionId;
  label: string;
  catalogueTarget: UiTargetId;
  parentId: SectionId;
}>;

export function activeSectionForHash(hash: string): SectionId | null {
  if (SETTINGS_SECTIONS.some((s) => s.id === hash)) return hash as SectionId;
  return NESTED_SECTION_PARENT[hash] ?? null;
}

export function visibleSettingsSections({
  isDesktopShell,
  canCreateInvites,
}: {
  isDesktopShell: boolean;
  canCreateInvites: boolean;
}) {
  return SETTINGS_SECTIONS.filter((section) =>
    (isDesktopShell || section.id !== "this-mac") &&
    (canCreateInvites || section.id !== "invite-people"));
}

/**
 * Settings page: scrollable content with a sticky section nav on the left.
 * Sections own their data loading, validation, and save UX independently so
 * a failure in one doesn't block the others.
 */
export function SettingsPage() {
  const can = useCan();
  const canCreateInvites = can("create_invites");
  const [managedByCloud, setManagedByCloud] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void apiClient.getSetupStatus()
      .then((status) => { if (!cancelled) setManagedByCloud(status.providers?.managedByCloud ?? true); })
      .catch(() => { if (!cancelled) setManagedByCloud(true); });
    return () => { cancelled = true; };
  }, []);
  const visibleSections = useMemo(() => visibleSettingsSections({
    isDesktopShell: isDesktop,
    canCreateInvites,
  }), [canCreateInvites]);
  const [active, setActive] = useState<SectionId>("profile");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (location.hash === "#keys") {
      void navigate("/admin#provider-credentials", { replace: true });
    }
  }, [location.hash, navigate]);

  // M056 — deep-link via URL hash (e.g. `/settings#devices` from the
  // native menu's "Manage devices…" item). Also supports nested anchors
  // inside a top-level section, e.g. `/settings#profile-soul` from a
  // profile-specific Settings affordance.
  useEffect(() => {
    const hash = location.hash.replace(/^#/, "");
    if (!hash) return;
    const activeSection = activeSectionForHash(hash);
    if (!activeSection || !visibleSections.some((section) => section.id === activeSection)) return;
    // Defer one tick so sections have rendered before scrollIntoView.
    const t = setTimeout(() => {
      const targetId = hash === "members" ? activeSection : hash;
      const el = rootRef.current?.querySelector(`#${targetId}`);
      if (el) el.scrollIntoView({ behavior: "auto", block: "start" });
      setActive(activeSection);
    }, 0);
    return () => clearTimeout(t);
  }, [location.hash, visibleSections]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) {
          const nextId = visible[0].target.id as SectionId;
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

  const scrollTo = (id: SectionId) => {
    setActive(id);
    const el = rootRef.current?.querySelector(`#${id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label="Settings sections"
        className="hidden w-48 shrink-0 border-r border-border px-3 py-4 md:block"
      >
        <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-foreground-dim">
          Settings
        </div>
        <ul className="flex flex-col gap-0.5">
          {visibleSections.map((item) => {
            const isActive = active === item.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => scrollTo(item.id)}
                  aria-current={isActive ? "true" : undefined}
                  className={[
                    "w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    isActive
                      ? "bg-background-element font-medium text-foreground"
                      : "text-foreground-muted hover:bg-background-element hover:text-foreground",
                  ].join(" ")}
                >
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div ref={rootRef} className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-6">
          <header>
            <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
            <p className="mt-1 text-sm text-foreground-muted">
              Tune the assistant, wire up providers, and see where your data lives.
            </p>
          </header>

          <section id="profile" data-testid="settings-profile-panel" className="flex flex-col gap-6">
            <IdentitySection />
          </section>
          <MyAgentsSection showProviderKeyStatus={managedByCloud === false} />
          <ThisMacSection />
          <NotificationsSection />
          <YourAccessSection />
          <PersonalDevicesSection />
          <EncryptedRecoverySection />
          <InvitePeopleSection />
          <SecuritySection />
          <AboutSection />
        </div>
      </div>
    </div>
  );
}
