import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import type { AccessControlMutationOperation, PreviewMutationResponse } from "@nautilo/api-client";
import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";
import { accessControlTabs } from "./access-control-tabs";
import { AccessControlProvider, useAccessControl } from "./access-control-context";
import { CapabilitiesTab } from "./capabilities-tab";
import { ChangeReviewModal } from "./change-review-modal";
import { GroupsTab } from "./groups-tab";
import { RolesTab } from "./roles-tab";
import { UsersTab } from "./users-tab";

export function AccessControlPage() {
  const can = useCan();
  const allowed = can("manage_members") || can("manage_groups") || can("manage_roles");
  if (!allowed) return <div data-testid="access-control-denied" className="flex h-full items-center justify-center p-6"><p className="text-sm text-foreground-muted">You don&apos;t have permission to view access control.</p></div>;
  return <AccessControlProvider><AccessControlWorkspace /></AccessControlProvider>;
}

function AccessControlWorkspace() {
  const { userId, tab: routeTab } = useParams<{ userId: string; tab: string }>();
  const { refresh } = useAccessControl();
  const can = useCan();
  const tabs = accessControlTabs(can);
  const permittedTabs = tabs.filter((tab) => tab.available);
  const requested = userId ? "users" : routeTab;
  const activeTab = tabs.some((tab) => tab.id === requested) ? requested ?? permittedTabs[0]?.id : permittedTabs[0]?.id;
  const activeAllowed = tabs.find((tab) => tab.id === activeTab)?.available;
  const [preview, setPreview] = useState<PreviewMutationResponse | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const previewGeneration = useRef(0);
  const previewAbort = useRef<AbortController | null>(null);
  const cancelPreview = useCallback((clearPreview = true) => {
    previewAbort.current?.abort();
    previewAbort.current = null;
    ++previewGeneration.current;
    setPreviewPending(false);
    if (clearPreview) setPreview(null);
  }, []);
  useEffect(() => {
    cancelPreview();
    return () => cancelPreview();
  }, [cancelPreview, routeTab, userId]);
  const review = (operation: AccessControlMutationOperation) => {
    cancelPreview(false);
    const controller = new AbortController();
    previewAbort.current = controller;
    const generation = previewGeneration.current;
    setPreviewPending(true);
    setMutationError(null);
    void apiClient.admin.accessControl.previewChange(operation)
      .then((response) => {
        if (!controller.signal.aborted && generation === previewGeneration.current) setPreview(response);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && generation === previewGeneration.current) {
          setMutationError(cause instanceof Error ? cause.message : "Could not preview this change.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === previewGeneration.current) setPreviewPending(false);
      });
  };
  const applied = async (auditRecorded: boolean | undefined) => {
    await refresh();
    setRefreshKey((current) => current + 1);
    setPreview(null);
    if (auditRecorded === false) setMutationError("Change applied, but the audit event could not be recorded. Do not retry this change.");
  };
  if (requested && !activeAllowed) return <div data-testid="access-control-tab-denied" className="flex flex-1 items-center justify-center p-6"><p className="text-sm text-foreground-muted">You don&apos;t have permission to use this access-control section.</p></div>;
  if (!requested && activeTab !== "users") return <Navigate replace to={`/admin/access-control/${activeTab}`} />;
  return <div data-testid="access-control-page" className="flex h-full min-h-0 flex-col bg-background">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div><nav aria-label="Breadcrumb" className="text-sm text-foreground-muted"><Link to="/admin" className="hover:text-foreground">Server admin</Link><span aria-hidden="true"> › </span><span>Access control</span></nav><h1 className="mt-1 text-xl font-semibold">Access control</h1></div>
      <div className="flex gap-2"><Link to="/admin" className="rounded border border-border px-3 py-1.5 text-sm hover:bg-background-element">Back to Server admin</Link><Link to="/admin" aria-label="Close access control" className="rounded border border-border px-3 py-1.5 text-sm hover:bg-background-element">Close</Link></div>
    </header>
    <div className="border-b border-border px-4"><div role="tablist" aria-label="Access control sections" className="flex min-w-max gap-1 overflow-x-auto">{tabs.filter((tab) => tab.available || tab.id === "audit").map((tab) => tab.available ? <Link key={tab.id} id={`access-control-tab-${tab.id}`} to={tab.id === "users" ? "/admin/access-control" : `/admin/access-control/${tab.id}`} role="tab" aria-selected={tab.id === activeTab} aria-controls={`access-control-${tab.id}-panel`} className={tab.id === activeTab ? "border-b-2 border-primary px-3 py-3 text-sm font-medium" : "px-3 py-3 text-sm text-foreground-muted hover:text-foreground"}>{tab.label}</Link> : <button key={tab.id} type="button" role="tab" aria-selected="false" disabled title="Coming next" className="px-3 py-3 text-sm text-foreground-muted disabled:cursor-not-allowed">{tab.label} <span className="text-xs">(Coming next)</span></button>)}</div></div>
    {mutationError ? <p role="alert" className="border-b border-border px-4 py-2 text-sm text-[var(--error)]">{mutationError}</p> : null}
    {previewPending ? <p role="status" className="border-b border-border px-4 py-2 text-sm text-foreground-muted">Previewing change…</p> : null}
    {activeTab === "users" ? <div id="access-control-users-panel" role="tabpanel" aria-labelledby="access-control-tab-users" className="flex min-h-0 flex-1 flex-col"><UsersTab userId={userId} refreshKey={refreshKey} onReview={review} previewPending={previewPending} canCreateSharedAccessExisting={can("manage_groups") && can("manage_members")} canCreateSharedAccessNew={can("manage_groups") && can("manage_members") && can("manage_roles")} /></div> : null}
    {activeTab === "groups" ? <GroupsTab onReview={review} refreshKey={refreshKey} previewPending={previewPending} /> : null}
    {activeTab === "roles" ? <RolesTab onReview={review} previewPending={previewPending} /> : null}
    {activeTab === "capabilities" ? <CapabilitiesTab /> : null}
    {preview ? <ChangeReviewModal key={preview.fingerprint} preview={preview} onClose={cancelPreview} onApplied={applied} onRepreview={review} previewPending={previewPending} /> : null}
  </div>;
}
