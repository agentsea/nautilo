import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { InviteSummary, InvitableRoom } from "@nautilo/api-client/browser";
import { ApiError, InviteShareApiError } from "@nautilo/api-client/browser";
import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";
import { Button, FieldRow, SectionCard, TextInput } from "../ui";

const TTL_LABELS = ["1 hour", "24 hours", "7 days", "30 days", "Never"] as const;
const TTL_VALUES: ReadonlyArray<number | null> = [
  60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
  null,
];

const MAX_USES_LABELS = ["1", "3", "10", "Unlimited"] as const;
const MAX_USES_VALUES: ReadonlyArray<number | null> = [1, 3, 10, null];

type LadderRoleSlug =
  | "owner"
  | "admin"
  | "superuser"
  | "member"
  | "contributor"
  | "community"
  | "guest";
type EnrollableLadderRoleSlug = LadderRoleSlug;

const ROLE_OPTIONS: ReadonlyArray<{
  slug: LadderRoleSlug;
  label: string;
}> = [
  { slug: "owner", label: "Owner" },
  { slug: "admin", label: "Admin" },
  { slug: "superuser", label: "Superuser" },
  { slug: "member", label: "Member" },
  { slug: "contributor", label: "Contributor" },
  { slug: "community", label: "Community" },
  { slug: "guest", label: "Guest" },
];

export function inviteRoleOptions(adminSurface: boolean): ReadonlyArray<EnrollableLadderRoleSlug> {
  return (adminSurface
    ? ROLE_OPTIONS
    : ROLE_OPTIONS.filter(
        (role) => role.slug === "member"
          || role.slug === "contributor"
          || role.slug === "community"
          || role.slug === "guest",
      )
  ).map((role) => role.slug);
}

function SubSectionCard({
  title,
  description,
  actions,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="mt-4 rounded-lg border border-border/70 bg-background-panel/40 first:mt-0">
      <header className="flex items-start justify-between gap-4 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-xs text-foreground-muted">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

function kindLabel(kind: InviteSummary["kind"]): string {
  return kind === "server" ? "Server" : "Claim";
}

function formatUseLine(inv: InviteSummary): string {
  if (inv.usedCount === 0) return "Unused";
  if (inv.maxUses != null) return `Used ${inv.usedCount}/${inv.maxUses} times`;
  return `Used ${inv.usedCount} times`;
}

function formatExpiresLine(expiresAt: string | null): string {
  if (!expiresAt) return "Never expires";
  const end = new Date(expiresAt).getTime();
  const now = Date.now();
  const diff = end - now;
  if (diff <= 0) return "Expired";
  const dayMs = 86400000;
  const hourMs = 3600000;
  const minuteMs = 60000;
  const days = Math.floor(diff / dayMs);
  if (days >= 1) return `Expires in ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(diff / hourMs);
  if (hours >= 1) return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  const mins = Math.max(1, Math.floor(diff / minuteMs));
  return `Expires in ${mins} minute${mins === 1 ? "" : "s"}`;
}

function isActiveInvite(inv: InviteSummary): boolean {
  if (inv.revokedAt != null) return false;
  if (inv.maxUses != null && inv.usedCount >= inv.maxUses) return false;
  if (inv.expiresAt) {
    const end = new Date(inv.expiresAt).getTime();
    if (Number.isFinite(end) && end <= Date.now()) return false;
  }
  return true;
}

function inviteLabel(inv: InviteSummary): string {
  return inv.displayName?.trim() || `${kindLabel(inv.kind)} invite`;
}

function inviteRoleLabel(inv: InviteSummary): string {
  const option = ROLE_OPTIONS.find((role) => role.slug === inv.targetRoleSlug);
  return option?.label ?? inv.targetRoleSlug ?? "No server role";
}

function isPublicJoinEligible(inv: InviteSummary): boolean {
  return inv.kind === "server"
    && inv.codeAvailable
    && isActiveInvite(inv)
    && (inv.targetRoleSlug === "community" || inv.targetRoleSlug === "guest");
}

function ttlIndexToExpiresAt(idx: number): string | null {
  const offset = TTL_VALUES[idx];
  if (offset == null) return null;
  return new Date(Date.now() + offset).toISOString();
}

interface InviteFormState {
  role: EnrollableLadderRoleSlug;
  roomId: string;
  ttlIdx: number;
  maxUsesIdx: number;
}

const DEFAULT_FORM: InviteFormState = {
  role: "guest",
  roomId: "",
  ttlIdx: 1,
  maxUsesIdx: 0,
};

function NewInviteForm({
  adminSurface,
  onCancel,
  onCreated,
}: {
  adminSurface: boolean;
  onCancel: () => void;
  onCreated: (result: { id: string; code: string; url: string }) => void;
}) {
  const [form, setForm] = useState<InviteFormState>(DEFAULT_FORM);
  const [rooms, setRooms] = useState<InvitableRoom[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await apiClient.listInvitableRooms();
        setRooms(list);
      } catch (e) {
        setLoadError(
          e instanceof Error ? e.message : "Could not load rooms.",
        );
      }
    })();
  }, []);

  const onSubmit = useCallback(async () => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const expiresAt = ttlIndexToExpiresAt(form.ttlIdx);
      const maxUses = MAX_USES_VALUES[form.maxUsesIdx] ?? null;
      const res = await apiClient.createInvite({
        kind: "server",
        targetGroupRoleSlug: form.role,
        targetRoomId: form.roomId || undefined,
        maxUses,
        expiresAt,
      });
      onCreated({ id: res.id, code: res.token, url: res.url });
    } catch (e) {
      if (e instanceof ApiError) {
        setSubmitError(
          e.status >= 500 ? "Could not create invite — try again." : e.message,
        );
      } else {
        setSubmitError(
          e instanceof Error ? e.message : "Could not create invite.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  }, [form, onCreated]);

  const selectClass =
    "w-full rounded-md border border-border bg-background-element px-3 py-2 text-sm text-foreground focus:border-border-interactive focus:outline-none";
  const allowedRoles = new Set(inviteRoleOptions(adminSurface));
  const roleOptions = ROLE_OPTIONS.filter((role) => allowedRoles.has(role.slug));

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit();
      }}
    >
      {loadError ? (
        <p className="text-sm text-[var(--error)]">{loadError}</p>
      ) : null}

      <FieldRow label="Server Group role" htmlFor="invite-role">
        <select
          id="invite-role"
          value={form.role}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              role: e.target.value as InviteFormState["role"],
            }))
          }
          className={selectClass}
        >
          {roleOptions.map((r) => <option key={r.slug} value={r.slug}>{r.label}</option>)}
        </select>
      </FieldRow>
      {form.role === "owner" ? (
        <p className="text-xs text-[var(--warning,#d97706)]">
          ⚠ Owner has full server administration privileges.
        </p>
      ) : null}
      <FieldRow label="Room (optional)" htmlFor="invite-room">
        <select
          id="invite-room"
          value={form.roomId}
          onChange={(e) =>
            setForm((f) => ({ ...f, roomId: e.target.value }))
          }
          className={selectClass}
        >
          <option value="">None — server membership only</option>
          {rooms.map((r) => (
            <option key={r.roomId} value={r.roomId}>
              {r.label} ({r.type})
            </option>
          ))}
        </select>
      </FieldRow>

      <FieldRow label="Expires" htmlFor="invite-ttl">
        <select
          id="invite-ttl"
          value={form.ttlIdx}
          onChange={(e) =>
            setForm((f) => ({ ...f, ttlIdx: Number(e.target.value) }))
          }
          className={selectClass}
        >
          {TTL_LABELS.map((label, i) => (
            <option key={label} value={i}>
              {label}
            </option>
          ))}
        </select>
      </FieldRow>

      <FieldRow label="Max uses" htmlFor="invite-max">
        <select
          id="invite-max"
          value={form.maxUsesIdx}
          onChange={(e) =>
            setForm((f) => ({ ...f, maxUsesIdx: Number(e.target.value) }))
          }
          className={selectClass}
        >
          {MAX_USES_LABELS.map((label, i) => (
            <option key={label} value={i}>
              {label}
            </option>
          ))}
        </select>
      </FieldRow>

      {submitError ? (
        <p className="text-sm text-[var(--error)]">{submitError}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={submitting}
        >
          Create invite
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={submitting}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function InviteManagement({
  adminSurface,
}: {
  adminSurface: boolean;
}) {
  const can = useCan();
  const canUseInvites = adminSurface ? can("manage_members") : can("create_invites");
  const canManagePublicJoin = adminSurface
    && can("manage_members")
    && can("manage_server_enrollment");
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<"none" | "sign-in" | "message">(
    "none",
  );
  const [listErrorMessage, setListErrorMessage] = useState<string | null>(null);

  const [shareByInviteId, setShareByInviteId] = useState<
    Record<string, { code: string; url: string }>
  >({});
  const [showForm, setShowForm] = useState(false);
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [sharingTarget, setSharingTarget] = useState<string | null>(null);
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null);
  const [publicJoin, setPublicJoin] = useState<{
    inviteId: string | null;
    revision: number;
    joinUrl: string;
  } | null>(null);
  const [publicJoinError, setPublicJoinError] = useState<string | null>(null);
  const [updatingPublicJoin, setUpdatingPublicJoin] = useState(false);

  const loadInvites = useCallback(async () => {
    setLoading(true);
    setListError("none");
    setListErrorMessage(null);
    try {
      const rows: InviteSummary[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await apiClient.listInvites({
          ...(adminSurface ? { all: true } : {}),
          ...(cursor ? { cursor } : {}),
        });
        rows.push(...result.invites);
        if (!result.page.hasMore) break;
        const next = result.page.nextCursor;
        if (!next || seenCursors.has(next)) {
          throw new Error("Invite inventory continuation was invalid.");
        }
        seenCursors.add(next);
        cursor = next;
      } while (cursor);
      setInvites(rows);
      if (canManagePublicJoin) {
        try {
          setPublicJoin(await apiClient.getPublicJoinSelection());
          setPublicJoinError(null);
        } catch (e) {
          setPublicJoinError(
            e instanceof Error ? e.message : "Could not load the public join invite.",
          );
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setListError("sign-in");
        setInvites([]);
      } else {
        setListError("message");
        setListErrorMessage(
          e instanceof Error ? e.message : "Could not load invites.",
        );
        setInvites([]);
      }
    } finally {
      setLoading(false);
    }
  }, [adminSurface, canManagePublicJoin]);

  useEffect(() => {
    if (!canUseInvites) {
      setLoading(false);
      return;
    }
    void loadInvites();
  }, [canUseInvites, loadInvites]);

  const activeInvites = invites.filter(isActiveInvite);
  const publicJoinEligibleInvites = activeInvites.filter(isPublicJoinEligible);
  const selectedPublicJoinInvite = publicJoinEligibleInvites.find(
    (invite) => invite.id === publicJoin?.inviteId,
  );

  const copyText = useCallback(async (
    text: string,
    target: string,
    label: "code" | "URL",
  ) => {
    setActionError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTarget(target);
      window.setTimeout(() => {
        setCopiedTarget((cur) => (cur === target ? null : cur));
      }, 1500);
    } catch {
      setActionError(`Could not copy the invite ${label}. Select it and copy it manually.`);
    }
  }, []);

  const copyInviteShare = useCallback(async (
    invite: InviteSummary,
    field: "code" | "url",
  ) => {
    const target = `${invite.id}:${field}`;
    setSharingTarget(target);
    setActionError(null);
    try {
      const freshShare = justCreatedId === invite.id
        ? shareByInviteId[invite.id]
        : undefined;
      const share = freshShare ?? await apiClient.getInviteShare(invite.id);
      setShareByInviteId((current) => ({ ...current, [invite.id]: share }));
      await copyText(share[field], target, field === "code" ? "code" : "URL");
    } catch (e) {
      if (
        e instanceof InviteShareApiError
        && e.status === 409
        && e.code === "invite_code_unavailable"
      ) {
        setActionError(
          "This older invite's code cannot be recovered. Revoke it and create a replacement invite to share.",
        );
      } else {
        setActionError(
          e instanceof Error ? e.message : "Could not load the invite share details.",
        );
      }
    } finally {
      setSharingTarget(null);
    }
  }, [copyText, justCreatedId, shareByInviteId]);

  const onCreated = useCallback(
    async (created: { id: string; code: string; url: string }) => {
      setShareByInviteId((current) => ({
        ...current,
        [created.id]: { code: created.code, url: created.url },
      }));
      setJustCreatedId(created.id);
      setShowForm(false);
      setActionError(null);
      await loadInvites();
    },
    [loadInvites],
  );

  const updatePublicJoin = useCallback(async (inviteId: string | null) => {
    if (!publicJoin) return;
    setUpdatingPublicJoin(true);
    setPublicJoinError(null);
    try {
      setPublicJoin(await apiClient.updatePublicJoinSelection({
        inviteId,
        revision: publicJoin.revision,
      }));
    } catch (e) {
      setPublicJoinError(
        e instanceof Error ? e.message : "Could not update the public join invite.",
      );
    } finally {
      setUpdatingPublicJoin(false);
    }
  }, [publicJoin]);

  const onRevoke = useCallback(
    async (id: string) => {
      if (
        !window.confirm(
          "Revoke this invite? Anyone with the code will no longer be able to redeem it.",
        )
      ) {
        return;
      }
      setRevokingId(id);
      setActionError(null);
      try {
        await apiClient.revokeInvite(id);
        setShareByInviteId((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        if (justCreatedId === id) {
          setJustCreatedId(null);
        }
        await loadInvites();
      } catch (e) {
        setActionError(
          e instanceof Error ? e.message : "Could not revoke invite.",
        );
      } finally {
        setRevokingId(null);
      }
    },
    [justCreatedId, loadInvites],
  );

  return (
    <>
      {!canUseInvites ? (
        <p className="text-sm text-foreground-muted">
          You don&apos;t have permission to {adminSurface ? "administer server invitations" : "invite people"}.
        </p>
      ) : (
        <>
          <SubSectionCard
            title="Invites"
            description="Create a one-time or limited-use code. You can revoke a code anytime."
          >
            {showForm ? (
              <NewInviteForm
                adminSurface={adminSurface}
                onCancel={() => setShowForm(false)}
                onCreated={(c) => void onCreated(c)}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  onClick={() => {
                    setShowForm(true);
                    setActionError(null);
                  }}
                >
                  New invite
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void loadInvites()}
                  disabled={loading}
                >
                  Refresh
                </Button>
              </div>
            )}
          </SubSectionCard>

          <SubSectionCard title={adminSurface ? "Server invites" : "Your invites"}>
            {actionError ? (
              <p className="mb-3 text-sm text-[var(--error)]">{actionError}</p>
            ) : null}
            {loading ? (
              <p className="text-sm text-foreground-muted">Loading invites…</p>
            ) : listError === "sign-in" ? (
              <p className="text-sm text-foreground-muted">
                Sign in to see your invites.
              </p>
            ) : listError === "message" ? (
              <p className="text-sm text-[var(--error)]">{listErrorMessage}</p>
            ) : activeInvites.length === 0 ? (
              <p className="text-sm text-foreground-muted">
                Invites give someone else a sign-up code for this server. Each code
                works once unless you raise the use cap.
              </p>
            ) : (
              <ul className="divide-y divide-border/60 border border-border/60 rounded-md">
                {activeInvites.map((inv) => {
                  const share = shareByInviteId[inv.id];
                  const isFresh = justCreatedId === inv.id;
                  const codeTarget = `${inv.id}:code`;
                  const urlTarget = `${inv.id}:url`;
                  return (
                    <li
                      key={inv.id}
                      className="flex flex-col gap-2 px-3 py-3"
                      data-fresh={isFresh ? "1" : undefined}
                    >
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="text-sm font-medium text-foreground">
                            {inviteLabel(inv)}
                            {publicJoin?.inviteId === inv.id ? (
                              <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-xs text-primary">
                                Selected for /join
                              </span>
                            ) : null}
                          </p>
                          <p className="text-xs text-foreground-muted">
                            {inviteRoleLabel(inv)} · Room: {inv.targetRoomLabel ?? "None"} ·{" "}
                            {formatExpiresLine(inv.expiresAt)} · {formatUseLine(inv)}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          {inv.codeAvailable ? (
                            <Button
                              variant="secondary"
                              loading={sharingTarget === codeTarget}
                              onClick={() => void copyInviteShare(inv, "code")}
                            >
                              {copiedTarget === codeTarget ? "Code copied" : "Copy code"}
                            </Button>
                          ) : null}
                          {inv.codeAvailable ? (
                            <Button
                              variant="secondary"
                              loading={sharingTarget === urlTarget}
                              onClick={() => void copyInviteShare(inv, "url")}
                            >
                              {copiedTarget === urlTarget ? "URL copied" : "Copy URL"}
                            </Button>
                          ) : null}
                          {canManagePublicJoin && isPublicJoinEligible(inv) ? (
                            <Button
                              variant={publicJoin?.inviteId === inv.id ? "primary" : "secondary"}
                              loading={updatingPublicJoin && publicJoin?.inviteId !== inv.id}
                              disabled={updatingPublicJoin || publicJoin?.inviteId === inv.id}
                              onClick={() => void updatePublicJoin(inv.id)}
                            >
                              {publicJoin?.inviteId === inv.id ? "Selected for /join" : "Use for /join"}
                            </Button>
                          ) : null}
                          <Button
                            variant="secondary"
                            loading={revokingId === inv.id}
                            onClick={() => void onRevoke(inv.id)}
                          >
                            Revoke
                          </Button>
                        </div>
                      </div>
                      {!inv.codeAvailable ? (
                        <p className="text-xs text-foreground-dim">
                          This older invite&apos;s code cannot be recovered. Revoke it
                          and create a replacement invite if you need to share it.
                        </p>
                      ) : share ? (
                        <>
                          <FieldRow
                            label={isFresh ? "New invite code" : "Invite code"}
                            htmlFor={`invite-code-${inv.id}`}
                          >
                            <TextInput
                              id={`invite-code-${inv.id}`}
                              value={share.code}
                              onChange={() => {}}
                              readOnly
                              ariaLabel="Invite code"
                            />
                          </FieldRow>
                          <FieldRow
                            label={isFresh ? "New invite URL" : "Invite URL"}
                            htmlFor={`invite-url-${inv.id}`}
                          >
                            <TextInput
                              id={`invite-url-${inv.id}`}
                              value={share.url}
                              onChange={() => {}}
                              readOnly
                              ariaLabel="Invite URL"
                            />
                          </FieldRow>
                        </>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </SubSectionCard>

          {canManagePublicJoin ? (
            <SubSectionCard
              title="Public /join invite"
              description="Choose the active Community or Guest invite used by the server's canonical /join address."
              actions={publicJoin?.inviteId ? (
                <Button
                  variant="secondary"
                  loading={updatingPublicJoin}
                  disabled={updatingPublicJoin}
                  onClick={() => void updatePublicJoin(null)}
                >
                  Clear /join
                </Button>
              ) : undefined}
            >
              {publicJoinError ? (
                <p className="text-sm text-[var(--error)]">{publicJoinError}</p>
              ) : publicJoin ? (
                <div className="space-y-2">
                  <p className="text-sm text-foreground">
                    {selectedPublicJoinInvite
                      ? "The public join address uses the selected invite."
                      : publicJoin.inviteId
                        ? "The selected invite is unavailable. Choose another or clear /join."
                        : "The public join address is unavailable until you select an invite."}
                  </p>
                  <a
                    className="break-all text-sm text-primary hover:underline"
                    href={publicJoin.joinUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {publicJoin.joinUrl}
                  </a>
                  {publicJoinEligibleInvites.length === 0 ? (
                    <p className="text-xs text-foreground-muted">
                      Create an active Community or Guest invite to make /join available.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-foreground-muted">Loading the public join invite…</p>
              )}
            </SubSectionCard>
          ) : null}
        </>
      )}
    </>
  );
}

export function InvitePeopleSection() {
  return (
    <SectionCard
      id="invite-people"
      title="Invite people"
      description="Create and manage invitations."
    >
      <InviteManagement adminSurface={false} />
    </SectionCard>
  );
}
