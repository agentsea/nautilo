import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopFilesystemAccessOperation } from "@nautilo/desktop-filesystem-grants";
import {
  desktopAPI,
  isDesktop,
  type DesktopActiveWorkstationProfileSummary,
  type DesktopWorkstationDiscoveryReview,
  type DesktopWorkstationProfileSeedDescriptor,
  type DesktopWorkstationProfileSummary,
  type DesktopListedDesktopFilesystemGrant,
} from "../../../lib/desktop";
import { PinDialog } from "../../../components/pin-dialog";
import type { DesktopFilesystemGrantFilesystemIdentity } from "@nautilo/desktop-filesystem-grants";
import { Button, StatusPill } from "../ui";
import { useAuth } from "../../../hooks/use-auth";
import { useCan } from "../../../hooks/use-can";
import { WorkstationShellAccess } from "./workstation-shell-access";
import {
  publishWorkstationProfileChanged,
  subscribeToWorkstationProfileChanges,
} from "../../../lib/workstation-profile-events";

const OPERATIONS: ReadonlyArray<{ value: DesktopFilesystemAccessOperation; label: string }> = [
  { value: "read", label: "Read files" },
  { value: "create_modify", label: "Create and modify files" },
  { value: "delete", label: "Delete files" },
  { value: "execute", label: "Execute files" },
];

function displayTime(value: string | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function resultError(error: unknown, fallback: string): string {
  return error instanceof Error ? fallback : fallback;
}

function reviewAcknowledgementKey(userId: string, profileId: string, revision: number): string {
  return `nautilo.workstation-profile-review.${encodeURIComponent(userId)}.${encodeURIComponent(profileId)}.${revision}`;
}

function hasAcknowledgedReview(userId: string | null, profileId: string, revision: number): boolean {
  if (!userId || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(reviewAcknowledgementKey(userId, profileId, revision)) === "acknowledged";
  } catch {
    return false;
  }
}

function acknowledgeReviewRevision(userId: string | null, profileId: string, revision: number): void {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(reviewAcknowledgementKey(userId, profileId, revision), "acknowledged");
  } catch {
    // This acknowledgement is display-only; unavailable storage must never
    // prevent the server-authoritative activation flow.
  }
}

/**
 * D418 — human-only local grant administration. This intentionally does not
 * browse the filesystem or make a picker result authority by itself.
 */
export function DesktopFilesystemAccessSection({
  isDesktopShell = isDesktop,
}: {
  /** Injectable for desktop-shell boundary tests. */
  isDesktopShell?: boolean;
} = {}) {
  const [grants, setGrants] = useState<DesktopListedDesktopFilesystemGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [canonicalRoot, setCanonicalRoot] = useState<string | null>(null);
  const [filesystemIdentity, setFilesystemIdentity] =
    useState<DesktopFilesystemGrantFilesystemIdentity | null>(null);
  const [selectedOperations, setSelectedOperations] = useState<DesktopFilesystemAccessOperation[]>([]);
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [seed, setSeed] = useState<DesktopWorkstationProfileSeedDescriptor | null>(null);
  const [discoveryReview, setDiscoveryReview] = useState<DesktopWorkstationDiscoveryReview | null>(null);
  const [storedSeedProfile, setStoredSeedProfile] =
    useState<DesktopWorkstationProfileSummary | null>(null);
  const [activeProfile, setActiveProfile] =
    useState<DesktopActiveWorkstationProfileSummary | null>(null);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [materializing, setMaterializing] = useState(false);
  const [activating, setActivating] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [pinPromptOpen, setPinPromptOpen] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  const [profileDetailsOpen, setProfileDetailsOpen] = useState(false);
  const [uncontainedStatus, setUncontainedStatus] = useState<{
    confirmed: boolean;
    active: boolean;
    eligible: boolean;
    reason: string | null;
    activatedAt: string | null;
  } | null>(null);
  const [uncontainedLoading, setUncontainedLoading] = useState(true);
  const [uncontainedBusy, setUncontainedBusy] = useState(false);
  const [uncontainedPinOpen, setUncontainedPinOpen] = useState(false);
  const [uncontainedError, setUncontainedError] = useState<string | null>(null);
  const uncontainedRequestGeneration = useRef(0);

  const grantsApi = desktopAPI?.desktopFilesystemGrants;
  const profilesApi = desktopAPI?.workstationProfiles;
  const uncontainedApi = desktopAPI?.uncontainedHostCommands;
  const auth = useAuth();
  const can = useCan();
  const canUseWorkstation = can("use_workstation");

  const load = useCallback(async () => {
    if (!grantsApi) return;
    setLoading(true);
    try {
      const result = await grantsApi.list();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setGrants(result.data.grants.filter((item) => item.status === "active"));
      setError(null);
    } catch (cause) {
      setError(resultError(cause, "Desktop Filesystem Grants could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, [grantsApi]);

  const loadProfiles = useCallback(async () => {
    if (!profilesApi) {
      setProfilesLoading(false);
      return;
    }

    setProfilesLoading(true);
    try {
      const [seedResult, profilesResult, activeResult] = await Promise.all([
        profilesApi.getSeedDescriptor(),
        profilesApi.listProfiles(),
        profilesApi.getActiveProfileSummary(),
      ]);

      const failures = [seedResult, profilesResult, activeResult].find(
        (result) => !result.ok,
      );
      if (failures && !failures.ok) {
        setProfileError(failures.message);
        return;
      }

      if (!seedResult.ok || !profilesResult.ok || !activeResult.ok) return;

      setSeed(seedResult.data);
      setStoredSeedProfile(
        profilesResult.data.profiles.find((profile) => profile.id === seedResult.data.id) ?? null,
      );
      setActiveProfile(activeResult.data);
      setProfileError(null);
    } catch (cause) {
      setProfileError(resultError(cause, "Developer Workstation details could not be loaded."));
    } finally {
      setProfilesLoading(false);
    }
  }, [profilesApi]);

  useEffect(() => {
    if (!isDesktopShell || !grantsApi) {
      setLoading(false);
      return;
    }
    void load();
  }, [grantsApi, isDesktopShell, load]);

  useEffect(() => {
    if (!isDesktopShell || !profilesApi || !canUseWorkstation) {
      setProfilesLoading(false);
      return;
    }
    void loadProfiles();
  }, [canUseWorkstation, isDesktopShell, loadProfiles, profilesApi]);

  useEffect(() => {
    if (!isDesktopShell || !profilesApi || !canUseWorkstation) return;
    return subscribeToWorkstationProfileChanges("settings", () => {
      void loadProfiles();
    });
  }, [canUseWorkstation, isDesktopShell, loadProfiles, profilesApi]);

  useEffect(() => {
    if (!canUseWorkstation || !seed || !profilesApi) return;

    const reviewIsAcknowledged = hasAcknowledgedReview(
      auth.viewer.sessionUserId,
      seed.id,
      seed.revision,
    );
    if (reviewIsAcknowledged) {
      setDiscoveryReview(null);
      setReviewAcknowledged(true);
      setReviewLoading(false);
      return;
    }

    let cancelled = false;
    setReviewAcknowledged(false);
    setReviewLoading(true);
    setProfileError(null);
    void profilesApi.runDiscoveryReview().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setProfileError(result.message);
        return;
      }
      setDiscoveryReview(result.data.review);
    }).catch(() => {
      if (!cancelled) {
        setProfileError("Developer Workstation review could not be loaded.");
      }
    }).finally(() => {
      if (!cancelled) setReviewLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [auth.viewer.sessionUserId, canUseWorkstation, profilesApi, seed]);

  const loadUncontainedStatus = useCallback(async () => {
    const requestGeneration = ++uncontainedRequestGeneration.current;
    if (!uncontainedApi || !isDesktopShell) {
      if (requestGeneration === uncontainedRequestGeneration.current) {
        setUncontainedStatus(null);
        setUncontainedLoading(false);
      }
      return;
    }
    if (requestGeneration === uncontainedRequestGeneration.current) {
      setUncontainedLoading(true);
    }
    try {
      const status = await uncontainedApi.getStatus();
      if (requestGeneration === uncontainedRequestGeneration.current) {
        setUncontainedStatus(status);
      }
    } catch {
      if (requestGeneration === uncontainedRequestGeneration.current) {
        setUncontainedStatus({
          confirmed: false,
          active: false,
          eligible: false,
          reason: "server_status_unavailable",
          activatedAt: null,
        });
      }
    } finally {
      if (requestGeneration === uncontainedRequestGeneration.current) {
        setUncontainedLoading(false);
      }
    }
  }, [isDesktopShell, uncontainedApi]);

  useEffect(() => {
    void loadUncontainedStatus();
  }, [loadUncontainedStatus]);

  const clearUncontainedConfirmation = useCallback(() => {
    ++uncontainedRequestGeneration.current;
    setUncontainedStatus((current) => current === null
      ? current
      : { ...current, confirmed: false, active: false, reason: "server_status_refreshing" });
  }, []);

  useEffect(() => {
    const refreshAfterLifecycle = () => {
      clearUncontainedConfirmation();
      void loadUncontainedStatus();
    };
    window.addEventListener("nautilo:uncontained-host-commands-changed", refreshAfterLifecycle);
    window.addEventListener("nautilo:policy-changed", refreshAfterLifecycle);
    window.addEventListener("nautilo:auth-changed", refreshAfterLifecycle);
    document.addEventListener("visibilitychange", refreshAfterLifecycle);
    return () => {
      window.removeEventListener("nautilo:uncontained-host-commands-changed", refreshAfterLifecycle);
      window.removeEventListener("nautilo:policy-changed", refreshAfterLifecycle);
      window.removeEventListener("nautilo:auth-changed", refreshAfterLifecycle);
      document.removeEventListener("visibilitychange", refreshAfterLifecycle);
    };
  }, [clearUncontainedConfirmation, loadUncontainedStatus]);

  useEffect(() => {
    if (uncontainedStatus?.confirmed !== true || !uncontainedStatus.active) return;
    const interval = window.setInterval(() => {
      clearUncontainedConfirmation();
      void loadUncontainedStatus();
    }, 12_000);
    return () => window.clearInterval(interval);
  }, [clearUncontainedConfirmation, loadUncontainedStatus, uncontainedStatus?.active, uncontainedStatus?.confirmed]);

  async function pickLocation(): Promise<void> {
    if (!grantsApi) return;
    setPicking(true);
    setError(null);
    try {
      const candidate = await grantsApi.pick();
      if (!candidate) return;

      // The picker returns only a candidate. Validation is separate and this
      // path deliberately never calls `create`.
      setPickedPath(candidate);
      setCanonicalRoot(null);
      setFilesystemIdentity(null);
      setSelectedOperations([]);
      const validation = await grantsApi.validate(candidate);
      if (!validation.ok) {
        setError(validation.message);
        return;
      }
      setCanonicalRoot(validation.data.canonicalRoot);
      setFilesystemIdentity(validation.data.filesystemIdentity);
    } catch (cause) {
      setError(resultError(cause, "The selected location could not be validated."));
    } finally {
      setPicking(false);
    }
  }

  function toggleOperation(operation: DesktopFilesystemAccessOperation): void {
    setSelectedOperations((current) =>
      current.includes(operation)
        ? current.filter((item) => item !== operation)
        : [...current, operation],
    );
  }

  async function createLocation(): Promise<void> {
    if (!grantsApi || !canonicalRoot || !filesystemIdentity || selectedOperations.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const result = await grantsApi.create({
        canonicalRoot,
        filesystemIdentity,
        access: selectedOperations,
        lifetime: "durable",
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setPickedPath(null);
      setCanonicalRoot(null);
      setFilesystemIdentity(null);
      setSelectedOperations([]);
      await load();
    } catch (cause) {
      setError(resultError(cause, "Desktop Filesystem Grant could not be created."));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(grantId: string): Promise<void> {
    if (!grantsApi) return;
    setRevokingId(grantId);
    setError(null);
    try {
      const result = await grantsApi.revoke(grantId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setGrants((current) => current.filter((item) => item.grant.id !== grantId));
    } catch (cause) {
      setError(resultError(cause, "Desktop Filesystem Grant could not be revoked."));
    } finally {
      setRevokingId(null);
    }
  }

  async function materializeSeed(): Promise<void> {
    if (!profilesApi || !seed) return;
    setMaterializing(true);
    setProfileError(null);
    try {
      const result = await profilesApi.materializeSeedProfile();
      if (!result.ok) {
        setProfileError(result.message);
        return;
      }
      setStoredSeedProfile(result.data.profile);
      acknowledgeReviewRevision(auth.viewer.sessionUserId, seed.id, seed.revision);
      setReviewAcknowledged(true);
    } catch (cause) {
      setProfileError(resultError(cause, "Developer Workstation profile could not be prepared."));
    } finally {
      setMaterializing(false);
    }
  }

  async function activateProfile(pin: string): Promise<void> {
    if (!profilesApi || !storedSeedProfile || !canUseWorkstation) return;
    setActivating(true);
    setProfileError(null);
    try {
      const result = await profilesApi.selectActiveProfile({
        profileId: storedSeedProfile.id,
        profileRevision: storedSeedProfile.revision,
        pin,
      });
      if (!result.ok) {
        setProfileError(result.message);
        return;
      }
      setActiveProfile(result.data.summary);
      setPinPromptOpen(false);
      publishWorkstationProfileChanged("settings");
    } catch (cause) {
      setProfileError(resultError(cause, "Developer Workstation could not be enabled."));
    } finally {
      setActivating(false);
    }
  }

  async function deactivateProfile(): Promise<void> {
    if (!profilesApi) return;
    setDeactivating(true);
    setProfileError(null);
    try {
      const result = await profilesApi.deactivateActiveProfile();
      if (!result.ok) {
        setProfileError(result.message);
        return;
      }
      setActiveProfile(null);
      publishWorkstationProfileChanged("settings");
    } catch (cause) {
      setProfileError(resultError(cause, "Developer Workstation could not be disabled."));
    } finally {
      setDeactivating(false);
    }
  }

  async function activateUncontainedHostCommands(pin: string): Promise<void> {
    if (!uncontainedApi) return;
    setUncontainedBusy(true);
    setUncontainedError(null);
    try {
      const result = await uncontainedApi.activate({ pin });
      if (!result.ok) {
        setUncontainedError(result.message);
        return;
      }
      setUncontainedPinOpen(false);
      clearUncontainedConfirmation();
      window.dispatchEvent(new CustomEvent("nautilo:uncontained-host-commands-changed"));
      await loadUncontainedStatus();
    } catch {
      setUncontainedError("Uncontained host commands could not be activated.");
    } finally {
      setUncontainedBusy(false);
    }
  }

  async function disableUncontainedHostCommands(): Promise<void> {
    if (!uncontainedApi) return;
    setUncontainedBusy(true);
    setUncontainedError(null);
    try {
      const result = await uncontainedApi.disable();
      if (!result.ok) {
        setUncontainedError(result.message);
        return;
      }
      clearUncontainedConfirmation();
      window.dispatchEvent(new CustomEvent("nautilo:uncontained-host-commands-changed"));
      await loadUncontainedStatus();
    } catch {
      setUncontainedError("Uncontained host commands could not be disabled.");
    } finally {
      setUncontainedBusy(false);
    }
  }

  if (!isDesktopShell) return null;

  return (
    <section
      id="workstation-access"
      aria-labelledby="workstation-access-title"
      data-testid="workstation-access-section"
      className="rounded-lg border border-border bg-background-panel"
    >
      <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-3">
        <div>
          <h2 id="workstation-access-title" className="text-sm font-semibold">
            Workstation access
          </h2>
          <p className="mt-1 text-xs text-foreground-muted">
            Manage protected local access and host commands.
          </p>
        </div>
      </header>
      <div className="space-y-4 px-5 py-4">
        <details className="group rounded-md border border-border bg-background-secondary">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:hidden">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Protected access</h3>
              <p className="mt-0.5 text-xs text-foreground-muted">
                Current Folder project authority, Genie Workspace, and additional guarded locations.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill tone={grants.length > 0 ? "ok" : "muted"}>
                {loading
                  ? "Loading"
                  : grants.length === 1
                    ? "1 added location"
                    : `${grants.length} added locations`}
              </StatusPill>
              <span
                aria-hidden="true"
                className="text-xs text-foreground-muted transition-transform group-open:rotate-90"
              >
                ›
              </span>
            </div>
          </summary>
          <div className="space-y-4 border-t border-border px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="max-w-xl text-xs text-foreground-muted">
                When Developer Workstation is active, Current Folder is the selected project with
                transient session authority. Add a guarded location only for a root outside Current
                Folder or Genie&apos;s persistent Workspace.
              </p>
              {grantsApi ? (
                <Button onClick={() => void pickLocation()} loading={picking} ariaLabel="Add location">
                  Add location
                </Button>
              ) : null}
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="font-medium text-foreground">Current Folder</dt>
            <dd className="text-xs text-foreground-muted">
              Selected project. An active Developer Workstation session locally identity-checks
              transient authority for it and its safe descendants; do not add it again below.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Genie Workspace</dt>
            <dd className="text-xs text-foreground-muted">Genie&apos;s persistent workspace.</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Additional guarded locations</dt>
            <dd className="text-xs text-foreground-muted">
              Explicit, revocable grants for roots outside Current Folder and Genie Workspace.
              Each covers safe canonical descendants for its declared operations; protected paths,
              identity checks, approvals, OS controls, and instance/profile/relay scope still apply.
            </dd>
          </div>
            </dl>

            {!grantsApi ? (
          <p className="text-sm text-foreground-muted">
            Desktop Filesystem Grant management is unavailable because
            {" "}desktopAPI.desktopFilesystemGrants is not exposed by this desktop build.
          </p>
            ) : (
          <>
            {error ? <p role="alert" className="text-sm text-[var(--error)]">{error}</p> : null}
            {loading ? (
              <p className="text-sm text-foreground-muted">Loading additional guarded locations…</p>
            ) : grants.length === 0 ? (
              <p className="text-sm text-foreground-muted">
                No additional guarded Desktop file locations have been granted.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase tracking-wider text-foreground-muted">
                    <tr>
                      <th className="py-2 pr-3 text-left font-medium">Location</th>
                      <th className="py-2 pr-3 text-left font-medium">Operations</th>
                      <th className="py-2 pr-3 text-left font-medium">Lifetime / origin</th>
                      <th className="py-2 pr-3 text-left font-medium">Last use</th>
                      <th className="py-2 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grants.map(({ grant }) => (
                      <tr key={grant.id} className="border-t border-border/40 align-middle">
                        <td className="max-w-48 break-all py-2 pr-3 font-mono text-xs text-foreground">
                          {grant.canonicalRoot}
                        </td>
                        <td className="py-2 pr-3 text-foreground-muted">
                          {grant.access.join(", ")}
                        </td>
                        <td className="py-2 pr-3 text-foreground-muted">
                          {grant.lifetime} / {grant.origin}
                        </td>
                        <td className="py-2 pr-3 text-foreground-muted">
                          {displayTime(grant.lastUsedAt)}
                        </td>
                        <td className="py-2 text-right">
                          <Button
                            onClick={() => void revoke(grant.id)}
                            loading={revokingId === grant.id}
                            disabled={revokingId !== null && revokingId !== grant.id}
                            ariaLabel={`Revoke access to ${grant.canonicalRoot}`}
                          >
                            Revoke
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {pickedPath ? (
              <div className="rounded-md border border-border bg-background-element p-3">
                <p className="text-sm font-medium text-foreground">Selected additional location</p>
                <code className="mt-1 block break-all text-xs text-foreground-muted">
                  {canonicalRoot ?? pickedPath}
                </code>
                {canonicalRoot ? (
                  <>
                    <fieldset className="mt-3">
                      <legend className="text-sm font-medium text-foreground">
                        Choose allowed operations
                      </legend>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {OPERATIONS.map((operation) => (
                          <label key={operation.value} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={selectedOperations.includes(operation.value)}
                              onChange={() => toggleOperation(operation.value)}
                            />
                            {operation.label}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <Button
                      onClick={() => void createLocation()}
                      disabled={selectedOperations.length === 0}
                      loading={creating}
                      ariaLabel="Create additional guarded location"
                    >
                      Create additional guarded location
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
          </>
            )}
          </div>
        </details>

        {canUseWorkstation ? (
        <>
        <details
          aria-labelledby="developer-workstation-title"
          className="group rounded-md border border-border bg-background-secondary"
          open={profileDetailsOpen}
          onToggle={(event) => setProfileDetailsOpen(event.currentTarget.open)}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:hidden">
            <div>
              <h3 id="developer-workstation-title" className="text-sm font-semibold text-foreground">
                Developer environment
              </h3>
              <p className="mt-0.5 text-xs text-foreground-muted">
                A reviewed tool and network profile for this desktop session.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill tone={activeProfile ? "ok" : storedSeedProfile ? "info" : "muted"}>
                {profilesLoading
                  ? "Loading"
                  : activeProfile
                    ? "On this session"
                    : storedSeedProfile
                      ? "Ready"
                      : "Review required"}
              </StatusPill>
              <button
                type="button"
                role="switch"
                aria-checked={activeProfile ? "true" : "false"}
                aria-label={activeProfile ? "Turn off developer environment" : "Turn on developer environment"}
                title={
                  activeProfile
                    ? "Turn off for this app session"
                    : storedSeedProfile && reviewAcknowledged
                      ? "Turn on with your PIN"
                      : "Review before turning on"
                }
                disabled={!profilesApi || profilesLoading || deactivating}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (activeProfile) {
                    void deactivateProfile();
                  } else if (storedSeedProfile && reviewAcknowledged) {
                    setPinPromptOpen(true);
                  } else {
                    setProfileDetailsOpen(true);
                  }
                }}
                className={[
                  "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
                  activeProfile ? "bg-[var(--success)]" : "bg-foreground-muted/40",
                  !profilesApi || profilesLoading || deactivating
                    ? "cursor-not-allowed opacity-50"
                    : "cursor-pointer",
                ].join(" ")}
              >
                <span
                  aria-hidden="true"
                  className={[
                    "inline-block h-4 w-4 rounded-full bg-background shadow transition-transform",
                    activeProfile ? "translate-x-4" : "translate-x-0.5",
                  ].join(" ")}
                />
              </button>
              <span
                aria-hidden="true"
                className="text-xs text-foreground-muted transition-transform group-open:rotate-90"
              >
                ›
              </span>
            </div>
          </summary>
          <div className="border-t border-border px-4 py-4">

          {!profilesApi ? (
            <p className="mt-3 text-sm text-foreground-muted">
              Developer Workstation is unavailable because
              {" "}desktopAPI.workstationProfiles is not exposed by this desktop build.
            </p>
          ) : profilesLoading ? (
            <p className="mt-3 text-sm text-foreground-muted">Loading Developer Workstation details…</p>
          ) : (
            <div className="mt-3 space-y-4">
              {profileError ? <p role="alert" className="text-sm text-[var(--error)]">{profileError}</p> : null}

              {activeProfile ? (
                <div className="flex justify-end">
                  <Button
                    onClick={() => void deactivateProfile()}
                    loading={deactivating}
                    ariaLabel="Disable Developer Workstation immediately"
                  >
                    Turn off
                  </Button>
                </div>
              ) : null}

              {seed ? (
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="font-medium text-foreground">Seed authority</dt>
                    <dd className="mt-1 text-xs text-foreground-muted">
                      {seed.name} · revision {seed.revision} · {seed.networkMode} network mode
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Capabilities</dt>
                    <dd className="mt-1 text-xs text-foreground-muted">
                      {seed.capabilities.length
                        ? seed.capabilities.map((capability) => capability.id).join(", ")
                        : "No capabilities declared"}
                    </dd>
                  </div>
                </dl>
              ) : null}

              {!reviewAcknowledged && reviewLoading ? (
                <p className="text-sm text-foreground-muted">
                  Reviewing Developer Workstation for this profile revision…
                </p>
              ) : null}

              {!reviewAcknowledged && discoveryReview ? (
                <div className="rounded-md border border-border bg-background-element p-3">
                  <p className="text-sm font-medium text-foreground">Discovery review</p>
                  <p className="mt-1 text-xs text-foreground-muted">
                    {discoveryReview.summary.found} found, {discoveryReview.summary.optional} optional,
                    {" "}{discoveryReview.summary.missing} missing · {discoveryReview.platform}
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-foreground-muted">
                    {discoveryReview.rows.map((row) => (
                      <li key={`${row.tool}-${row.capabilityId ?? ""}`}>
                        {row.tool}: {row.status}{row.note ? ` — ${row.note}` : ""}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-foreground-muted">
                    {discoveryReview.hostNetworkImplication}
                  </p>
                </div>
              ) : null}

              <div className="rounded-md border border-border bg-background-element p-3">
                <p className="text-sm font-medium text-foreground">Hard boundaries</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-foreground-muted">
                  {(discoveryReview?.hardBoundaries ?? [
                    "Activation uses only the stored profile and server-verified identity evidence.",
                  ]).map((boundary) => (
                    <li key={boundary}>{boundary}</li>
                  ))}
                  <li>
                    This does not grant root or administrator access, bypass macOS TCC or SIP, or
                    create broad filesystem authority. Current Folder authority is transient to
                    the active, identity-checked Developer Workstation session; additional roots
                    remain explicit guarded locations.
                  </li>
                </ul>
              </div>

              <p className="text-xs text-foreground-muted">
                Host-network mode can reach destinations available to this desktop. Tools may send
                data to those destinations, creating an exfiltration risk; review the profile and
                your network environment before enabling it.
              </p>

              <p className="text-xs text-foreground-muted">
                Capability status shown here can be stale. The server remains authoritative for
                activation and this acknowledgement only records that you reviewed this profile
                revision; it does not authorize access.
              </p>

              {activeProfile ? (
                <div className="rounded-md border border-border bg-background-element p-3">
                  <p className="text-sm font-medium text-foreground">Active for this session</p>
                  <p className="mt-1 text-xs text-foreground-muted">
                    Profile {activeProfile.profileId} · revision {activeProfile.profileRevision} ·{" "}
                    {activeProfile.networkMode} network mode
                  </p>
                </div>
              ) : storedSeedProfile && reviewAcknowledged ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-foreground-muted">
                    Enable for this app session with your own PIN.
                  </p>
                  <Button
                    onClick={() => setPinPromptOpen(true)}
                    variant="primary"
                    ariaLabel="Enable Developer Workstation with PIN"
                  >
                    Enable with PIN
                  </Button>
                </div>
              ) : (
                <Button
                  onClick={() => void materializeSeed()}
                  disabled={reviewLoading}
                  loading={materializing}
                  ariaLabel="Acknowledge and prepare Developer Workstation"
                >
                  Acknowledge review and prepare
                </Button>
              )}
            </div>
          )}
          </div>
        </details>
        <details className="group rounded-md border border-[var(--warning)]/50 bg-background-secondary">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:hidden">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Uncontained host commands</h3>
              <p className="mt-0.5 text-xs text-foreground-muted">
                A separate, high-risk session permission for this exact Desktop.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill tone={uncontainedStatus?.confirmed && uncontainedStatus.active ? "warn" : "muted"}>
                {uncontainedLoading
                  ? "Checking"
                  : uncontainedStatus?.confirmed && uncontainedStatus.active
                    ? "On this session"
                    : uncontainedStatus?.confirmed
                      ? "Off"
                      : "Unavailable"}
              </StatusPill>
              <span aria-hidden="true" className="text-xs text-foreground-muted transition-transform group-open:rotate-90">›</span>
            </div>
          </summary>
          <div className="space-y-3 border-t border-[var(--warning)]/30 px-4 py-4">
            {!uncontainedApi ? (
              <p className="text-sm text-foreground-muted">
                This Desktop build does not expose the uncontained-host-command control.
              </p>
            ) : (
              <>
                <p className="text-sm text-[var(--warning)]">
                  Warning: enabled commands run as this macOS account across everything it can access.
                  Current Folder is not a security boundary. This does not grant root access or bypass macOS protections.
                </p>
                {uncontainedError ? <p role="alert" className="text-sm text-[var(--error)]">{uncontainedError}</p> : null}
                {!uncontainedLoading && !uncontainedStatus?.confirmed ? (
                  <p className="text-sm text-foreground-muted">
                    Server confirmation is unavailable, so this control cannot show as on.
                  </p>
                ) : null}
                {!uncontainedLoading && uncontainedStatus?.confirmed && !uncontainedStatus.eligible ? (
                  <p className="text-sm text-foreground-muted">
                    Not eligible: {uncontainedStatus.reason?.replaceAll("_", " ") ?? "server policy does not allow this session"}.
                  </p>
                ) : null}
                {uncontainedStatus?.confirmed && uncontainedStatus.active ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-sm text-foreground-muted">Active only for this app session and exact connected Desktop.</p>
                    <Button
                      onClick={() => void disableUncontainedHostCommands()}
                      loading={uncontainedBusy}
                      ariaLabel="Disable uncontained host commands immediately"
                    >
                      Turn off immediately
                    </Button>
                  </div>
                ) : (
                  <Button
                    onClick={() => setUncontainedPinOpen(true)}
                    disabled={uncontainedLoading || uncontainedBusy || !uncontainedStatus?.confirmed || !uncontainedStatus.eligible}
                    variant="primary"
                    ariaLabel="Enable uncontained host commands with your PIN"
                  >
                    Enable with your PIN
                  </Button>
                )}
                <p className="text-xs text-foreground-muted">
                  This permission applies to ordinary run_shell commands only while this exact Desktop session remains active.
                </p>
              </>
            )}
          </div>
        </details>
        <WorkstationShellAccess />
        </>
        ) : null}
      </div>
      {pinPromptOpen ? (
        <PinDialog
          title="Enable Developer Workstation"
          prompt="Enter your own PIN. The server verifies your permissions and this desktop's relay binding before activation."
          error={profileError ?? undefined}
          onSubmit={(pin) => void activateProfile(pin)}
          onCancel={() => {
            if (!activating) {
              setPinPromptOpen(false);
              setProfileError(null);
            }
          }}
        />
      ) : null}
      {uncontainedPinOpen ? (
        <PinDialog
          title="Enable uncontained host commands"
          prompt="Enter your own PIN. Commands would run as this macOS account across everything it can access; Current Folder is not a boundary."
          error={uncontainedError ?? undefined}
          onSubmit={(pin) => void activateUncontainedHostCommands(pin)}
          onCancel={() => {
            if (!uncontainedBusy) {
              setUncontainedPinOpen(false);
              setUncontainedError(null);
            }
          }}
        />
      ) : null}
    </section>
  );
}
