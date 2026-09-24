import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { InviteSummary, InvitableRoom } from "@nautilo/api-client/browser";
import { ApiError } from "@nautilo/api-client/browser";
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
type EnrollableLadderRoleSlug = Exclude<LadderRoleSlug, "community">;

const ROLE_OPTIONS: ReadonlyArray<{
  slug: LadderRoleSlug;
  label: string;
  enrollmentAvailable: boolean;
}> = [
  { slug: "owner", label: "Owner", enrollmentAvailable: true },
  { slug: "admin", label: "Admin", enrollmentAvailable: true },
  { slug: "superuser", label: "Superuser", enrollmentAvailable: true },
  { slug: "member", label: "Member", enrollmentAvailable: true },
  { slug: "contributor", label: "Contributor", enrollmentAvailable: true },
  { slug: "community", label: "Community", enrollmentAvailable: false },
  { slug: "guest", label: "Guest", enrollmentAvailable: true },
];

export function inviteRoleOptions(adminSurface: boolean): ReadonlyArray<EnrollableLadderRoleSlug> {
  return (adminSurface
    ? ROLE_OPTIONS
    : ROLE_OPTIONS.filter(
        (role) => role.slug === "member"
          || role.slug === "contributor"
          || role.slug === "guest",
      )
  ).filter((role) => role.enrollmentAvailable)
    .map((role) => role.slug as EnrollableLadderRoleSlug);
}

// localStorage key — keeps the freshly-minted invite code around so the
// user can copy it again later without re-creating the invite. Server
// only returns the token once (on POST /api/invites), so without this
// the code would become uncopyable after the success banner is dismissed.
const CODE_STORAGE_KEY = "nautilo.inviteCodes.v1";
/** Pre-code-only UI persisted full redeem URLs; migrate tokens out of those. */
const LEGACY_URL_STORAGE_KEY = "nautilo.inviteUrls.v1";

function extractInviteCode(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^inv_[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  const pathMatch = trimmed.match(
    /(?:^|\/)(?:redeem|invite)\/(inv_[A-Za-z0-9_-]+)/,
  );
  return pathMatch?.[1] ?? null;
}

function parseStoredCodeMap(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k !== "string" || typeof v !== "string") continue;
      const code = extractInviteCode(v);
      if (code) out[k] = code;
    }
    return out;
  } catch {
    return {};
  }
}

function readStoredCodes(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  const current = parseStoredCodeMap(localStorage.getItem(CODE_STORAGE_KEY));
  if (Object.keys(current).length > 0) return current;
  // One-shot migrate from the old URL cache (codes only; drop the URLs).
  const legacy = parseStoredCodeMap(
    localStorage.getItem(LEGACY_URL_STORAGE_KEY),
  );
  if (Object.keys(legacy).length > 0) {
    writeStoredCodes(legacy);
    try {
      localStorage.removeItem(LEGACY_URL_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  return legacy;
}

function writeStoredCodes(map: Record<string, string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CODE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota / private-mode failures */
  }
}

function pruneStoredCodes(activeIds: ReadonlyArray<string>): void {
  const have = readStoredCodes();
  const allowed = new Set(activeIds);
  let changed = false;
  for (const id of Object.keys(have)) {
    if (!allowed.has(id)) {
      delete have[id];
      changed = true;
    }
  }
  if (changed) writeStoredCodes(have);
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
  const roleOptions = ROLE_OPTIONS.filter((role) =>
    allowedRoles.has(role.slug as EnrollableLadderRoleSlug) || role.slug === "community"
  ).filter((role) =>
    adminSurface || role.slug === "member" || role.slug === "contributor" ||
    role.slug === "community" || role.slug === "guest"
  );

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
          {roleOptions.map((r) => (
            <option key={r.slug} value={r.slug} disabled={!r.enrollmentAvailable}>
              {r.label}{r.enrollmentAvailable ? "" : " — unavailable until personal-key chat launches"}
            </option>
          ))}
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
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<"none" | "sign-in" | "message">(
    "none",
  );
  const [listErrorMessage, setListErrorMessage] = useState<string | null>(null);

  const [codeByInviteId, setCodeByInviteId] = useState<Record<string, string>>(
    () => readStoredCodes(),
  );
  const [showForm, setShowForm] = useState(false);
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [justCreatedUrl, setJustCreatedUrl] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null);

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
      pruneStoredCodes(rows.map((row) => row.id));
      setCodeByInviteId(readStoredCodes());
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
  }, [adminSurface]);

  useEffect(() => {
    if (!canUseInvites) {
      setLoading(false);
      return;
    }
    void loadInvites();
  }, [canUseInvites, loadInvites]);

  const activeInvites = invites.filter(isActiveInvite);

  const persistCode = useCallback((id: string, code: string) => {
    const next = { ...readStoredCodes(), [id]: code };
    writeStoredCodes(next);
    setCodeByInviteId(next);
  }, []);

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

  const onCreated = useCallback(
    async (created: { id: string; code: string; url: string }) => {
      persistCode(created.id, created.code);
      setJustCreatedId(created.id);
      setJustCreatedUrl(created.url);
      setShowForm(false);
      setActionError(null);
      await loadInvites();
    },
    [loadInvites, persistCode],
  );

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
        const map = readStoredCodes();
        delete map[id];
        writeStoredCodes(map);
        setCodeByInviteId(map);
        if (justCreatedId === id) {
          setJustCreatedId(null);
          setJustCreatedUrl(null);
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
                  const rowCode = codeByInviteId[inv.id];
                  const isFresh = justCreatedId === inv.id;
                  const rowUrl = isFresh ? justCreatedUrl : null;
                  const codeTarget = `${inv.id}:code`;
                  const urlTarget = `${inv.id}:url`;
                  return (
                    <li
                      key={inv.id}
                      className="flex flex-col gap-2 px-3 py-3"
                      data-fresh={isFresh ? "1" : undefined}
                    >
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                        <div className="text-xs text-foreground-muted">
                          {kindLabel(inv.kind)} · {formatUseLine(inv)} ·{" "}
                          {formatExpiresLine(inv.expiresAt)}
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          {rowCode ? (
                            <Button
                              variant="secondary"
                              onClick={() => void copyText(rowCode, codeTarget, "code")}
                            >
                              {copiedTarget === codeTarget ? "Code copied" : "Copy code"}
                            </Button>
                          ) : null}
                          {rowUrl ? (
                            <Button
                              variant="secondary"
                              onClick={() => void copyText(rowUrl, urlTarget, "URL")}
                            >
                              {copiedTarget === urlTarget ? "URL copied" : "Copy URL"}
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
                      {rowCode ? (
                        <FieldRow
                          label={isFresh ? "New invite code" : "Code"}
                          htmlFor={`invite-code-${inv.id}`}
                        >
                          <TextInput
                            id={`invite-code-${inv.id}`}
                            value={rowCode}
                            onChange={() => {}}
                            readOnly
                            ariaLabel="Invite code"
                          />
                        </FieldRow>
                      ) : (
                        <p className="text-xs text-foreground-dim">
                          Code unavailable — invites minted on another device or
                          after a localStorage reset can&apos;t be recovered. Revoke
                          and mint a new one if you need to share it.
                        </p>
                      )}
                      {rowUrl ? (
                        <>
                          <FieldRow
                            label="New invite URL"
                            htmlFor={`invite-url-${inv.id}`}
                          >
                            <TextInput
                              id={`invite-url-${inv.id}`}
                              value={rowUrl}
                              onChange={() => {}}
                              readOnly
                              ariaLabel="Invite URL"
                            />
                          </FieldRow>
                          <p className="text-xs text-foreground-dim">
                            Copy this URL before reloading. It won&apos;t be shown again.
                          </p>
                        </>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </SubSectionCard>
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
      description="Create and manage invitations. Community is visible for planning but remains unavailable until personal-key chat launches."
    >
      <InviteManagement adminSurface={false} />
    </SectionCard>
  );
}
