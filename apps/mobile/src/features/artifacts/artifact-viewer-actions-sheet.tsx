import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { mediaLibraryLabel } from "./artifact-media-export";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ArtifactDto } from "@nautilo/api-client/browser";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type SheetMode = "actions" | "delete" | "rename" | "share";

export function ArtifactViewerActionsSheet({
  artifact, visible, renameBusy, renameError, renameRetryable, deleteBusy, deleteError, deleteRetryable, deleteReconcileRequired,
  onClose, onRename, onRetryRename, onDelete, onRetryDelete, shareContent, onSaveFile, onSaveMedia, onShareFile, saveBusy, saveStatus,
}: {
  artifact: ArtifactDto;
  visible: boolean;
  renameBusy: boolean;
  renameError?: string;
  /** A response-loss/server failure freezes the exact original request. */
  renameRetryable: boolean;
  deleteBusy: boolean;
  deleteError?: string;
  deleteRetryable: boolean;
  /** A deterministic 403/404 must reload canonical state before another delete. */
  deleteReconcileRequired: boolean;
  onClose: () => void;
  onRename: (basename: string) => void;
  onRetryRename: () => void;
  onDelete: () => void;
  onRetryDelete: () => void;
  shareContent?: ReactNode;
  onSaveFile?: () => void;
  onSaveMedia?: () => void;
  onShareFile?: () => void;
  saveBusy?: boolean;
  saveStatus?: ReactNode;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [basename, setBasename] = useState(fileName(artifact.path));
  const [mode, setMode] = useState<SheetMode>("actions");
  useEffect(() => {
    if (!visible) { setMode("actions"); return; }
    setBasename(fileName(artifact.path));
  }, [artifact.path, visible]);
  const busy = renameBusy || deleteBusy;
  const canClose = !busy;
  const handleClose = (): void => { setMode("actions"); onClose(); };
  return <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={() => { if (canClose) handleClose(); }}>
    <KeyboardAvoidingView behavior="padding" style={[styles.root, mode === "share" && { paddingTop: insets.top }]}>
      <Pressable style={styles.backdrop} accessibilityRole="button" accessibilityLabel="Dismiss file actions" disabled={!canClose}
        onPress={handleClose} accessibilityState={{ disabled: !canClose }} />
      <View style={mode === "share" ? styles.shareContainer : [styles.sheet, { paddingBottom: Math.max(insets.bottom, theme.spacing.lg) }]} accessibilityLabel="File actions" accessibilityViewIsModal>
        {mode !== "share" ? <View style={styles.handle} /> : null}
        {mode === "actions" ? saveStatus : null}
        {mode === "actions" ? <ScrollView style={styles.actionList} contentContainerStyle={styles.actionContent}><ActionMenu styles={styles} canWrite={artifact.canWrite && !saveBusy} onSaveFile={onSaveFile} onSaveMedia={onSaveMedia} onShareFile={onShareFile} saveBusy={saveBusy} onClose={handleClose} onDelete={() => setMode("delete")} onRename={() => setMode("rename")} onShare={shareContent && !saveBusy ? () => setMode("share") : undefined} /></ScrollView> : null}
        {visible && mode === "share" ? shareContent : null}
        {mode === "rename" ? <RenameForm artifact={artifact} basename={basename} busy={renameBusy} error={renameError} retryable={renameRetryable}
          onClose={handleClose} onRename={() => onRename(basename)} onRetry={onRetryRename} onChange={setBasename} styles={styles} /> : null}
        {mode === "delete" ? <DeleteConfirmation artifact={artifact} busy={deleteBusy} error={deleteError} retryable={deleteRetryable} reconcileRequired={deleteReconcileRequired}
          onClose={handleClose} onDelete={onDelete} onRetry={onRetryDelete} styles={styles} /> : null}
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

function ActionMenu({ styles, canWrite, onSaveFile, onSaveMedia, onShareFile, saveBusy, onClose, onRename, onDelete, onShare }: { styles: ReturnType<typeof createStyles>; canWrite: boolean; onSaveFile?: () => void; onSaveMedia?: () => void; onShareFile?: () => void; saveBusy?: boolean; onClose: () => void; onRename: () => void; onDelete: () => void; onShare?: () => void }) {
  return <>
    <Text style={styles.title}>File actions</Text>
    {onSaveFile ? <Pressable style={styles.actionRow} accessibilityRole="button" accessibilityLabel="Save original file" disabled={saveBusy} accessibilityState={{ disabled: saveBusy }} onPress={onSaveFile}><Text style={styles.actionText}>Save file…</Text></Pressable> : null}
    {onShareFile ? <Pressable style={styles.actionRow} accessibilityRole="button" accessibilityLabel="Share original file" disabled={saveBusy} accessibilityState={{ disabled: saveBusy }} onPress={onShareFile}><Text style={styles.actionText}>Share…</Text></Pressable> : onSaveFile && Platform.OS === "android" ? <Text style={styles.detail}>To share a copy, save the file, then share it from Android Files.</Text> : null}
    {onSaveMedia ? <Pressable style={styles.actionRow} accessibilityRole="button" accessibilityLabel={mediaLibraryLabel(Platform.OS)} disabled={saveBusy} accessibilityState={{ disabled: saveBusy }} onPress={onSaveMedia}><Text style={styles.actionText}>{mediaLibraryLabel(Platform.OS)}</Text></Pressable> : null}
    {onShare ? <Pressable style={styles.actionRow} accessibilityRole="button" onPress={onShare}><Text style={styles.actionText}>Add to workspace</Text></Pressable> : null}
    {canWrite ? <Pressable style={styles.actionRow} accessibilityRole="button" accessibilityLabel="Rename file" onPress={onRename}><Text style={styles.actionText}>Rename file</Text></Pressable> : null}
    {canWrite ? <Pressable style={styles.actionRow} accessibilityRole="button" accessibilityLabel="Delete file" onPress={onDelete}><Text style={styles.deleteText}>Delete file</Text></Pressable> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Cancel file actions" onPress={onClose}><Text style={styles.cancel}>Cancel</Text></Pressable>
  </>;
}

function RenameForm({ artifact, basename, busy, error, retryable, onClose, onRename, onRetry, onChange, styles }: {
  artifact: ArtifactDto; basename: string; busy: boolean; error?: string; retryable: boolean; onClose: () => void; onRename: () => void; onRetry: () => void; onChange: (value: string) => void; styles: ReturnType<typeof createStyles>;
}) {
  const submit = retryable ? onRetry : onRename;
  const label = busy ? (retryable ? "Retrying…" : "Renaming…") : retryable ? "Retry rename" : "Rename";
  return <>
    <Text style={styles.title}>Rename file</Text><Text style={styles.detail}>Only the filename changes; its folder stays the same.</Text>
    <Text style={styles.path} selectable accessibilityLabel={`Current folder ${parentPath(artifact.path)}`}>Folder: {parentPath(artifact.path)}</Text>
    {retryable ? <Text style={styles.retryNotice} accessibilityRole="alert">The previous request may have reached the server. Retry uses the original filename.</Text> : null}
    <TextInput value={basename} onChangeText={onChange} editable={!busy && !retryable} autoFocus={!retryable} accessibilityLabel="New filename" style={styles.input} autoCapitalize="none" />
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <View style={styles.actions}><Pressable accessibilityRole="button" accessibilityLabel="Cancel rename" disabled={busy} onPress={onClose}><Text style={styles.cancel}>Cancel</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={retryable ? "Retry rename" : "Rename file"} disabled={busy} onPress={submit} accessibilityState={{ disabled: busy }} style={[styles.primary, busy && styles.primaryDisabled]}><Text style={styles.rename}>{label}</Text></Pressable></View>
  </>;
}

function DeleteConfirmation({ artifact, busy, error, retryable, reconcileRequired, onClose, onDelete, onRetry, styles }: {
  artifact: ArtifactDto; busy: boolean; error?: string; retryable: boolean; reconcileRequired: boolean; onClose: () => void; onDelete: () => void; onRetry: () => void; styles: ReturnType<typeof createStyles>;
}) {
  const submit = retryable ? onRetry : onDelete;
  const label = busy ? (retryable ? "Retrying…" : "Deleting…") : retryable ? "Retry delete" : "Delete file";
  const deterministicReconcile = reconcileRequired && !retryable;
  return <>
    <Text style={styles.title}>Delete file?</Text>
    <Text style={styles.detail}>This permanently deletes {fileName(artifact.path)}.</Text>
    {retryable ? <Text style={styles.retryNotice} accessibilityRole="alert">The previous delete may have reached the server. Retry sends the exact same request.</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <View style={styles.actions}><Pressable accessibilityRole="button" accessibilityLabel={reconcileRequired ? "Close and check latest file" : "Cancel delete"} disabled={busy} onPress={onClose}><Text style={styles.cancel}>{reconcileRequired ? "Close" : "Cancel"}</Text></Pressable>
      {!deterministicReconcile ? <Pressable accessibilityRole="button" accessibilityLabel={retryable ? "Retry delete" : "Confirm delete file"} disabled={busy} onPress={submit} accessibilityState={{ disabled: busy }} style={[styles.deletePrimary, busy && styles.primaryDisabled]}><Text style={styles.rename}>{label}</Text></Pressable> : null}</View>
  </>;
}

function fileName(path: string): string { return path.split("/").filter(Boolean).at(-1) ?? path; }
function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash + 1) || "/" : "/";
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, justifyContent: "flex-end" },
    backdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: t.color.surface.overlay },
    sheet: { maxHeight: "100%", flexShrink: 1, backgroundColor: t.color.surface.panel, paddingHorizontal: t.spacing.lg, paddingTop: t.spacing.sm, gap: t.spacing.sm, borderTopLeftRadius: t.radii.lg, borderTopRightRadius: t.radii.lg },
    actionList: { flexShrink: 1 },
    actionContent: { gap: t.spacing.sm },
    // Sharing owns its padding and scroll/footer layout. Bound this outer
    // container to the keyboard-resized parent instead of nesting two sheets.
    shareContainer: { maxHeight: "100%", flexShrink: 1 },
    handle: { alignSelf: "center", width: 36, height: 4, borderRadius: t.radii.pill, backgroundColor: t.color.border.strong, marginBottom: t.spacing.xs },
    title: { color: t.color.text.foreground, ...t.typography.subheading },
    detail: { color: t.color.text.muted, ...t.typography.body },
    path: { color: t.color.text.dim, ...t.typography.caption },
    retryNotice: { color: t.color.status.warning, ...t.typography.caption },
    input: { minHeight: 44, color: t.color.text.foreground, borderWidth: 1, borderColor: t.color.border.interactive, borderRadius: t.radii.sm, paddingHorizontal: t.spacing.md, ...t.typography.body },
    error: { color: t.color.status.error, ...t.typography.caption },
    actionRow: { minHeight: 44, justifyContent: "center", paddingHorizontal: t.spacing.sm, borderRadius: t.radii.sm, backgroundColor: t.color.surface.subtle },
    actionText: { color: t.color.text.foreground, ...t.typography.bodyStrong },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: t.spacing.md, minHeight: 44, alignItems: "center", marginTop: t.spacing.xs },
    cancel: { color: t.color.text.foreground, ...t.typography.label },
    primary: { minHeight: 40, paddingHorizontal: t.spacing.md, borderRadius: t.radii.sm, backgroundColor: t.color.action.primaryBg, justifyContent: "center" },
    primaryDisabled: { backgroundColor: t.color.action.primaryMuted },
    deletePrimary: { minHeight: 40, paddingHorizontal: t.spacing.md, borderRadius: t.radii.sm, backgroundColor: t.color.status.error, justifyContent: "center" },
    deleteText: { color: t.color.status.error, ...t.typography.bodyStrong },
    rename: { color: t.color.text.onPrimary, ...t.typography.label },
  });
}
