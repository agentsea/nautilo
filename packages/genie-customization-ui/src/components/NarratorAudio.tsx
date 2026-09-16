/**
 * D091 Phase 2 — per-screen narrator audio.
 *
 * Plays the screen-keyed MP3 from the server's audio route at
 * `${serverUrl}/api/onboarding/audio/<lang>/<manifestKey>`. The
 * server serves these via @fastify/static rooted at
 * packages/server/src/onboarding/audio/.
 *
 * Optional chaining (`chainAfter`): retained for compatibility with
 * the legacy manifest shape, though the current Genie wizard skips
 * the old English/Spanish language-pick screen.
 *
 * Behaviour:
 *   - One MP3 at a time. Switching screens stops the prior
 *     screen's audio mid-playback if it's still going.
 *   - On `ended`, if `chainAfter` is set, switch to the chain
 *     track. Chain plays once; no chain-of-chains.
 *   - Missing files (404) are silent — log to console, don't
 *     throw. The Spanish track set may be incomplete in places;
 *     English is the authoritative set.
 *   - Audio is fetched lazily per screen (no pre-loading the
 *     full manifest). Browser caches per URL.
 */

import React, { useEffect, useRef } from "react";
import type { Language } from "../types";

interface ChainTarget {
  /** Language directory (e.g. "es" for the Spanish half of the
   *  language-pick chain). May differ from the screen's current
   *  state.language because the chain is cross-language. */
  language: Language;
  /** Manifest filename relative to `<lang>/` directory. */
  manifestKey: string;
}

interface NarratorAudioProps {
  /** Manifest key from the legacy audio set. Null skips playback
   *  entirely (useful for screens with no narrator like Welcome). */
  manifestKey: string | null;
  /** Active wizard language. Determines URL path: `<lang>/...`. */
  language: Language;
  /** Resolved server URL supplied by the injected API.
   *  Null = not yet resolved → component skips playback this render. */
  serverUrl: string | null;
  /** Optional follow-up track played after `manifestKey` finishes. */
  chainAfter?: ChainTarget;
  /** Auto-play on mount + on key changes. Default true. */
  autoPlay?: boolean;
}

export function NarratorAudio({
  manifestKey,
  language,
  serverUrl,
  chainAfter,
  autoPlay = true,
}: NarratorAudioProps): React.ReactElement | null {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Switching keys / languages stops any in-flight playback so two
  // narrator clips never overlap (a real bug observed in the
  // legacy wizard's earliest commits).
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = 0;
    if (manifestKey && serverUrl && autoPlay) {
      el.play().catch((err: unknown) => {
        console.warn("[onboarding] narrator playback failed:", err);
      });
    }
  }, [manifestKey, language, serverUrl, autoPlay]);

  // Chain handler: when the primary track ends, if `chainAfter` is
  // set, swap the src to the chain target and play once. Cleared
  // whenever `chainAfter` or `manifestKey` changes so a stale
  // listener can't fire after the user navigates away.
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !chainAfter || !serverUrl) return undefined;
    let chainPlayed = false;
    const onEnded = () => {
      if (chainPlayed) return;
      chainPlayed = true;
      const chainSrc = `${serverUrl}/api/onboarding/audio/${chainAfter.language}/${chainAfter.manifestKey}`;
      el.src = chainSrc;
      el.currentTime = 0;
      el.play().catch((err: unknown) => {
        console.warn(
          `[onboarding] chain narrator playback failed (${chainSrc}):`,
          err,
        );
      });
    };
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("ended", onEnded);
    };
  }, [chainAfter, serverUrl, manifestKey]);

  if (!manifestKey || !serverUrl) return null;

  const src = `${serverUrl}/api/onboarding/audio/${language}/${manifestKey}`;
  return (
    <audio
      ref={audioRef}
      src={src}
      preload="auto"
      style={{ display: "none" }}
      onError={() => {
        // 404s end up here. Silent fallback per Phase 2 spec.
        console.warn(
          `[onboarding] narrator audio missing: ${src}`,
        );
      }}
    />
  );
}
