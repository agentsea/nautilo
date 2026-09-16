/**
 * D207 — minimal avatar uploader for Settings → Profile.
 *
 * UX: file picker → in-memory preview → Save button → multipart POST to
 * `/api/profile/avatar`. Server validates mime/size/dimensions, strips
 * EXIF, and re-encodes to a 256×256 PNG via `sharp.resize(fit:'cover')`,
 * so we don't ship a crop modal — center-crop is the right MVP for
 * profile pictures and the server is the canonical truncation point.
 *
 * Client-side gates mirror the server gates (mime whitelist, 5 MB cap)
 * to fail fast and give a useful error before round-tripping a doomed
 * upload. The actual security boundary is server-side.
 *
 * On success, fires `nautilo:profile-changed` so the rest of the
 * workbench (assistant identity strip, account-menu avatar,
 * `<UserAvatar>`s anywhere) refresh.
 */

import { useRef, useState, type ChangeEvent, type ReactElement } from "react";
import { useAuth } from "../../hooks/use-auth";
import { workbenchFetch } from "../../lib/admission-fetch";
import { UserAvatar } from "./UserAvatar";

const ACCEPTED = "image/png,image/jpeg,image/webp";
const MAX_BYTES = 5 * 1024 * 1024;

export interface AvatarUploaderProps {
  onSaved?: () => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export function AvatarUploader({ onSaved }: AvatarUploaderProps): ReactElement {
  const auth = useAuth();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function clearPick() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPickedFile(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const lower = f.type.toLowerCase();
    if (!ACCEPTED.split(",").includes(lower)) {
      setStatus({
        kind: "error",
        message: "Image must be PNG, JPEG, or WebP.",
      });
      clearPick();
      return;
    }
    if (f.size > MAX_BYTES) {
      setStatus({ kind: "error", message: "Image must be ≤ 5 MB." });
      clearPick();
      return;
    }
    setStatus({ kind: "idle" });
    setPickedFile(f);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(f));
  }

  async function onSave() {
    if (!pickedFile) return;
    setStatus({ kind: "uploading" });
    try {
      const token = await auth.session?.getAccessToken();
      if (!token) throw new Error("Not signed in.");
      const fd = new FormData();
      fd.append("file", pickedFile);
      const res = await workbenchFetch("/api/profile/avatar", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) {
        let message = `Upload failed (${res.status}).`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = humanizeServerError(body.error);
        } catch {
          /* fall through with default message */
        }
        throw new Error(message);
      }
      setStatus({ kind: "saved" });
      window.dispatchEvent(new Event("nautilo:profile-changed"));
      window.dispatchEvent(
        new CustomEvent("nautilo:user-avatar-changed", {
          detail: { userId: auth.viewer.sessionUserId ?? undefined },
        }),
      );
      clearPick();
      onSaved?.();
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Upload failed.",
      });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        className="hidden"
        onChange={onPick}
      />
      <div className="flex items-center gap-3">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt="Preview"
            className="h-16 w-16 rounded-full border border-border object-cover"
          />
        ) : auth.viewer.sessionUserId ? (
          <UserAvatar
            userId={auth.viewer.sessionUserId}
            size={64}
            displayName={auth.viewer.label}
          />
        ) : null}
        <button
          type="button"
          className="rounded-md border border-border bg-background-element px-3 py-1.5 text-sm font-medium text-foreground hover:bg-[var(--primary-muted)]"
          onClick={() => inputRef.current?.click()}
        >
          {pickedFile ? "Choose a different image" : "Change image…"}
        </button>
        {pickedFile ? (
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)] disabled:opacity-50"
            disabled={status.kind === "uploading"}
            onClick={() => void onSave()}
          >
            {status.kind === "uploading" ? "Uploading…" : "Save"}
          </button>
        ) : null}
        {pickedFile ? (
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground-muted hover:text-foreground"
            onClick={clearPick}
            disabled={status.kind === "uploading"}
          >
            Cancel
          </button>
        ) : null}
      </div>
      <p className="text-xs text-foreground-muted">
        PNG, JPEG, or WebP. Max 5 MB. Image is auto-cropped to a square and
        re-encoded to a 256×256 PNG on the server (EXIF stripped).
      </p>
      {status.kind === "saved" ? (
        <p className="text-xs text-[var(--success)]">Saved.</p>
      ) : null}
      {status.kind === "error" ? (
        <p className="text-xs text-[var(--error)]">{status.message}</p>
      ) : null}
    </div>
  );
}

function humanizeServerError(code: string): string {
  switch (code) {
    case "no file":
      return "Please choose an image first.";
    case "unsupported_mime":
      return "Image must be PNG, JPEG, or WebP.";
    case "too_large":
      return "Image is too large (5 MB max).";
    case "decode_failed":
      return "Couldn't read that image. Try a different file.";
    case "dimensions_too_large":
      return "Image is way too large (over 8192 × 8192). Resize before uploading.";
    default:
      return code;
  }
}
