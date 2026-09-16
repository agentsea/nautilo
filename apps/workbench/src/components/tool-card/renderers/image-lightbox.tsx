/**
 * Shared thumbnail + lightbox for workspace images (tool cards).
 * Loads via `useWorkspaceImage`; UI is live-verified in Electron.
 */

import { useEffect } from "react";
import { createWorkbenchPortal as createPortal } from "../../workbench-portals";
import type { ReactElement } from "react";
import { useWorkspaceImage, type UseWorkspaceImageArgs } from "./use-workspace-image";

export type LightboxImageRef =
  | { kind: "fs"; absolutePath: string; mime: string }
  | { kind: "artifact"; id: string; mime: string; roomId?: string };

function workspaceImageArgs(image: LightboxImageRef): UseWorkspaceImageArgs {
  if (image.kind === "artifact") {
    return {
      kind: "artifact",
      id: image.id,
      mime: image.mime,
      ...(image.roomId !== undefined ? { roomId: image.roomId } : {}),
    };
  }
  return { kind: "fs", absolutePath: image.absolutePath, mime: image.mime };
}

export function Thumbnail(props: {
  image: LightboxImageRef;
  onOpen: () => void;
  size: "small" | "large";
  ariaLabel?: string;
}): ReactElement {
  const { image, onOpen, size, ariaLabel } = props;
  const load = useWorkspaceImage(workspaceImageArgs(image));
  const sizeClass = size === "small" ? "h-16 w-16" : "h-full w-full";
  if (load.kind === "loading") {
    return (
      <div
        className={`${sizeClass} animate-pulse rounded bg-background-element/50`}
        aria-label="loading image"
      />
    );
  }
  if (load.kind === "error") {
    return (
      <div
        className={`${sizeClass} flex items-center justify-center rounded bg-background-element/30 text-tool-error`}
        title={load.message}
        aria-label={`image failed to load: ${load.message}`}
      >
        ⚠
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`${sizeClass} overflow-hidden rounded border border-border bg-background-element transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-accent`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      aria-label={ariaLabel ?? "open image"}
    >
      <img src={load.dataUrl} alt="" className="h-full w-full object-contain" />
    </button>
  );
}

function LightboxImage({ image }: { image: LightboxImageRef }) {
  const load = useWorkspaceImage(workspaceImageArgs(image));
  if (load.kind === "loading") return <div className="h-32 w-32 animate-pulse rounded bg-white/10" />;
  if (load.kind === "error") return <div className="text-tool-error">⚠ {load.message}</div>;
  return <img src={load.dataUrl} alt="" className="max-h-[90vh] max-w-[90vw] object-contain" />;
}

export function ImageLightbox(props: {
  images: LightboxImageRef[];
  index: number;
  onClose: () => void;
  onStep: (delta: number) => void;
}): ReactElement | null {
  const { images, index, onClose, onStep } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onStep(-1);
      else if (e.key === "ArrowRight") onStep(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onStep]);

  const img = images[index];
  if (!img) return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="image viewer"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
      onClick={onClose}
    >
      <button
        type="button"
        aria-label="close"
        className="absolute right-4 top-4 text-2xl text-white/80 hover:text-white"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        ×
      </button>
      <div className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
        <LightboxImage image={img} />
      </div>
      {images.length > 1 && (
        <>
          <button
            type="button"
            aria-label="previous"
            onClick={(e) => {
              e.stopPropagation();
              onStep(-1);
            }}
            className="absolute left-4 text-3xl text-white/80 hover:text-white"
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="next"
            onClick={(e) => {
              e.stopPropagation();
              onStep(1);
            }}
            className="absolute right-4 text-3xl text-white/80 hover:text-white"
          >
            ›
          </button>
          <div className="absolute bottom-4 text-xs text-white/70">
            {index + 1} / {images.length}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}
