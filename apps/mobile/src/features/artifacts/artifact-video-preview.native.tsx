import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { createVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import FileExport, { isFileExportAvailable } from "../../../modules/nautilo-file-export";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useArtifactEvents } from "@/providers/artifact-events";
import { useVoice } from "@/providers/voice";
import { useAppTheme } from "@/providers/theme";
import { appLifecycle } from "@/platform/app-lifecycle";
import { subscribeMediaInterruption } from "@/lib/media-playback-interruption";
import { isLocalVideoFile } from "@/lib/video-file-container";
import { acquireAuthorizedArtifactOriginal } from "./artifact-original-access";
import { artifactDocumentScope } from "./artifact-document-scope";
import { viewerConvergenceAction } from "./artifact-convergence";

type Props = { artifactId: string; revision: number };
type PlayerState = { phase: "preparing" | "ready" | "failed" | "cancelled"; player?: VideoPlayer; message: string };

export function ArtifactVideoPreview(props: Props) {
  const { activeServer } = useServers();
  const { viewer, status } = useAuth();
  const scope = artifactDocumentScope(activeServer?.id, activeServer?.serverUrl, viewer?.userId, props.artifactId);
  return <VideoSession key={JSON.stringify([scope, status, props.revision])} {...props} />;
}

function VideoSession({ artifactId, revision }: Props) {
  const theme = useAppTheme();
  const { activeServer } = useServers();
  const { viewer, status } = useAuth();
  const { subscribe } = useArtifactEvents();
  const { speaking } = useVoice();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PlayerState>({ phase: "preparing", message: "Preparing video…" });
  const ownedPlayer = useRef<VideoPlayer | null>(null);
  const stopAttempt = useRef<(() => void) | null>(null);
  const position = useRef(0);
  const identity = JSON.stringify([activeServer?.id, activeServer?.serverUrl, viewer?.userId, status]);
  const liveIdentity = useRef(identity);
  liveIdentity.current = identity;
  const liveAttempt = useRef(attempt);
  liveAttempt.current = attempt;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const retired = useRef<Array<{ player?: VideoPlayer; release: () => void }>>([]);
  const releaseDetached = useCallback((attached?: VideoPlayer) => {
    const pending = retired.current;
    retired.current = [];
    for (const resource of pending) {
      if (resource.player && resource.player === attached) retired.current.push(resource);
      else resource.release();
    }
  }, []);
  const serverId = activeServer?.id;
  const baseUrl = activeServer?.serverUrl;
  const accountId = viewer?.userId;

  // Direct creation keeps one owner. Detach the committed VideoView first,
  // then release its decoder, then remove the file (never a timer heuristic).
  useFocusEffect(useCallback(() => {
    let disposed = false;
    let player: VideoPlayer | undefined;
    let cleanup: (() => void | Promise<void>) | undefined;
    const subscriptions: Array<{ remove(): void }> = [];
    const controller = new AbortController();
    const current = () => !disposed && !controller.signal.aborted && liveIdentity.current === identity;
    const pause = () => {
      try { if (player && !disposed) player.pause(); }
      catch { /* A terminal decoder error can race a lifecycle interruption. */ }
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      for (const subscription of subscriptions) subscription.remove();
      if (player) {
        try {
          position.current = Number.isFinite(player.currentTime) ? player.currentTime : 0;
          player.pause();
        } catch { /* A failed decoder may no longer expose its position. */ }
      }
      if (ownedPlayer.current === player) ownedPlayer.current = null;
      const releaseFile = cleanup;
      cleanup = undefined;
      retired.current.push({ player, release: () => {
        try { player?.release(); } catch { /* Continue releasing our file even if native teardown failed. */ }
        void Promise.resolve().then(() => releaseFile?.()).catch(() => {
          // The native process-start sweep retains recovery ownership. Surface
          // residual custody only for this still-visible attempt and identity.
          if (mounted.current && liveIdentity.current === identity && liveAttempt.current === attempt) setState({ phase: "failed", message: "Playback stopped, but its temporary copy could not be removed. Restart Nautilo to retry cleanup." });
        });
      } });
      if (mounted.current) setState((previous) => previous.player === player ? { ...previous, player: undefined } : previous);
    };
    stopAttempt.current = dispose;
    setState({ phase: "preparing", message: "Preparing video… The original is downloaded before playback." });
    if (!serverId || !baseUrl || !accountId || status !== "signed-in" || !isFileExportAvailable()) {
      setState({ phase: "failed", message: "Video requires a signed-in account and an updated Nautilo mobile build." });
      return dispose;
    }
    void (async () => {
      try {
        await FileExport.prepareExportCacheAsync();
        if (!current()) return;
        const file = await acquireAuthorizedArtifactOriginal({
          scope: { serverId, accountId, sourceKind: "artifact", sourceId: artifactId, generation: attempt },
          baseUrl, isCurrent: current, controller,
        });
        if (file.kind !== "ready") {
          if (current()) setState({ phase: "failed", message: videoAcquisitionFailure(file.reason) });
          return;
        }
        if (!current()) { await file.cleanup(); return; }
        cleanup = file.cleanup;
        if (file.revision !== revision) throw new Error("source_changed");
        if (!isLocalVideoFile(file.fileUri)) {
          dispose();
          setState({ phase: "failed", message: "This video container is not supported here. Try an MP4, MOV or WebM file, or use Save file to open the original in another app." });
          return;
        }
        player = createVideoPlayer(null);
        ownedPlayer.current = player;
        player.loop = false;
        player.staysActiveInBackground = false;
        player.showNowPlayingNotification = false;
        player.allowsExternalPlayback = false;
        player.audioMixingMode = "auto";
        const localPlayer = player;
        subscriptions.push(player.addListener("statusChange", ({ status: next }) => {
          if (!current()) return;
          if (next === "error") {
            dispose();
            setState({ phase: "failed", message: "This device could not play the video. Its codec or file may be unsupported. You can retry or save the original." });
          }
          if (next === "readyToPlay") setState({ phase: "ready", player: localPlayer, message: "" });
        }));
        // Progressive local source only; no bearer, URL or persistent player cache.
        await player.replaceAsync({ uri: file.fileUri, contentType: "progressive", useCaching: false });
        if (!current()) return;
        player.currentTime = Math.max(0, Math.min(position.current, player.duration || position.current));
        setState(player.status === "error"
          ? { phase: "failed", message: "This device could not play the video. Retry or save the original." }
          : { phase: player.status === "readyToPlay" ? "ready" : "preparing", player, message: "Preparing playback…" });
      } catch {
        if (current()) {
          dispose();
          setState({ phase: "failed", message: "Video preparation failed. Check your connection and storage, then retry. Save file is still available." });
        }
      }
    })();
    const stopEvents = subscribe((event) => {
      if (viewerConvergenceAction(event, artifactId, false) === "none") return;
      dispose();
      setAttempt((value) => value + 1);
    });
    const lifecycle = appLifecycle.addEventListener("change", (next) => { if (next !== "active") pause(); });
    const stopInterruption = subscribeMediaInterruption(pause);
    return () => { stopEvents(); lifecycle.remove(); stopInterruption(); dispose(); };
  }, [serverId, baseUrl, accountId, artifactId, attempt, identity, revision, status, subscribe]));

  useEffect(() => {
    try { if (speaking) ownedPlayer.current?.pause(); }
    catch { /* A terminal decoder error can race voice output. */ }
  }, [speaking]);
  // Passive effects run after the view commit. A focus-effect cleanup may run
  // in a commit still displaying its old player: retain it until the next
  // committed render has actually detached that specific player.
  useEffect(() => { releaseDetached(state.phase === "failed" ? undefined : state.player); });
  // Registered after acquisition cleanup so final unmount retires first.
  useEffect(() => () => releaseDetached(), [releaseDetached]);
  const textStyle = { color: theme.color.text.foreground };
  return <View style={styles.root}>
    {state.player && state.phase !== "failed" ? <VideoView
      style={styles.video} player={state.player} contentFit="contain" nativeControls
      fullscreenOptions={{ enable: true }} allowsPictureInPicture={false}
      accessibilityLabel="Video player"
    /> : null}
    {state.phase === "preparing" ? <ActivityIndicator color={theme.color.brand.accent} accessibilityLabel="Preparing video" /> : null}
    {state.message ? <Text accessibilityRole={state.phase === "failed" ? "alert" : undefined} style={[styles.message, textStyle]}>{state.message}</Text> : null}
    {state.phase === "preparing" ? <Pressable accessibilityRole="button" onPress={() => { stopAttempt.current?.(); setState({ phase: "cancelled", message: "Video preparation cancelled. You can retry or save the original." }); }}><Text style={[styles.action, { color: theme.color.brand.accent }]}>Cancel video preparation</Text></Pressable> : null}
    {state.phase === "failed" || state.phase === "cancelled" ? <Pressable accessibilityRole="button" onPress={() => setAttempt((value) => value + 1)}><Text style={[styles.action, { color: theme.color.brand.accent }]}>Retry video</Text></Pressable> : null}
  </View>;
}

function videoAcquisitionFailure(reason: string): string {
  switch (reason) {
    case "auth_dead": return "Your session ended. Sign in again to watch this video.";
    case "forbidden": return "This account no longer has access to this video.";
    case "missing": return "This video is no longer available.";
    case "source_changed": return "The video changed while it was being prepared. Reopen the file to get its current version.";
    case "cleanup_failed": return "Video preparation failed and a temporary app copy could not be removed. Restart Nautilo to retry cleanup.";
    default: return "Could not prepare the video. Check your connection and storage, then retry. Save file is still available.";
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "center", gap: 12 },
  video: { flex: 1, minHeight: 180 },
  message: { paddingHorizontal: 20, textAlign: "center" },
  action: { padding: 16, textAlign: "center", fontWeight: "600" },
});
