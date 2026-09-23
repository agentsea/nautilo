import { useCallback, useState } from "react";
import { ApiError, LastOwnerError, pickHighestRoleSlug } from "@nautilo/api-client/browser";
import { apiClient } from "../../../../lib/api";
import { Button, FieldRow, TextInput } from "../../../settings/ui";
import type { AdminUserRow, GroupRow } from "./user-helpers";
import {
  FEDERATED_ACTIONS_TOOLTIP,
  LAST_OWNER_DELETE_MESSAGE,
  LAST_OWNER_DISABLE_MESSAGE,
  LAST_OWNER_MESSAGE,
  TRANSFER_OWNER_TOOLTIP,
  formatTimestamp,
  formatUserIdentity,
  groupRoleSlug,
  isFederatedUser,
  isUserInGroup,
  orderedCanonicalGroups,
  userRoleLabel,
} from "./user-helpers";
import { isCommunityEnrollmentTarget } from "../../access-control/group-membership-authority";

const UNCONTAINED_HOST_COMMANDS_GRANTEE_GROUP_TYPE =
  "uncontained_host_commands_grantees";

function DisabledActionButton({
  label,
  tooltip,
}: {
  readonly label: string;
  readonly tooltip: string;
}) {
  return (
    <Button variant="secondary" disabled title={tooltip}>
      {label}
    </Button>
  );
}

export function UserDetailPanel({
  user,
  loading,
  error,
  canManageMembers,
  canManageUncontainedHostCommands,
  isOwner,
  ownersCount,
  sessionUserId,
  canonicalGroups,
  groupsLoading,
  groupsError,
  onUserUpdated,
  onUserDeleted,
}: {
  readonly user: AdminUserRow | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly canManageMembers: boolean;
  readonly canManageUncontainedHostCommands: boolean;
  readonly isOwner: boolean;
  readonly ownersCount: number;
  readonly sessionUserId: string | null;
  readonly canonicalGroups: GroupRow[];
  readonly groupsLoading: boolean;
  readonly groupsError: string | null;
  readonly onUserUpdated: () => void;
  readonly onUserDeleted: () => void;
}) {
  const [disableMode, setDisableMode] = useState(false);
  const [disableReason, setDisableReason] = useState("");
  const [deleteMode, setDeleteMode] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<
    "disable" | "enable" | "reset" | "delete" | null
  >(null);
  const [pendingGroupId, setPendingGroupId] = useState<string | null>(null);
  const [membershipAuditWarning, setMembershipAuditWarning] = useState<string | null>(null);
  const [resetHandoff, setResetHandoff] = useState<{
    value: string;
    temporaryPassword: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const resetPanelState = useCallback(() => {
    setDisableMode(false);
    setDisableReason("");
    setDeleteMode(false);
    setActionError(null);
    setMembershipAuditWarning(null);
    setResetHandoff(null);
    setCopied(false);
  }, []);

  if (!user && !loading && !error) {
    return (
      <p className="text-sm text-foreground-muted">
        Select a user to view details and administration actions.
      </p>
    );
  }

  if (loading) {
    return <p className="text-sm text-foreground-muted">Loading user…</p>;
  }

  if (error) {
    return <p className="text-sm text-error">{error}</p>;
  }

  if (!user) return null;

  const federated = isFederatedUser(user);
  const isDisabled = user.disabledAt != null;
  const federatedTooltip = FEDERATED_ACTIONS_TOOLTIP;

  const orderedGroups = orderedCanonicalGroups(canonicalGroups);
  const superuserGroup = canonicalGroups.find((group) => group.type === "superusers");
  const uncontainedHostCommandsGroup = canonicalGroups.find(
    (group) => group.type === UNCONTAINED_HOST_COMMANDS_GRANTEE_GROUP_TYPE,
  );
  const highestRole = pickHighestRoleSlug(user.groups);
  const roleMembershipCount = orderedGroups.filter((group) => isUserInGroup(user, group)).length;
  const directMacRoleEligible = highestRole === "owner" ||
    highestRole === "admin" || highestRole === "superuser";
  const hasDirectMacGrant = uncontainedHostCommandsGroup != null &&
    isUserInGroup(user, uncontainedHostCommandsGroup);

  // Last-owner UI guard (advisory; server enforces with a 409). Disabling or
  // removing the only owner must be blocked — including disabling yourself.
  const userIsOwner = user.groups.some((g) => g.type === "owners");
  const isLastOwner = userIsOwner && ownersCount <= 1;
  const deleteConfirmTarget = user.handle ?? user.displayName;

  const runDisable = async () => {
    setActionLoading("disable");
    setActionError(null);
    try {
      await apiClient.admin.users.disable(
        user.id,
        disableReason.trim() || undefined,
      );
      resetPanelState();
      onUserUpdated();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setActionError(LAST_OWNER_DISABLE_MESSAGE);
      } else {
        setActionError(
          e instanceof Error ? e.message : "Could not disable user.",
        );
      }
    } finally {
      setActionLoading(null);
    }
  };

  const runEnable = async () => {
    setActionLoading("enable");
    setActionError(null);
    try {
      await apiClient.admin.users.enable(user.id);
      resetPanelState();
      onUserUpdated();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not enable user.");
    } finally {
      setActionLoading(null);
    }
  };

  const runResetPassword = async () => {
    setActionLoading("reset");
    setActionError(null);
    setResetHandoff(null);
    try {
      const res = await apiClient.admin.users.resetPassword(user.id);
      setResetHandoff({
        value: res.delivery === "one_time_url" ? res.url : res.temporaryPassword,
        temporaryPassword: res.delivery === "temporary_password",
      });
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "Could not issue password reset.",
      );
    } finally {
      setActionLoading(null);
    }
  };

  const toggleGroupMembership = async (group: GroupRow, isMember: boolean) => {
    if (isMember && group.type === "owners" && user.id === sessionUserId) {
      if (
        !window.confirm(
          "Remove yourself from Owners? You will lose owner-only privileges. The last owner cannot be removed.",
        )
      ) {
        return;
      }
    }
    setPendingGroupId(group.id);
    setActionError(null);
    setMembershipAuditWarning(null);
    try {
      let result: { ok: boolean; auditRecorded?: boolean | undefined };
      if (isMember) {
        result = await apiClient.groups.removeGroupMember(group.id, user.id);
      } else {
        result = await apiClient.groups.addGroupMember(group.id, user.id);
      }
      onUserUpdated();
      if (result.auditRecorded === false) {
        setMembershipAuditWarning("Membership change was applied, but its audit record could not be saved. Do not retry: repeating this change could alter membership again.");
      }
    } catch (e) {
      if (e instanceof LastOwnerError) {
        setActionError(LAST_OWNER_MESSAGE);
      } else {
        setActionError(
          e instanceof Error ? e.message : "Could not update membership.",
        );
      }
    } finally {
      setPendingGroupId(null);
    }
  };

  const runDelete = async () => {
    setActionLoading("delete");
    setActionError(null);
    try {
      await apiClient.admin.users.delete(user.id);
      onUserDeleted();
    } catch (e) {
      if (e instanceof LastOwnerError) {
        setActionError(LAST_OWNER_DELETE_MESSAGE);
      } else {
        setActionError(
          e instanceof Error ? e.message : "Could not delete user.",
        );
      }
    } finally {
      setActionLoading(null);
    }
  };

  const copyResetHandoff = async () => {
    if (!resetHandoff) return;
    try {
      await navigator.clipboard.writeText(resetHandoff.value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div data-testid="user-detail-panel" className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          {formatUserIdentity(user)}
        </h3>
        <p className="mt-0.5 text-sm text-foreground-muted">{user.displayName}</p>
        {federated ? (
          <p
            data-testid="federated-detail-badge"
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-foreground-muted"
          >
            <span className="rounded border border-border bg-background-element px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              Federated
            </span>
            Home server: {user.server}
          </p>
        ) : null}
      </div>

      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-foreground-dim">
            Role
          </dt>
          <dd className="mt-0.5 text-foreground">{userRoleLabel(user)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-foreground-dim">
            Status
          </dt>
          <dd className="mt-0.5 text-foreground">
            {isDisabled ? "Disabled" : "Active"}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-foreground-dim">
            Created
          </dt>
          <dd className="mt-0.5 text-foreground">{formatTimestamp(user.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-foreground-dim">
            Last seen
          </dt>
          <dd className="mt-0.5 text-foreground">
            {formatTimestamp(user.lastSeenAt)}
          </dd>
        </div>
      </dl>

      {isDisabled ? (
        <div className="rounded-md border border-border/60 bg-background-panel/60 px-3 py-2 text-sm">
          <p className="text-foreground-muted">
            Disabled {formatTimestamp(user.disabledAt)}
            {user.disabledBy ? ` by ${user.disabledBy}` : ""}
          </p>
          {user.disabledReason ? (
            <p className="mt-1 text-foreground">Reason: {user.disabledReason}</p>
          ) : null}
        </div>
      ) : null}

      {actionError ? (
        <p className="text-sm text-error" data-testid="user-action-error">
          {actionError}
        </p>
      ) : null}
      {membershipAuditWarning ? (
        <p className="text-sm text-[var(--warning)]" role="alert" data-testid="membership-audit-warning">
          {membershipAuditWarning}
        </p>
      ) : null}

      <details className="group border-t border-border/60 pt-3">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-1 py-2 hover:bg-background-element">
          <span className="text-sm font-semibold text-foreground">Account actions</span>
          <span className="inline-flex items-center gap-2 text-xs text-foreground-muted">Disable or reset password <span aria-hidden="true" className="inline-block text-base transition-transform group-open:rotate-90">›</span></span>
        </summary>
        <div className="mt-3 space-y-3">
        <div className="flex flex-wrap gap-2">
          {isDisabled ? (
            federated ? (
              <DisabledActionButton label="Enable" tooltip={federatedTooltip} />
            ) : (
              <Button
                variant="secondary"
                loading={actionLoading === "enable"}
                disabled={actionLoading != null}
                onClick={() => void runEnable()}
                data-testid="enable-user-button"
              >
                Enable
              </Button>
            )
          ) : disableMode ? null : federated ? (
            <DisabledActionButton label="Disable" tooltip={federatedTooltip} />
          ) : isLastOwner ? (
            <DisabledActionButton
              label="Disable"
              tooltip={LAST_OWNER_DISABLE_MESSAGE}
            />
          ) : (
            <Button
              variant="secondary"
              disabled={actionLoading != null}
              onClick={() => {
                setDisableMode(true);
                setActionError(null);
              }}
              data-testid="disable-user-button"
            >
              Disable
            </Button>
          )}

          {federated ? (
            <DisabledActionButton
              label="Reset password"
              tooltip={federatedTooltip}
            />
          ) : (
            <Button
              variant="secondary"
              loading={actionLoading === "reset"}
              disabled={actionLoading != null || isDisabled}
              onClick={() => void runResetPassword()}
              data-testid="reset-password-button"
            >
              Reset password
            </Button>
          )}
        </div>

        {disableMode && !federated && !isDisabled ? (
          <form
            className="space-y-3 rounded-md border border-border/60 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void runDisable();
            }}
          >
            <FieldRow label="Reason (optional)" htmlFor="disable-reason">
              <TextInput
                id="disable-reason"
                value={disableReason}
                onChange={setDisableReason}
                placeholder="Why is this account being disabled?"
              />
            </FieldRow>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="primary"
                loading={actionLoading === "disable"}
                disabled={actionLoading != null}
                data-testid="confirm-disable-button"
              >
                Confirm disable
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={actionLoading != null}
                onClick={() => {
                  setDisableMode(false);
                  setDisableReason("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}

        {resetHandoff ? (
          <FieldRow
            label={resetHandoff.temporaryPassword ? "Temporary password" : "One-time reset link"}
            htmlFor="reset-handoff"
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <TextInput
                id="reset-handoff"
                value={resetHandoff.value}
                onChange={() => {}}
                readOnly
                ariaLabel={resetHandoff.temporaryPassword ? "Temporary password" : "Password reset URL"}
              />
              <Button variant="secondary" onClick={() => void copyResetHandoff()}>
                {copied ? "Copied!" : resetHandoff.temporaryPassword ? "Copy password" : "Copy link"}
              </Button>
            </div>
            {resetHandoff.temporaryPassword ? (
              <p className="mt-2 text-xs text-foreground-muted">
                The member must change this password after signing in.
              </p>
            ) : null}
          </FieldRow>
        ) : null}
        </div>
      </details>

      <section
        className="space-y-3 rounded-md border border-[var(--warning)]/50 bg-[var(--warning)]/10 p-3"
        aria-labelledby="direct-mac-execution-title"
      >
        <div>
          <h4 id="direct-mac-execution-title" className="text-sm font-semibold text-foreground">
            Direct Mac execution
          </h4>
          <p className="mt-1 text-xs text-foreground-muted">
            Allows this Human to activate uncontained shell commands on their own
            Nautilo Desktop. They must still confirm the warning with their own PIN.
          </p>
        </div>

        <dl className="space-y-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-foreground-muted">Role eligibility</dt>
            <dd className="font-medium">
              {directMacRoleEligible ? `Eligible · ${userRoleLabel(user)}` : `Not eligible · ${userRoleLabel(user)}`}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-foreground-muted">Personal access</dt>
            <dd className="font-medium">{hasDirectMacGrant ? "Granted" : "Not granted"}</dd>
          </div>
        </dl>

        {federated ? (
          <p className="text-xs text-foreground-muted">{federatedTooltip}</p>
        ) : groupsLoading ? (
          <p className="text-xs text-foreground-muted">Loading access controls…</p>
        ) : groupsError ? (
          <p className="text-xs text-error">{groupsError}</p>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--warning)]/40 pt-3">
            {!directMacRoleEligible ? (
              <Button
                variant="secondary"
                disabled={!superuserGroup || pendingGroupId != null || !canManageMembers}
                title={superuserGroup ? "Make this Human a Superuser" : "The Superusers group is unavailable."}
                onClick={() => {
                  if (superuserGroup) void toggleGroupMembership(superuserGroup, false);
                }}
              >
                Make Superuser
              </Button>
            ) : null}
            <Button
              variant={hasDirectMacGrant ? "secondary" : "primary"}
              disabled={
                !directMacRoleEligible ||
                !uncontainedHostCommandsGroup ||
                !canManageMembers ||
                !canManageUncontainedHostCommands ||
                pendingGroupId != null
              }
              title={
                !canManageUncontainedHostCommands
                  ? "Requires manage_uncontained_host_commands."
                  : !directMacRoleEligible
                    ? "Make this Human a Superuser first."
                    : undefined
              }
              onClick={() => {
                if (uncontainedHostCommandsGroup) {
                  void toggleGroupMembership(uncontainedHostCommandsGroup, hasDirectMacGrant);
                }
              }}
            >
              {hasDirectMacGrant ? "Revoke access" : "Grant access"}
            </Button>
          </div>
        )}
      </section>

      <details className="group border-t border-border/60 pt-3">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-1 py-2 hover:bg-background-element">
          <span>
            <span className="block text-sm font-semibold text-foreground">Roles &amp; groups</span>
            <span className="mt-0.5 block text-xs text-foreground-muted">Effective role: {userRoleLabel(user)} · {roleMembershipCount} group{roleMembershipCount === 1 ? "" : "s"}</span>
          </span>
          <span className="inline-flex items-center gap-2 text-xs font-medium text-foreground-muted">
            Manage
            <span aria-hidden="true" className="inline-block text-base transition-transform group-open:rotate-90">›</span>
          </span>
        </summary>
        <div className="mt-3 space-y-3">
        {federated ? (
          <p className="text-sm text-foreground-muted">{federatedTooltip}</p>
        ) : groupsLoading ? (
          <p className="text-sm text-foreground-muted">Loading role groups…</p>
        ) : groupsError ? (
          <p className="text-sm text-error">{groupsError}</p>
        ) : orderedGroups.length === 0 ? (
          <p className="text-sm text-foreground-muted">No server groups found.</p>
        ) : (
          <>
            <p className="text-xs text-foreground-muted">
              These are independent memberships, not one role choice. Changes apply
              immediately; the highest membership becomes the effective role.
            </p>
            <ul role="group" aria-label="Group membership" className="space-y-1.5">
              {orderedGroups.map((group) => {
                const member = isUserInGroup(user, group);
                const isOwnersRow = group.type === "owners";
                // Owners membership is an owner-only privilege; everything else
                // rides on manage_members. The server enforces both; this mirrors.
                const permitted = isOwnersRow ? isOwner : canManageMembers;
                const communityEnrollmentUnavailable = !member && isCommunityEnrollmentTarget(group);
                const disabled = !permitted || pendingGroupId != null || communityEnrollmentUnavailable;
                const tooltip = communityEnrollmentUnavailable
                  ? "Community enrollment is unavailable until personal-key chat launches."
                  : !permitted
                  ? isOwnersRow
                    ? TRANSFER_OWNER_TOOLTIP
                    : "Requires manage_members."
                  : undefined;
                return (
                  <li
                    key={group.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="text-sm font-medium text-foreground">
                        {group.label}
                      </span>
                      <span className="ml-2 text-xs text-foreground-muted">
                        {groupRoleSlug(group)}
                      </span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-2">
                      <span className="text-xs text-foreground-muted">
                        {member ? "Member" : "Not a member"}
                      </span>
                      <button
                        type="button"
                        data-testid={`group-toggle-${group.type}`}
                        aria-pressed={member}
                        aria-label={`${member ? "Remove from" : "Add to"} ${group.label}`}
                        disabled={disabled}
                        title={tooltip}
                        onClick={() => void toggleGroupMembership(group, member)}
                        className="min-w-16 rounded-md border border-border bg-background-element px-2.5 py-1 text-xs font-medium text-foreground hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {pendingGroupId === group.id ? "Updating…" : member ? "Remove" : "Add"}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
            {pendingGroupId ? (
              <p className="text-xs text-foreground-muted">Updating membership…</p>
            ) : null}
          </>
        )}
        </div>
      </details>

      {!federated ? (
        <details className="group border-t border-border/60 pt-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-1 py-2 hover:bg-error/10">
            <span className="text-sm font-semibold text-error">Danger zone</span>
            <span className="inline-flex items-center gap-2 text-xs text-foreground-muted">Delete account <span aria-hidden="true" className="inline-block text-base transition-transform group-open:rotate-90">›</span></span>
          </summary>
          <div className="mt-3 space-y-3 rounded-md border border-error/50 bg-error/10 p-3">
            <p className="mt-1 text-xs text-foreground-muted">
              Permanently delete this account and the agents, rooms, and
              sessions it owns. This cannot be undone.
            </p>
          {isLastOwner ? (
            <DisabledActionButton
              label="Delete account"
              tooltip={LAST_OWNER_DELETE_MESSAGE}
            />
          ) : deleteMode ? (
            <div className="space-y-3">
              <p className="text-sm text-foreground">
                Permanently delete{" "}
                <span className="font-semibold">{deleteConfirmTarget}</span> and
                everything they own? This cannot be undone.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="confirm-delete-button"
                  disabled={actionLoading != null}
                  onClick={() => void runDelete()}
                  className="rounded-md border border-error bg-error/10 px-3 py-1.5 text-sm font-medium text-error hover:bg-error/20 disabled:opacity-50"
                >
                  {actionLoading === "delete"
                    ? "Deleting…"
                    : "Yes, permanently delete"}
                </button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={actionLoading != null}
                  onClick={() => setDeleteMode(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-testid="delete-user-button"
              disabled={actionLoading != null}
              onClick={() => {
                setDeleteMode(true);
                setActionError(null);
              }}
              className="rounded-md border border-error px-3 py-1.5 text-sm font-medium text-error hover:bg-error/10 disabled:opacity-50"
            >
              Delete account
            </button>
          )}
          </div>
        </details>
      ) : null}
    </div>
  );
}
