import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import videojs from "video.js";
import "video.js/dist/video-js.css";

export type ExplainerVideoPlayerProps = {
  /** An authenticated MP4 Blob URL resolved by the caller. */
  src: string;
  title: string;
  poster?: string;
  onPlaybackError?: () => void;
};

type VideoJsPlayerOptions = {
  autoplay: false;
  controls: true;
  controlBar: {
    fullscreenToggle: true;
  };
  fluid: true;
  poster?: string;
  sources: Array<{
    src: string;
    type: string;
  }>;
};

/**
 * Video.js wrapper for authenticated MP4 explainer playback cards.
 *
 * The caller owns Blob URL creation and revocation; this component never
 * constructs a network URL.
 */
export function ExplainerVideoPlayer({
  src,
  title,
  poster,
  onPlaybackError,
}: ExplainerVideoPlayerProps): ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);
  const titleId = useId();
  const [initializationError, setInitializationError] = useState(false);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    setInitializationError(false);
    const options: VideoJsPlayerOptions = {
      autoplay: false,
      controls: true,
      controlBar: { fullscreenToggle: true },
      fluid: true,
      poster,
      sources: [{ src, type: "video/mp4" }],
    };

    try {
      const player = videojs(videoElement, options);
      player.on("error", () => {
        if (onPlaybackError) {
          onPlaybackError();
        } else {
          setInitializationError(true);
        }
      });

      return () => {
        player.dispose();
      };
    } catch {
      if (onPlaybackError) {
        onPlaybackError();
      } else {
        setInitializationError(true);
      }
    }
  }, [onPlaybackError, poster, src]);

  if (initializationError) {
    return (
      <section aria-labelledby={titleId} className="rounded border border-border p-3">
        <h3 id={titleId} className="text-xs font-medium text-foreground">
          {title}
        </h3>
        <p role="alert" className="mt-1 text-xs text-tool-error">
          Video playback is unavailable.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={titleId}
      className="space-y-1"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <h3 id={titleId} className="text-xs font-medium text-foreground">
        {title}
      </h3>
      <video
        ref={videoRef}
        className="video-js vjs-big-play-centered"
        controls
        playsInline
        preload="metadata"
        aria-labelledby={titleId}
        data-testid="explainer-video-player"
      />
    </section>
  );
}
