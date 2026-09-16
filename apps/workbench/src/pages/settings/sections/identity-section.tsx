import { AvatarUploader } from "../../../components/avatar/AvatarUploader";
import { useAuth } from "../../../hooks/use-auth";
import { useProfile } from "../../../hooks/use-profile";
import { FieldRow, GuestPlaceholder, TextInput } from "../ui";

/**
 * Settings → Profile → Your identity.
 * Mutates the signed-in Human (`users.name` display, `users.handle`, `users.human_avatar_ref`).
 */
export function IdentitySection() {
  const auth = useAuth();
  const { refresh } = useProfile();
  const viewer = auth.viewer;

  return (
    <div
      data-testid="identity-section"
      className="rounded-lg border border-border bg-background-panel"
    >
      <header className="border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold">Your identity</h2>
        <p className="mt-1 text-xs text-foreground-muted">
          This changes how YOU appear to others — your Human name, handle, and portrait.
        </p>
      </header>
      <div className="px-5 py-4">
        {!viewer.isVerified ? (
          <GuestPlaceholder what="Your identity" />
        ) : viewer.staleWhoami && !viewer.displayName && !viewer.handle ? (
          <p className="text-sm text-foreground-muted">Loading…</p>
        ) : (
          <>
            <FieldRow
              label="Display name"
              hint="Your Human name on this Server. Read-only here."
              htmlFor="settings-human-display-name"
            >
              <TextInput
                id="settings-human-display-name"
                value={viewer.displayName ?? viewer.label ?? ""}
                onChange={() => {}}
                readOnly
                ariaLabel="Human display name"
              />
            </FieldRow>
            <FieldRow
              label="Handle"
              hint="Your @handle on this Server. Read-only here."
              htmlFor="settings-human-handle"
            >
              <TextInput
                id="settings-human-handle"
                value={viewer.handle ? `@${viewer.handle}` : ""}
                onChange={() => {}}
                readOnly
                ariaLabel="Human handle"
              />
            </FieldRow>
            <FieldRow
              label="Portrait"
              hint="Uploads to your Human profile — shown next to your messages in shared rooms."
            >
              <AvatarUploader
                onSaved={() => {
                  void refresh();
                }}
              />
            </FieldRow>
          </>
        )}
      </div>
    </div>
  );
}
