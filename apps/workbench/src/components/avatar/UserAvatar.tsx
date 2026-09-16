/**
 * D206 — small reusable avatar component for any user known by id.
 *
 * Hits `GET /api/users/:userId/avatar` (server-side route mirrors the
 * existing `/api/profile/avatar` privacy contract: callers see the
 * target's real avatar only when the target has `publicProfile=true`,
 * otherwise SHELL). When the server returns SHELL and we know the
 * target's display name, we render a colored-initials circle instead
 * for better visual distinction in long multi-author transcripts.
 *
 * Module-level blob URL cache keyed on `userId` avoids refetching for
 * the same user across many message rows in the same room. Cache is
 * intentionally process-local — it dies on page reload, which is fine
 * for now: the server serves peer avatars with `Cache-Control:
 * private, no-cache` + ETag (D243), so a cold reload revalidates
 * cheaply (304, empty body) rather than re-downloading the blob.
 *
 * Used by `Conversation.Message` (Slack-shape) for multi-human room
 * rendering and (later) by anywhere else that needs a peer avatar.
 */

import { type ReactElement } from "react";
import { useAuthenticatedImage } from "./authenticated-image";

export interface UserAvatarProps {
  userId: string;
  size?: number;
  /** Used for the initials fallback when the server returns SHELL. */
  displayName?: string | undefined;
}

export function UserAvatar({
  userId,
  size = 24,
  displayName,
}: UserAvatarProps): ReactElement {
  const { objectUrl: src, isShell } = useAuthenticatedImage(
    `/api/users/${encodeURIComponent(userId)}/avatar`,
  );

  // Initials fallback for SHELL-or-failed cases when we have a name.
  if (isShell || !src) {
    const label = (displayName ?? "").trim();
    const initials =
      label.length > 0
        ? label
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0])
            .join("")
            .toUpperCase()
        : "?";
    const bg = colorFromUserId(userId);
    return (
      <span
        aria-hidden={false}
        aria-label={label || `User ${userId.slice(0, 8)}`}
        className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
        style={{
          width: size,
          height: size,
          background: bg,
          fontSize: Math.round(size * 0.45),
          lineHeight: `${size}px`,
        }}
      >
        {initials}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={displayName ?? ""}
      width={size}
      height={size}
      className="shrink-0 rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * Deterministic color from userId — gives each peer a stable hue across
 * sessions even before they upload an avatar. Cheap, no library needed.
 */
function colorFromUserId(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) & 0xffffffff;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 55% 45%)`;
}
