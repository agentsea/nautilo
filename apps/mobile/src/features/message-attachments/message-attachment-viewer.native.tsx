import { useEffect, useRef, useState } from "react";
import { randomUUID } from "expo-crypto";
import { ActivityIndicator, Alert, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import FileExport, { isFileExportAvailable, isMediaExportAvailable } from "../../../modules/nautilo-file-export";
import { isMediaLibraryCandidate, mediaLibraryLabel } from "@/features/artifacts/artifact-media-export";
import { ArtifactImageInspector } from "@/features/artifacts/artifact-image-inspector";
import { nativeSaveFailureCopy } from "@/features/artifacts/artifact-save-feedback";
import { nativeExportMimeType, safeArtifactBasename } from "@/features/artifacts/artifact-original-export";
import { ensureValidToken } from "@/lib/auth";
import { getApiClient } from "@/lib/api";
import { normalizeDownloadError } from "@/lib/artifact-bytes";
import { downloadOriginalFile, type OriginalFileDownload } from "@/lib/original-file-download";
import { loadTokenSnapshot } from "@/lib/server-store";
import { canShareOriginalFile, shareOriginalFile } from "@/lib/original-file-share";
import { useAppTheme } from "@/providers/theme";
import type { RetainedMessageAttachment, MessageAttachmentScope } from "./message-attachment-source";

type Props = Readonly<{ attachment: RetainedMessageAttachment; scope: Omit<MessageAttachmentScope, "attachmentId" | "generation">; onClose: () => void }>;
type State = { kind: "loading" } | { kind: "ready"; file?: OriginalFileDownload } | { kind: "failed"; message: string; file?: OriginalFileDownload };
type PendingSave = { requestId: string; controller: AbortController };

async function acquireCurrentAttachment(input: Readonly<{
  attachment: RetainedMessageAttachment;
  scope: Props["scope"];
  controller: AbortController;
  isCurrent: () => boolean;
}>): Promise<OriginalFileDownload> {
  const { attachment, scope, controller, isCurrent } = input;
  const filename = safeArtifactBasename(attachment.filename);
  let file: OriginalFileDownload | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await ensureValidToken(scope.serverId, scope.serverUrl, { forceRefresh: attempt === 1 });
    const snapshot = await loadTokenSnapshot(scope.serverId);
    if (!token || !snapshot.tokens || snapshot.tokens.accessToken !== token || snapshot.tokens.userId !== scope.accountId || !isCurrent()) {
      controller.abort();
      throw new Error("Session unavailable");
    }
    try {
      const url = getApiClient(scope.serverUrl).getMessageAttachmentUrl(attachment.attachmentId, { roomId: scope.roomId });
      file = await downloadOriginalFile({ url, token, filename, signal: controller.signal });
      break;
    } catch (error) {
      if (attempt === 0 && normalizeDownloadError(error).status === 401) continue;
      throw error;
    }
  }
  if (!file) throw new Error("Download unavailable");
  return file;
}

export function MessageAttachmentViewer({ attachment, scope, onClose }: Props) {
  const isImage = attachment.mimeType.toLowerCase().startsWith("image/");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const theme = useAppTheme();
  const [saveMessage, setSaveMessage] = useState("");
  const operation = useRef(0);
  const alive = useRef(true);
  const saving = useRef<PendingSave | null>(null);
  const saveResidual = useRef<OriginalFileDownload | null>(null);
  const closeRequested = useRef(false);
  useEffect(() => {
    alive.current = true;
    closeRequested.current = false;
    setState({ kind: "loading" });
    setSaveMessage("");
    const generation = ++operation.current;
    const controller = new AbortController();
    let owned: OriginalFileDownload | undefined;
    const current = () => alive.current && generation === operation.current;
    if (!isImage) {
      setState({ kind: "ready" });
      return () => {
        alive.current = false;
        operation.current += 1;
        controller.abort();
        if (saving.current) {
          saving.current.controller.abort();
          void FileExport.cancelPendingExportAsync(saving.current.requestId).catch(() => {});
        }
        try { saveResidual.current?.cleanup(); } catch { /* restart cache sweep owns recovery */ }
      };
    }
    void (async () => {
      try {
        await FileExport.prepareExportCacheAsync();
        if (!current()) throw new Error("Source changed");
        const file = await acquireCurrentAttachment({ attachment, scope, controller, isCurrent: current });
        owned = file;
        if (!current() || file.size !== attachment.sizeBytes) throw new Error("Attachment changed or download was incomplete");
        setState({ kind: "ready", file });
      } catch (error) {
        let residual = errorCode(error) === "ERR_EXPORT_TEMP_CLEANUP";
        try { owned?.cleanup(); } catch { residual = true; }
        if (current()) setState({ kind: "failed", ...(residual && owned ? { file: owned } : {}), message: residual
          ? "The attachment could not be prepared, and its temporary app copy could not be removed."
          : "Could not prepare this attachment. Check this account's conversation access, connection, and available storage, then try again." });
      }
    })();
    return () => {
      alive.current = false;
      operation.current += 1;
      controller.abort();
      if (saving.current) {
        saving.current.controller.abort();
        void FileExport.cancelPendingExportAsync(saving.current.requestId).catch(() => {});
      }
      else { try { owned?.cleanup(); } catch { /* no user copy is claimed */ } }
      try { saveResidual.current?.cleanup(); } catch { /* restart cache sweep owns recovery */ }
    };
  }, [attachment, attempt, scope.accountId, scope.messageId, scope.roomId, scope.serverId, scope.serverUrl]);

  const close = () => {
    if (!saving.current) {
      if (saveResidual.current) {
        try { saveResidual.current.cleanup(); saveResidual.current = null; }
        catch {
          setSaveMessage("The temporary save copy could not be removed. Close again to retry cleanup.");
          return;
        }
      }
      if (state.kind !== "loading" && state.file) {
        try { state.file.cleanup(); }
        catch {
          setState({ kind: "failed", file: state.file, message: "The temporary app copy could not be removed. Close again to retry cleanup." });
          return;
        }
      }
      onClose();
      return;
    }
    closeRequested.current = true;
    setSaveMessage("Cancelling… Close the save dialog if it is still open.");
    saving.current.controller.abort();
    void FileExport.cancelPendingExportAsync(saving.current.requestId).catch(() => {});
  };
  const retry = () => {
    if (saving.current) return;
    if (state.kind !== "loading" && state.file) {
      try { state.file.cleanup(); }
      catch {
        setState({ kind: "failed", file: state.file, message: "The temporary app copy could not be removed. Retry cleanup before preparing the attachment again." });
        return;
      }
    }
    setAttempt((value) => value + 1);
  };
  const save = async (destination: "file" | "media" | "share" = "file") => {
    if (destination === "share" && !canShareOriginalFile()) return;
    const available = isFileExportAvailable() && (destination !== "media" || isMediaExportAvailable());
    if (state.kind !== "ready" || saving.current || !available) {
      if (!available) setSaveMessage("Saving requires an updated Nautilo build.");
      return;
    }
    if (saveResidual.current) {
      try {
        saveResidual.current.cleanup();
        saveResidual.current = null;
      } catch {
        setSaveMessage("The previous temporary save copy could not be removed. Retry cleanup before saving again.");
        return;
      }
    }
    const requestId = randomUUID();
    const saveController = new AbortController();
    const saveGeneration = operation.current;
    const saveCurrent = () => alive.current && operation.current === saveGeneration && saving.current?.requestId === requestId;
    saving.current = { requestId, controller: saveController };
    let saveFile: OriginalFileDownload | undefined;
    setSaveMessage("Preparing the current attachment…");
    try {
      await FileExport.prepareExportCacheAsync();
      if (!saveCurrent() || closeRequested.current) return;
      saveFile = await acquireCurrentAttachment({ attachment, scope, controller: saveController, isCurrent: saveCurrent });
      if (!saveCurrent() || saveFile.size !== attachment.sizeBytes) throw new Error("Attachment changed or download was incomplete");
      if (!saveCurrent() || closeRequested.current) return;
      if (destination === "share") {
        setSaveMessage("Choose an app to share the original with. Close the share sheet to cancel.");
        await shareOriginalFile(saveFile.fileUri, nativeExportMimeType(attachment.mimeType));
        if (saveCurrent()) setSaveMessage("Share sheet closed. Check the receiving app to confirm your copy.");
        return;
      }
      setSaveMessage(destination === "media" ? "Saving to your photo library…" : "Choose where to save the original image.");
      const input = { requestId, fileUri: saveFile.fileUri, filename: safeArtifactBasename(attachment.filename), mimeType: nativeExportMimeType(attachment.mimeType) };
      const receipt = destination === "media" ? await FileExport.saveMediaAsync(input) : await FileExport.saveFileAsync(input);
      if (saveCurrent()) setSaveMessage(receipt.status === "saved"
        ? `${destination === "media" ? "Saved to your photo library" : "Saved"}: ${safeArtifactBasename(attachment.filename)}`
        : "Save cancelled.");
    } catch (error) {
      if (saveCurrent()) {
        const status = normalizeDownloadError(error).status;
        if (status === 403 || status === 404) {
          try {
            state.file?.cleanup();
            setState({ kind: "failed", message: "This attachment is no longer available from this conversation." });
            setSaveMessage("");
          } catch {
            setState({ kind: "failed", ...(state.file ? { file: state.file } : {}), message: "This attachment is no longer available, and its temporary app copy could not be removed. Close to retry cleanup." });
            setSaveMessage("");
          }
        } else {
          setSaveMessage(destination === "share" ? "Could not share this file. Try again or use Save file instead." : nativeSaveFailureCopy(error));
        }
      }
    } finally {
      if (saveFile) {
        try { saveFile.cleanup(); }
        catch {
          saveResidual.current = saveFile;
          if (saveCurrent()) setSaveMessage("The save operation ended, but its temporary copy could not be removed. Close to retry cleanup.");
        }
      }
      if (saving.current?.requestId === requestId) saving.current = null;
      const remainsCurrent = alive.current && operation.current === saveGeneration;
      if (closeRequested.current && remainsCurrent) {
        if (saveResidual.current) {
          closeRequested.current = false;
        } else {
          try {
            state.file?.cleanup();
            onClose();
          } catch {
            closeRequested.current = false;
            setState({ kind: "failed", file: state.file, message: "The save operation ended, but its temporary app copy could not be removed. Close again to retry cleanup." });
          }
        }
      } else if (!remainsCurrent) {
        try { state.file?.cleanup(); } catch { /* restart cache sweep owns recovery */ }
      }
    }
  };

  const showActions = () => {
    Alert.alert(attachment.filename, Platform.OS === "android" ? "To share a copy, save it and share from Android Files." : "Save or share an original copy.", [
      { text: "Save file…", onPress: () => void save() },
      ...(canShareOriginalFile() ? [{ text: "Share…", onPress: () => void save("share") }] : []),
      ...(isMediaLibraryCandidate(attachment.mimeType) ? [{ text: mediaLibraryLabel(Platform.OS), onPress: () => void save("media") }] : []),
      { text: "Cancel", style: "cancel" },
    ]);
  };

  return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={() => void close()}>
    <SafeAreaView style={[styles.root, { backgroundColor: theme.color.surface.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.color.border.default }]}><Pressable accessibilityRole="button" onPress={() => void close()}><Text style={[styles.action, { color: theme.color.brand.accent }]}>Close</Text></Pressable><Text numberOfLines={1} style={[styles.title, { color: theme.color.text.foreground }]}>{attachment.filename}</Text><Pressable accessibilityRole="button" accessibilityLabel="Attachment file actions" onPress={showActions} disabled={state.kind !== "ready" || saving.current !== null} accessibilityState={{ disabled: state.kind !== "ready" || saving.current !== null }}><Text style={[styles.action, { color: theme.color.brand.accent }]}>File actions</Text></Pressable></View>
      {state.kind === "loading" ? <ActivityIndicator accessibilityLabel="Preparing attachment" color={theme.color.brand.accent} /> : state.kind === "failed" ? <View><Text accessibilityRole="alert" style={[styles.message, { color: theme.color.text.foreground }]}>{state.message}</Text><Pressable accessibilityRole="button" onPress={() => void retry()}><Text style={[styles.action, { color: theme.color.brand.accent }]}>Retry attachment</Text></Pressable></View> : isImage && state.file ? <ArtifactImageInspector uri={state.file.fileUri} sourceKey={`${scope.serverId}:${scope.accountId}:${scope.roomId}:${scope.messageId}:${attachment.attachmentId}`} accessibilityLabel={attachment.filename} /> : <View style={styles.unsupportedPreview}>
        <Text style={[styles.unsupportedName, { color: theme.color.text.foreground }]}>{attachment.filename}</Text>
        <Text style={[styles.message, { color: theme.color.text.foreground }]}>{attachment.mimeType}</Text>
        <Text style={[styles.message, { color: theme.color.text.foreground }]}>Inline preview is not available for this attachment. You can still save the unchanged original.</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Save original attachment file" onPress={() => void save()} disabled={saving.current !== null} accessibilityState={{ disabled: saving.current !== null }}><Text style={[styles.action, { color: theme.color.brand.accent }]}>Save file…</Text></Pressable>
      </View>}
      {saveMessage ? <Text accessibilityLiveRegion="polite" style={[styles.message, { color: theme.color.text.foreground }]}>{saveMessage}</Text> : null}
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({ root: { flex: 1 }, header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth }, title: { flex: 1, textAlign: "center", fontWeight: "600" }, action: { minHeight: 44, padding: 8, fontWeight: "600" }, message: { padding: 16 }, unsupportedPreview: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }, unsupportedName: { fontSize: 18, fontWeight: "600", textAlign: "center" } });

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : null;
}
