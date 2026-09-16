import { useEffect, useState } from "react";
import type { AvatarRef } from "@nautilo/types";

const SERVER_ICON_URL = "/api/server/icon";

function iconCacheKey(icon: AvatarRef | undefined): string {
  if (!icon) return "default";
  if (icon.kind === "preset") return `preset:${icon.id}`;
  return `${icon.kind}:${icon.blobId}`;
}

export interface ServerIconProps {
  icon: AvatarRef | undefined;
  /** Absolute icon URL returned by the desktop server session registry. */
  imageUrl?: string;
  size?: number;
  /** Shown when the image is loading or unavailable. */
  fallbackInitial: string;
  className?: string;
  /** Removes the default Admin/profile frame for compact rail artwork. */
  framed?: boolean;
}

/**
 * D280 — renders the server brand icon from the public
 * `GET /api/server/icon` route. Cache-busts on icon ref changes so uploads
 * show immediately despite the route's public max-age headers.
 */
export function ServerIcon({
  icon,
  imageUrl,
  size = 48,
  fallbackInitial,
  className,
  framed = true,
}: ServerIconProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const cacheKey = iconCacheKey(icon);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setSrc(null);
    setFailed(false);

    if (imageUrl) {
      setSrc(imageUrl);
      return;
    }

    void (async () => {
      try {
        const res = await fetch(
          `${SERVER_ICON_URL}?v=${encodeURIComponent(cacheKey)}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          if (!cancelled) setFailed(true);
          return;
        }
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setSrc(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [cacheKey, imageUrl]);

  const boxClass = [
    "flex shrink-0 items-center justify-center overflow-hidden",
    framed && "rounded-lg border border-border bg-background-element",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        data-testid="server-icon-image"
        className={`${boxClass} object-cover`}
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    );
  }

  const initial = fallbackInitial.trim().charAt(0).toUpperCase() || "S";
  return (
    <div
      aria-hidden="true"
      data-testid="server-icon-fallback"
      className={`${boxClass} font-semibold text-foreground`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initial}
    </div>
  );
}
