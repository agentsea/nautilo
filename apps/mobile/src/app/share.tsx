import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { getApiClient } from "@/lib/api";
import {
  claimInboundShareReceipt,
  clearInboundShareReceipt,
  type InboundFileReceipt,
} from "@/lib/inbound-share-custody";
import { discardInboundShareFile, openInboundShareFile } from "@/lib/inbound-share-file";
import { claimPendingShare, clearPendingShare } from "@/lib/pending-share";
import { saveRoomDraft, saveRoomDraftSnapshot } from "@/lib/room-drafts";
import {
  isConversationVisibleToViewer,
  isListableRoom,
  roomDisplayName,
  sortRoomsByRecency,
} from "@/lib/rooms";
import {
  recoverMobileCapabilityDenial,
  WRITE_ARTIFACTS_REQUIRED_COPY,
} from "@/lib/mobile-capability-denial";
import { viewerCan } from "@/lib/viewer-capabilities";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { RoomSummaryDto } from "@nautilo/types";
import {
  canOpenSharedTextDraft,
  type SharedTextIntent,
  type VerifiedShareOwner,
} from "@/lib/share-handoff";
import { conversationAttachmentAvailability } from "@/features/share/share-destinations";

export default function ShareDestinationScreen() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { activeServer, servers, switchTo } = useServers();
  const { status, viewer, viewerState, refreshViewer } = useAuth();
  const canInvokeAgents = viewerCan(viewer, "invoke_agents");
  const canWriteArtifacts = viewerCan(viewer, "write_artifacts");
  const generationRef = useRef(0);
  const currentScopeRef = useRef<{ serverId: string; viewerId: string } | null>(null);
  const [intent, setIntent] = useState<SharedTextIntent | null>(null);
  const [fileReceipt, setFileReceipt] = useState<InboundFileReceipt | null>(null);
  const [fileDestination, setFileDestination] = useState<"room" | "workspace">("room");
  const [rooms, setRooms] = useState<RoomSummaryDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [verifiedOwner, setVerifiedOwner] = useState<VerifiedShareOwner | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [switchingServerId, setSwitchingServerId] = useState<string | null>(null);
  const authorizedRoomIds = useMemo(() => new Set(rooms.map((room) => room.id)), [rooms]);
  const canReviewInChat = canOpenSharedTextDraft({
    pending: intent,
    owner: verifiedOwner,
    currentServerId: activeServer?.id ?? null,
    currentViewerId: viewerState === "verified" ? (viewer?.userId ?? null) : null,
    roomId: selectedId,
    authorizedRoomIds,
    switchingServer: switchingServerId !== null,
  });
  const exactOwner = verifiedOwner !== null
    && verifiedOwner.serverId === activeServer?.id
    && verifiedOwner.viewerId === (viewerState === "verified" ? viewer?.userId : null)
    && switchingServerId === null;
  const conversationAvailability = fileReceipt
    ? conversationAttachmentAvailability(fileReceipt.mimeType)
    : { available: false, reason: null };
  const canReviewFileInChat = fileReceipt !== null
    && conversationAvailability.available
    && exactOwner
    && selectedId !== null
    && authorizedRoomIds.has(selectedId);
  const fileHasAvailableDestination = conversationAvailability.available || canWriteArtifacts;
  const canAddFileToWorkspace = fileReceipt !== null
    && canWriteArtifacts
    && exactOwner
    && selectedId !== null
    && authorizedRoomIds.has(selectedId);
  currentScopeRef.current = status === "signed-in" && viewerState === "verified" && activeServer && viewer
    ? { serverId: activeServer.id, viewerId: viewer.userId }
    : null;

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    setVerifiedOwner(null);
    if (!viewer || viewerState !== "verified" || !activeServer || status !== "signed-in") {
      setLoading(false);
      setError("Sign in to choose where to share this item.");
      return;
    }
    try {
      // `listRooms()` obtains a fresh bearer. Only then ask the same server
      // who that bearer belongs to; this turns the selection into an exact
      // server/viewer/authorized-Room admission instead of trusting stale UI
      // identity while a registry switch is settling.
      const response = await getApiClient(activeServer.serverUrl).listRooms();
      const whoami = await getApiClient(activeServer.serverUrl).whoami();
      const viewerId = whoami.sessionUserId;
      if (generationRef.current !== generation) return;
      if (!viewerId || viewer.userId !== viewerId) {
        setRooms([]);
        setSelectedId(null);
        setError("Verifying this server account…");
        return;
      }
      // A restored/direct /share route must make the same exact claim as the
      // inbound provider. Never render an unscoped or another identity's
      // device receipt just because this screen was navigated to directly.
      const scope = { serverId: activeServer.id, viewerId };
      const [pending, inboundFile] = await Promise.all([
        claimPendingShare(scope),
        claimInboundShareReceipt(scope),
      ]);
      if (generationRef.current !== generation) return;
      if (!pending && !inboundFile) {
        setError("This shared item is no longer available. Share it again.");
        setRooms([]);
        setSelectedId(null);
        return;
      }
      const available = sortRoomsByRecency(response.rooms.filter((room) =>
        isListableRoom(room.kind)
        && isConversationVisibleToViewer(room, viewer.userId, canInvokeAgents)));
      setIntent(pending);
      setFileReceipt(inboundFile);
      if (inboundFile) {
        const availability = conversationAttachmentAvailability(inboundFile.mimeType);
        setFileDestination(availability.available ? "room" : "workspace");
      }
      setRooms(available);
      setSelectedId((current) => available.some((room) => room.id === current) ? current : (available[0]?.id ?? null));
      setVerifiedOwner({ serverId: activeServer.id, viewerId });
      if (available.length === 0) setError("No conversations are available on this server.");
    } catch {
      if (generationRef.current === generation) setError("Could not load your conversations. Try again.");
    } finally {
      if (generationRef.current === generation) setLoading(false);
    }
  }, [activeServer, canInvokeAgents, status, viewer, viewerState]);

  useEffect(() => { void load(); return () => { generationRef.current += 1; }; }, [load]);

  const cancel = useCallback(async () => {
    await clearPendingShare().catch(() => {});
    await clearInboundShareReceipt().catch(() => {});
    if (fileReceipt) await discardInboundShareFile(fileReceipt).catch(() => {});
    // Share is an OS-owned ingress, not an ordinary page in the user's app
    // history. Replace it with Chats after cleanup so Back cannot resurrect a
    // cancelled review with stale in-memory receipt metadata.
    router.replace("/(drawer)/(tabs)");
  }, [fileReceipt]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      void cancel();
      return true;
    });
    return () => subscription.remove();
  }, [cancel]);

  const chooseServer = useCallback(async (serverId: string) => {
    if (serverId === activeServer?.id || switchingServerId) return;
    setSwitchingServerId(serverId);
    setVerifiedOwner(null);
    setRooms([]);
    setSelectedId(null);
    setError(null);
    try {
      await switchTo(serverId);
    } catch {
      setError("Could not switch servers. Try again.");
    } finally {
      setSwitchingServerId(null);
    }
  }, [activeServer?.id, switchTo, switchingServerId]);

  const openTextDraft = useCallback(async () => {
    if (!canReviewInChat || !intent || !verifiedOwner || !selectedId || opening) return;
    setOpening(true);
    setError(null);
    try {
      const outcome = await saveRoomDraft(
        { serverId: verifiedOwner.serverId, viewerId: verifiedOwner.viewerId, roomId: selectedId },
        intent.value,
      );
      if (outcome === "too-large") {
        setError("This item is too long for a recoverable mobile draft.");
        return;
      }
      if (!sameScope(currentScopeRef.current, verifiedOwner)) throw new Error("Share destination changed");
      await clearPendingShare();
      router.replace({ pathname: "/chat/[roomId]", params: { roomId: selectedId } });
    } catch {
      setError("Could not prepare this draft. Try again.");
    } finally {
      setOpening(false);
    }
  }, [canReviewInChat, opening, selectedId, verifiedOwner]);

  const reviewFileInChat = useCallback(async () => {
    if (!fileReceipt || !canReviewFileInChat || !verifiedOwner || !selectedId || opening || !activeServer) return;
    setOpening(true);
    setError(null);
    let attachmentId: string | null = null;
    try {
      const file = await openInboundShareFile(fileReceipt);
      const uploaded = await getApiClient(activeServer.serverUrl).uploadMessageAttachment(file, fileReceipt.filename, { roomId: selectedId });
      attachmentId = uploaded.attachmentId;
      if (!sameScope(currentScopeRef.current, verifiedOwner)) throw new Error("Share destination changed");
      const outcome = await saveRoomDraftSnapshot(
        { serverId: verifiedOwner.serverId, viewerId: verifiedOwner.viewerId, roomId: selectedId },
        {
          text: "",
          attachments: [{
            kind: "server",
            attachmentId,
            filename: uploaded.filename,
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.sizeBytes,
          }],
        },
      );
      if (outcome !== "saved") throw new Error("Could not prepare the attachment for review");
      await clearInboundShareReceipt();
      await discardInboundShareFile(fileReceipt).catch(() => {});
      router.replace({ pathname: "/chat/[roomId]", params: { roomId: selectedId } });
    } catch {
      if (attachmentId) await getApiClient(activeServer.serverUrl).deleteMessageAttachment(attachmentId).catch(() => {});
      setError("Could not prepare this file for review. Nothing was sent.");
    } finally {
      setOpening(false);
    }
  }, [activeServer, canReviewFileInChat, fileReceipt, opening, selectedId, verifiedOwner]);

  const addFileToWorkspace = useCallback(async () => {
    if (!fileReceipt || !canAddFileToWorkspace || !activeServer || !verifiedOwner || !selectedId || opening) return;
    setOpening(true);
    setError(null);
    let artifactId: string | null = null;
    try {
      const file = await openInboundShareFile(fileReceipt);
      const created = await getApiClient(activeServer.serverUrl).createWorkspaceArtifact(file, {
        path: fileReceipt.filename,
        mimeType: fileReceipt.mimeType,
        roomId: selectedId,
      });
      artifactId = created.id;
      if (!sameScope(currentScopeRef.current, verifiedOwner)) {
        throw new Error("Share destination changed");
      }
      await clearInboundShareReceipt();
      await discardInboundShareFile(fileReceipt).catch(() => {});
      router.replace("/(drawer)/(tabs)/files");
    } catch (caught) {
      if (artifactId) await getApiClient(activeServer.serverUrl).deleteWorkspaceArtifact(artifactId).catch(() => {});
      const denial = await recoverMobileCapabilityDenial({
        error: caught,
        actionScope: { serverId: verifiedOwner.serverId, userId: verifiedOwner.viewerId },
        getCurrentScope: () => currentScopeRef.current
          ? { serverId: currentScopeRef.current.serverId, userId: currentScopeRef.current.viewerId }
          : null,
        refreshViewer,
      });
      setError(denial?.message ?? "Could not add this file to Workspace Files. Try again.");
    } finally {
      setOpening(false);
    }
  }, [activeServer, canAddFileToWorkspace, fileReceipt, opening, refreshViewer, selectedId, verifiedOwner]);

  return (
    <View style={styles.root}>
      <AppBar
        title="Share to Nautilo"
        left={<AppBarBackButton onPress={() => { void cancel(); }} />}
        showOverflow={false}
      />
      <Screen edgeTop={false} contentStyle={styles.content}>
        <View style={styles.preview}>
          <Text style={styles.eyebrow}>{fileReceipt ? "FILE" : intent?.kind === "url" ? "LINK" : "TEXT"}</Text>
          <Text style={styles.previewText} numberOfLines={6}>{fileReceipt?.filename ?? intent?.value ?? "Shared item"}</Text>
          {fileReceipt ? <Text style={styles.secondary}>{fileReceipt.mimeType} · {formatBytes(fileReceipt.sizeBytes)}</Text> : null}
        </View>

        {servers.length > 1 ? <View style={styles.serverSection}>
          <Text style={styles.heading}>Choose a server</Text>
          {servers.map((server) => {
            const selected = server.id === activeServer?.id;
            return <Pressable
              key={server.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, busy: switchingServerId === server.id }}
              onPress={() => { void chooseServer(server.id); }}
              style={[styles.server, selected && styles.roomSelected]}
            >
              <Text style={styles.roomName}>{server.displayName}</Text>
              {switchingServerId === server.id
                ? <ActivityIndicator color={t.color.brand.accent} />
                : <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={25} color={t.color.brand.accent} />}
            </Pressable>;
          })}
        </View> : null}

        {fileReceipt ? <View style={styles.destinationSection}>
          <Text style={styles.heading}>Add it to</Text>
          <View style={styles.destinationChoices}>
            {conversationAvailability.available ? <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: fileDestination === "room", disabled: !conversationAvailability.available }}
              disabled={!conversationAvailability.available}
              onPress={() => { setError(null); setFileDestination("room"); }}
              style={[styles.destination, fileDestination === "room" && styles.roomSelected, !conversationAvailability.available && styles.disabled]}
            >
              <Text style={styles.roomName}>A conversation</Text>
              <Text style={styles.secondary}>Review before sending</Text>
            </Pressable> : null}
            {canWriteArtifacts ? <Pressable accessibilityRole="radio" accessibilityState={{ checked: fileDestination === "workspace" }} onPress={() => { setError(null); setFileDestination("workspace"); }} style={[styles.destination, fileDestination === "workspace" && styles.roomSelected]}>
              <Text style={styles.roomName}>Workspace Files</Text><Text style={styles.secondary}>Save to this server’s library</Text>
            </Pressable> : null}
          </View>
          {!conversationAvailability.available && !canWriteArtifacts ? (
            <Text style={styles.secondary}>{WRITE_ARTIFACTS_REQUIRED_COPY}</Text>
          ) : null}
        </View> : <View>
          <Text style={styles.heading}>Choose a conversation</Text>
          <Text style={styles.secondary}>On {activeServer?.displayName ?? "this server"}. Nothing is sent until you review it in chat.</Text>
        </View>}

        {fileReceipt && fileHasAvailableDestination ? <View>
          <Text style={styles.heading}>{fileDestination === "room" ? "Choose a conversation" : "Choose where it belongs"}</Text>
          <Text style={styles.secondary}>{fileDestination === "room"
            ? "Nothing is sent until you review the attachment in chat."
            : "It will appear in Workspace Files for the people in this conversation."}</Text>
        </View> : null}

        {loading ? <View style={styles.loading}><ActivityIndicator color={t.color.brand.accent} /><Text style={styles.secondary}>Loading conversations…</Text></View> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {!loading && (!fileReceipt || fileHasAvailableDestination) ? rooms.map((room) => {
          const selected = room.id === selectedId;
          return (
            <Pressable
              key={room.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              onPress={() => setSelectedId(room.id)}
              style={[styles.room, selected && styles.roomSelected]}
            >
              <View style={styles.roomCopy}><Text style={styles.roomName}>{roomDisplayName(room)}</Text></View>
              <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={25} color={t.color.brand.accent} />
            </Pressable>
          );
        }) : null}

        {fileReceipt && fileDestination === "workspace" && canWriteArtifacts ? <Pressable
          accessibilityRole="button"
          disabled={!canAddFileToWorkspace || opening}
          onPress={() => { void addFileToWorkspace(); }}
          style={[styles.primary, (!canAddFileToWorkspace || opening) && styles.disabled]}
        >
          {opening ? <ActivityIndicator color={t.color.text.onPrimary} /> : <Text style={styles.primaryText}>Add to Workspace Files</Text>}
        </Pressable> : (!fileReceipt || (fileDestination === "room" && conversationAvailability.available)) ? <Pressable
          accessibilityRole="button"
          disabled={fileReceipt ? !canReviewFileInChat || opening : !canReviewInChat || opening}
          onPress={() => { if (fileReceipt) void reviewFileInChat(); else void openTextDraft(); }}
          style={[styles.primary, (fileReceipt ? !canReviewFileInChat || opening : !canReviewInChat || opening) && styles.disabled]}
        >
          {opening ? <ActivityIndicator color={t.color.text.onPrimary} /> : <Text style={styles.primaryText}>{fileReceipt ? "Review attachment in chat" : "Review in chat"}</Text>}
        </Pressable> : null}
        <Pressable accessibilityRole="button" onPress={() => { void cancel(); }} style={styles.cancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </Screen>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.color.surface.background },
    content: { paddingTop: t.spacing.lg },
    preview: { borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.lg, padding: t.spacing.lg, gap: t.spacing.sm, backgroundColor: t.color.surface.subtle },
    eyebrow: { color: t.color.text.muted, fontSize: 12, fontWeight: "800", letterSpacing: 1 },
    previewText: { color: t.color.text.foreground, fontSize: 17, lineHeight: 24 },
    heading: { color: t.color.text.foreground, fontSize: 22, fontWeight: "800" },
    serverSection: { gap: t.spacing.sm },
    destinationSection: { gap: t.spacing.sm },
    destinationChoices: { gap: t.spacing.sm },
    destination: { minHeight: 70, gap: 4, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.md, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.md, backgroundColor: t.color.surface.panel },
    server: { minHeight: 58, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.md, paddingHorizontal: t.spacing.lg, backgroundColor: t.color.surface.panel },
    secondary: { color: t.color.text.muted, fontSize: 15, lineHeight: 21 },
    loading: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: t.spacing.md },
    error: { color: t.color.status.error, fontSize: 15, fontWeight: "700" },
    room: { minHeight: 68, flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.md, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.md, backgroundColor: t.color.surface.panel },
    roomSelected: { borderColor: t.color.brand.accent, borderWidth: 2 },
    roomCopy: { flex: 1 },
    roomName: { color: t.color.text.foreground, fontSize: 17, fontWeight: "700" },
    primary: { minHeight: 54, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, backgroundColor: t.color.brand.accent },
    disabled: { opacity: 0.5 },
    primaryText: { color: t.color.text.onPrimary, fontSize: 17, fontWeight: "800" },
    cancel: { minHeight: 48, alignItems: "center", justifyContent: "center" },
    cancelText: { color: t.color.brand.accent, fontSize: 16, fontWeight: "700" },
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sameScope(
  current: { serverId: string; viewerId: string } | null,
  expected: { serverId: string; viewerId: string },
): boolean {
  return current?.serverId === expected.serverId && current.viewerId === expected.viewerId;
}
