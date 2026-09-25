import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerProfile } from "@nautilo/api-client/browser";
import { apiClient } from "../../../lib/api";
import { usePosture } from "../../../contexts/posture-context";
import { useAuth } from "../../../hooks/use-auth";
import { useCan } from "../../../hooks/use-can";
import { ServerIcon } from "../../../components/server/server-icon";
import { formatLevel } from "../../../components/security/posture-colors";
import { Button } from "../../settings/ui";
import { ServerProviderPolicyCard } from "./server-provider-policy-card";

type DescriptionVisibility = "public" | "members";
function defaultDescriptionVisibility(profile: ServerProfile | undefined): DescriptionVisibility {
  return profile?.descriptionVisibility === "members" ? "members" : "public";
}

export function ServerSection() {
  const { viewer } = useAuth();
  const can = useCan();
  const canManage = can("manage_server_operations");
  const { posture, loading: postureLoading, error: postureError } = usePosture();
  const [profile, setProfile] = useState<ServerProfile | undefined>();
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editSession, setEditSession] = useState(0);
  const [draftDescriptionVisibility, setDraftDescriptionVisibility] =
    useState<DescriptionVisibility>("public");
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [iconUploading, setIconUploading] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null);

  const loadProfile = useCallback(async () => {
    setProfileLoading(true);
    setProfileError(null);
    try {
      const next = await apiClient.getServerProfile();
      setProfile(next);
      return next;
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadProfile().then((next) => {
      if (cancelled || !next) return;
    });
    return () => {
      cancelled = true;
    };
  }, [loadProfile]);

  const beginEdit = () => {
    setDraftDescriptionVisibility(defaultDescriptionVisibility(profile));
    setSaveError(null);
    setSaveSuccess(null);
    setEditSession((session) => session + 1);
    setIsEditing(true);
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setSaveError(null);
  };

  const handleIconUpload = async (file: File) => {
    setIconUploading(true);
    setIconError(null);
    setSaveSuccess(null);
    try {
      const updated = await apiClient.uploadServerIcon(file);
      setProfile(updated);
      setSaveSuccess("Server icon updated.");
    } catch (err) {
      setIconError(err instanceof Error ? err.message : String(err));
    } finally {
      setIconUploading(false);
    }
  };

  const handleSave = async () => {
    setSaveLoading(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const draftName = nameInputRef.current?.value ?? "";
      const draftDescription = descriptionInputRef.current?.value ?? "";

      const patch: {
        name?: string;
        description?: string | null;
        descriptionVisibility?: DescriptionVisibility;
        reviewed: true;
      } = { reviewed: true };

      const trimmedName = draftName.trim();
      if (trimmedName !== (profile?.name ?? "")) {
        patch.name = trimmedName.length > 0 ? trimmedName : profile?.name ?? "Server";
      }

      const normalizedDescription = draftDescription.trim();
      const currentDescription = profile?.description ?? null;
      const nextDescription = normalizedDescription.length > 0 ? normalizedDescription : null;
      if (nextDescription !== currentDescription) {
        patch.description = nextDescription;
      }

      const currentVisibility = defaultDescriptionVisibility(profile);
      if (draftDescriptionVisibility !== currentVisibility) {
        patch.descriptionVisibility = draftDescriptionVisibility;
      }

      const updated = await apiClient.updateServerProfile(patch);
      setProfile(updated);
      setIsEditing(false);
      setSaveSuccess("Server profile reviewed and saved.");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaveLoading(false);
    }
  };

  const displayName = profile?.name ?? "Server";
  const descriptionVisibility = defaultDescriptionVisibility(profile);

  return (
    <section
      id="server"
      data-testid="admin-server-section"
      className="rounded-lg border border-border bg-background-panel"
      aria-labelledby="server-title"
    >
      <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-3">
        <div>
          <h2 id="server-title" className="text-sm font-semibold">
            Server
          </h2>
          <p className="mt-1 text-xs text-foreground-muted">
            Server identity and routine operational policy. Credentials, security,
            ownership, and access delegation are managed separately.
          </p>
        </div>
        {canManage && !isEditing ? (
          <button
            type="button"
            data-testid="server-edit-button"
            onClick={beginEdit}
            className="shrink-0 rounded-md border border-border bg-background-element px-3 py-1.5 text-sm font-medium text-foreground hover:bg-background-panel"
          >
            Edit
          </button>
        ) : null}
      </header>

      <div className="px-5 py-4">
        {profileLoading ? (
          <p className="text-sm text-foreground-muted">Loading server profile…</p>
        ) : profileError ? (
          <p className="text-sm text-error">{profileError}</p>
        ) : isEditing ? (
          <form
            key={editSession}
            className="space-y-4"
            data-testid="server-edit-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            <div>
              <label htmlFor="server-name" className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted">
                Name
              </label>
              <input
                id="server-name"
                ref={nameInputRef}
                name="name"
                data-testid="server-name-input"
                type="text"
                defaultValue={profile?.name ?? ""}
                className="mt-1 w-full rounded-md border border-border bg-background-element px-3 py-2 text-sm text-foreground"
              />
            </div>

            <div>
              <label
                htmlFor="server-description"
                className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted"
              >
                Description
              </label>
              <textarea
                id="server-description"
                ref={descriptionInputRef}
                name="description"
                data-testid="server-description-input"
                defaultValue={profile?.description ?? ""}
                rows={3}
                className="mt-1 w-full rounded-md border border-border bg-background-element px-3 py-2 text-sm text-foreground"
              />
            </div>

            <div>
              <span className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted">
                Description visibility
              </span>
              <button
                type="button"
                data-testid="server-description-visibility-toggle"
                aria-pressed={draftDescriptionVisibility === "public"}
                onClick={() =>
                  setDraftDescriptionVisibility((current) =>
                    current === "public" ? "members" : "public",
                  )
                }
                className={[
                  "mt-1 w-full rounded-lg border p-3 text-left text-sm transition-colors",
                  draftDescriptionVisibility === "public"
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-background-panel/40 text-foreground-muted hover:bg-background-element/70",
                ].join(" ")}
              >
                <span className="block font-medium">
                  {draftDescriptionVisibility === "public"
                    ? "Show description to non-members"
                    : "Members only"}
                </span>
                <span className="mt-1 block text-xs font-normal text-foreground-muted">
                  {draftDescriptionVisibility === "public"
                    ? "Anyone can read the description before signing in."
                    : "Only signed-in members see the description."}
                </span>
              </button>
            </div>

            <div>
              <span className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted">
                Icon
              </span>
              <div className="mt-2 flex items-center gap-3">
                <ServerIcon
                  icon={profile?.icon}
                  size={48}
                  fallbackInitial={displayName}
                />
                <p className="text-xs text-foreground-muted">
                  {profile?.icon
                    ? profile.icon.kind === "preset"
                      ? `Preset: ${profile.icon.id}`
                      : "Custom upload"
                    : "Default brand icon"}
                </p>
              </div>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                data-testid="server-icon-input"
                disabled={iconUploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleIconUpload(file);
                  event.target.value = "";
                }}
                className="mt-2 block w-full text-sm text-foreground-muted file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-background-element file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-background-panel disabled:opacity-50"
              />
              {iconUploading ? (
                <p className="mt-1 text-xs text-foreground-muted">Uploading icon…</p>
              ) : null}
              {iconError ? <p className="mt-1 text-sm text-error">{iconError}</p> : null}
              {saveSuccess && isEditing ? (
                <p className="mt-1 text-xs text-foreground-muted" data-testid="server-icon-success">
                  {saveSuccess}
                </p>
              ) : null}
            </div>

            {saveError ? <p className="text-sm text-error">{saveError}</p> : null}

            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="primary"
                loading={saveLoading}
                disabled={saveLoading}
                data-testid="server-save-button"
              >
                Save
              </Button>
              <button
                type="button"
                data-testid="server-cancel-button"
                disabled={saveLoading}
                onClick={cancelEdit}
                className="rounded-md border border-border bg-background-element px-3 py-1.5 text-sm font-medium text-foreground disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="flex items-start gap-4">
            <ServerIcon
              icon={profile?.icon}
              size={48}
              fallbackInitial={displayName}
            />
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-semibold tracking-tight">{displayName}</h3>
              <p className="mt-0.5 text-sm text-foreground-muted">
                Role: {viewer.role}
              </p>
              {profile?.description ? (
                <p className="mt-2 text-sm text-foreground">{profile.description}</p>
              ) : null}
              <p className="mt-2 text-xs text-foreground-muted">
                Description visibility:{" "}
                {descriptionVisibility === "public" ? "public" : "members only"}
              </p>
            </div>
          </div>
        )}

        {saveSuccess && !isEditing ? (
          <p className="mt-3 text-sm text-foreground-muted" data-testid="server-save-success">
            {saveSuccess}
          </p>
        ) : null}

        <div className="mt-4 border-t border-border/60 pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            Posture
          </h3>
          {postureLoading && posture === null ? (
            <p className="mt-2 text-sm text-foreground-muted">Loading posture…</p>
          ) : postureError && posture === null ? (
            <p className="mt-2 text-sm text-error">{postureError}</p>
          ) : posture ? (
            <p className="mt-2 text-sm text-foreground">
              {formatLevel(posture.securityLevel)} · {posture.deploymentMode} ·{" "}
              {posture.backend.kind}
            </p>
          ) : (
            <p className="mt-2 text-sm text-foreground-muted">Posture unavailable.</p>
          )}
        </div>

        <ServerProviderPolicyCard />

      </div>
    </section>
  );
}
