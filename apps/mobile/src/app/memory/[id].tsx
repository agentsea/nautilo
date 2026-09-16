import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import {
  formatMemoryDate,
  memoryActionAvailability,
  memoryAudienceLabel,
  memoryErrorMessage,
  memoryTypeLabel,
  type MemoryActionAuthority,
} from "@/features/memory/presentation";
import { ManageAccessSheet } from "@/features/memory-management/manage-access-sheet";
import { getApiClient } from "@/lib/api";
import { useServers } from "@/providers/server-registry";
import { useAuth } from "@/providers/auth";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type MemoryMode = "namespace" | "scope";
type MemoryDetail = {
  type: string;
  content: string;
  importance: number;
  tier: number;
  createdAt: string;
  updatedAt: string;
  demotedAt: string | null;
  demotedFrom: number | null;
  namespaceIds?: string[];
  accessList?: Array<{ displayName: string; userHandle: string }>;
  scopeOrigin?: "seed" | "scope";
  origin?: "seed" | "scope";
};

function isMemoryHardDeleteConflict(error: unknown): error is { hint?: string } {
  return (
    error instanceof Error &&
    error.name === "MemoryHardDeleteConflictError"
  );
}

export default function MemoryDetailScreen() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { activeServer } = useServers();
  const { viewer } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const requestGeneration = useRef(0);
  const [memory, setMemory] = useState<MemoryDetail | null>(null);
  const [memoryMode, setMemoryMode] = useState<MemoryMode | null>(null);
  const [actionAuthority, setActionAuthority] = useState<MemoryActionAuthority | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [overflowVisible, setOverflowVisible] = useState(false);
  const [editing, setEditing] = useState(false);
  const [contentDraft, setContentDraft] = useState("");
  const [importanceDraft, setImportanceDraft] = useState(0);
  const [saving, setSaving] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [accessVisible, setAccessVisible] = useState(false);

  const loadMemory = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    setActionAuthority(null);

    if (!activeServer || !id) {
      if (generation === requestGeneration.current) {
        setMemory(null);
        setActionAuthority(null);
        setError("This memory could not be opened.");
        setLoading(false);
      }
      return;
    }

    try {
      const response = await getApiClient(activeServer.serverUrl).getMemory(id);
      if (generation !== requestGeneration.current) return;
      setMemory(response.memory);
      setMemoryMode(response.memoryMode);
      setActionAuthority(response.actionAuthority);
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      setMemory(null);
      setActionAuthority(null);
      setError(memoryErrorMessage(caught, "detail"));
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [activeServer, id]);

  useEffect(() => {
    void loadMemory();
  }, [loadMemory]);

  const actions = memoryActionAvailability(
    actionAuthority,
    memoryMode,
  );

  const beginEdit = (): void => {
    if (!memory || !actions.canEdit) return;
    setContentDraft(memory.content);
    setImportanceDraft(memory.importance);
    setMutationError(null);
    setOverflowVisible(false);
    setEditing(true);
  };

  const saveEdit = async (): Promise<void> => {
    if (!activeServer || !id || !actions.canEdit) return;
    const content = contentDraft.trim();
    if (!content) {
      setMutationError("Memory content cannot be empty.");
      return;
    }
    setSaving(true);
    setMutationError(null);
    try {
      const response = await getApiClient(activeServer.serverUrl).updateMemory(id, {
        content,
        importance: importanceDraft,
      });
      setMemory(response.memory);
      setMemoryMode(response.memoryMode);
      setActionAuthority(response.actionAuthority);
      setEditing(false);
    } catch (caught) {
      setMutationError(memoryErrorMessage(caught, "mutation"));
    } finally {
      setSaving(false);
    }
  };

  const archive = (): void => {
    if (!activeServer || !id || !actions.canArchive) return;
    setOverflowVisible(false);
    Alert.alert("Archive this memory?", "It will be hidden from your AI.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Archive",
        onPress: () => {
          void (async () => {
            setMutating(true);
            setMutationError(null);
            try {
              await getApiClient(activeServer.serverUrl).archiveMemory(id);
              router.replace("/(drawer)/(tabs)/memory");
            } catch (caught) {
              setMutationError(memoryErrorMessage(caught, "mutation"));
            } finally {
              setMutating(false);
            }
          })();
        },
      },
    ]);
  };

  const hardDelete = (confirmShared = false): void => {
    if (!activeServer || !id || !actions.canDelete) return;
    const run = async (): Promise<void> => {
      setMutating(true);
      setMutationError(null);
      try {
        await getApiClient(activeServer.serverUrl).hardDeleteMemory(
          id,
          confirmShared ? { confirmShared: true } : undefined,
        );
        router.replace("/(drawer)/(tabs)/memory");
      } catch (caught) {
        if (isMemoryHardDeleteConflict(caught)) {
          Alert.alert(
            "This memory is shared",
            caught.hint ??
              "Deleting removes it from your writable namespace. Others may keep access.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Delete anyway", style: "destructive", onPress: () => hardDelete(true) },
            ],
          );
        } else {
          setMutationError(memoryErrorMessage(caught, "mutation"));
        }
      } finally {
        setMutating(false);
      }
    };
    if (confirmShared) {
      void run();
      return;
    }
    setOverflowVisible(false);
    Alert.alert(
      "Delete memory permanently?",
      "This removes the memory and its embedding. Archive it instead if you only want to hide it.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void run() },
      ],
    );
  };

  return (
    <View style={styles.container}>
      <AppBar
        title={editing ? "Edit memory" : "Memory"}
        left={<AppBarBackButton onPress={() => router.back()} />}
        embedOverflowSheet={false}
        overflowVisible={overflowVisible}
        onOverflowPress={() => {
          if (!editing && (actions.canEdit || actions.canArchive || actions.canDelete)) setOverflowVisible(true);
        }}
        onOverflowClose={() => setOverflowVisible(false)}
      />

      <KeyboardAvoidingView behavior="padding" style={styles.body}>
      {loading ? (
        <View style={styles.stateWrap}>
          <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading memory" />
          <Text style={styles.stateSub}>Loading memory…</Text>
        </View>
      ) : error ? (
        <View style={styles.stateWrap}>
          <Ionicons name="document-text-outline" size={34} color={t.color.text.muted} />
          <Text style={styles.stateTitle}>Memory unavailable</Text>
          <Text style={styles.stateSub}>{error}</Text>
          <Pressable style={styles.retryButton} onPress={() => void loadMemory()} accessibilityRole="button">
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : memory && editing ? (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.editHeader}>
            <Pressable onPress={() => setEditing(false)} disabled={saving} accessibilityRole="button">
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={() => void saveEdit()} disabled={saving} accessibilityRole="button">
              {saving ? <ActivityIndicator color={t.color.brand.accent} /> : <Text style={styles.saveText}>Save</Text>}
            </Pressable>
          </View>
          <Text style={styles.fieldLabel}>Content</Text>
          <TextInput
            value={contentDraft}
            onChangeText={setContentDraft}
            style={styles.contentInput}
            multiline
            textAlignVertical="top"
            accessibilityLabel="Memory content"
          />
          <Text style={styles.fieldLabel}>Importance {Math.round(importanceDraft * 100)}%</Text>
          <View style={styles.importanceRow}>
            {[0.2, 0.4, 0.6, 0.8, 1].map((value) => (
              <Pressable
                key={value}
                onPress={() => setImportanceDraft(value)}
                style={[styles.importanceDot, importanceDraft >= value && styles.importanceDotActive]}
                accessibilityRole="button"
                accessibilityLabel={`Set importance to ${Math.round(value * 100)} percent`}
              />
            ))}
          </View>
          {mutationError ? <Text style={styles.mutationError}>{mutationError}</Text> : null}
        </ScrollView>
      ) : memory ? (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.hero}>
            <View style={styles.typeIcon}>
              <Ionicons name="sparkles-outline" size={24} color={t.color.brand.accent} />
            </View>
            <View style={styles.heroCopy}>
              <Text style={styles.type}>{memoryTypeLabel(memory.type)}</Text>
              <Text style={styles.audience}>
                {memoryAudienceLabel(memory, memoryMode, viewer?.handle)}
              </Text>
            </View>
          </View>

          {memoryMode === "scope" ? (
            <View style={styles.contextNotice}>
              <Ionicons name="shield-checkmark-outline" size={18} color={t.color.text.muted} />
              <Text style={styles.contextNoticeText}>
                This memory is available only in your current private context.
              </Text>
            </View>
          ) : null}
          {actions.limitation ? <Text style={styles.limitation}>{actions.limitation}</Text> : null}

          <View style={styles.contentCard}>
            <Text style={styles.contentText} selectable>
              {memory.content || "No content"}
            </Text>
          </View>

          <Text style={styles.sectionTitle}>Details</Text>
          <View style={styles.metadataCard}>
            <MetadataRow label="Type" value={memoryTypeLabel(memory.type)} styles={styles} />
            <MetadataRow label="Tier" value={`Tier ${memory.tier}`} styles={styles} />
            <MetadataRow label="Importance" value={`${Math.round(memory.importance * 100)}%`} styles={styles} />
            <MetadataRow label="Created" value={formatMemoryDate(memory.createdAt)} styles={styles} />
            <MetadataRow label="Updated" value={formatMemoryDate(memory.updatedAt)} styles={styles} />
            {memory.demotedAt ? (
              <MetadataRow
                label="Demoted"
                value={`${formatMemoryDate(memory.demotedAt)}${memory.demotedFrom !== null ? ` from tier ${memory.demotedFrom}` : ""}`}
                styles={styles}
              />
            ) : null}
          </View>

          {memoryMode === "namespace" && memory.accessList && memory.accessList.length > 0 ? (
            <>
              <Text style={styles.sectionTitle}>Visible to</Text>
              <View style={styles.metadataCard}>
                {memory.accessList.map((person) => (
                  <View key={person.userHandle} style={styles.personRow}>
                    <View style={styles.personIcon}>
                      <Ionicons name="person-outline" size={16} color={t.color.text.muted} />
                    </View>
                    <Text style={styles.personName}>{person.displayName || person.userHandle}</Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}
          {actions.canManageAccess ? (
            <Pressable
              style={styles.manageAccessButton}
              onPress={() => setAccessVisible(true)}
              accessibilityRole="button"
            >
              <Text style={styles.manageAccessText}>Manage access</Text>
              <Ionicons name="chevron-forward" size={18} color={t.color.brand.accent} />
            </Pressable>
          ) : null}
          {mutationError ? <Text style={styles.mutationError}>{mutationError}</Text> : null}
          {mutating ? <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Updating memory" /> : null}
        </ScrollView>
      ) : null}
      </KeyboardAvoidingView>
      <Modal visible={overflowVisible} transparent animationType="fade" onRequestClose={() => setOverflowVisible(false)}>
        <Pressable
          style={styles.menuBackdrop}
          onPress={() => setOverflowVisible(false)}
          accessible={false}
        >
          <Pressable
            style={styles.actionMenu}
            onPress={(event) => event.stopPropagation()}
            accessible={false}
          >
            {actions.canEdit ? <Pressable style={styles.menuRow} onPress={beginEdit}><Text style={styles.menuText}>Edit memory</Text></Pressable> : null}
            {actions.canArchive ? <Pressable style={styles.menuRow} onPress={archive}><Text style={styles.menuText}>Archive</Text></Pressable> : null}
            {actions.canDelete ? <Pressable style={styles.menuRow} onPress={() => hardDelete()}><Text style={styles.deleteText}>Delete memory</Text></Pressable> : null}
          </Pressable>
        </Pressable>
      </Modal>
      {memory && actions.canManageAccess ? (
        <ManageAccessSheet
          visible={accessVisible}
          memoryId={id ?? ""}
          accessList={memory.accessList ?? []}
          currentUserHandle={viewer?.handle}
          onClose={() => setAccessVisible(false)}
          onChanged={loadMemory}
        />
      ) : null}
    </View>
  );
}

function MetadataRow({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.metadataRow}>
      <Text style={styles.metadataLabel}>{label}</Text>
      <Text style={styles.metadataValue}>{value}</Text>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    body: { flex: 1, minHeight: 0 },
    content: { padding: t.spacing.lg, paddingBottom: t.spacing.xxl, gap: t.spacing.md },
    hero: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.md,
      paddingVertical: t.spacing.sm,
    },
    typeIcon: {
      width: 48,
      height: 48,
      borderRadius: 24,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.color.surface.element,
    },
    heroCopy: { flex: 1, gap: t.spacing.xs },
    type: { color: t.color.text.foreground, ...t.typography.heading },
    audience: { color: t.color.text.muted, ...t.typography.body },
    contextNotice: {
      flexDirection: "row",
      gap: t.spacing.sm,
      alignItems: "flex-start",
      padding: t.spacing.md,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.subtle,
    },
    contextNoticeText: { flex: 1, color: t.color.text.muted, ...t.typography.caption },
    limitation: {
      color: t.color.text.muted,
      paddingHorizontal: t.spacing.sm,
      ...t.typography.caption,
    },
    contentCard: {
      padding: t.spacing.lg,
      borderRadius: t.radii.lg,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.element,
    },
    contentText: { color: t.color.text.foreground, ...t.typography.body },
    sectionTitle: { marginTop: t.spacing.sm, color: t.color.text.foreground, ...t.typography.subheading },
    metadataCard: {
      borderRadius: t.radii.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.element,
      overflow: "hidden",
    },
    metadataRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      gap: t.spacing.md,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm + 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
    },
    metadataLabel: { color: t.color.text.muted, ...t.typography.caption },
    metadataValue: { flex: 1, textAlign: "right", color: t.color.text.foreground, ...t.typography.caption },
    personRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm + 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
    },
    personIcon: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.color.surface.subtle,
    },
    personName: { color: t.color.text.foreground, ...t.typography.body },
    manageAccessButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      padding: t.spacing.md,
      borderRadius: t.radii.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.element,
    },
    manageAccessText: { color: t.color.brand.accent, ...t.typography.bodyStrong },
    mutationError: {
      padding: t.spacing.md,
      borderRadius: t.radii.md,
      color: t.color.status.error,
      backgroundColor: t.color.surface.subtle,
      ...t.typography.caption,
    },
    editHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingBottom: t.spacing.sm,
    },
    cancelText: { color: t.color.text.muted, ...t.typography.label },
    saveText: { color: t.color.brand.accent, ...t.typography.label },
    fieldLabel: { color: t.color.text.foreground, ...t.typography.label },
    contentInput: {
      minHeight: 180,
      padding: t.spacing.md,
      borderRadius: t.radii.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      color: t.color.text.foreground,
      backgroundColor: t.color.surface.element,
      ...t.typography.body,
    },
    importanceRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: t.spacing.md },
    importanceDot: {
      width: 28,
      height: 28,
      borderRadius: 14,
      borderWidth: 2,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.element,
    },
    importanceDotActive: { borderColor: t.color.brand.accent, backgroundColor: t.color.brand.accent },
    menuBackdrop: {
      flex: 1,
      justifyContent: "flex-start",
      alignItems: "flex-end",
      paddingTop: 76,
      paddingRight: t.spacing.lg,
      backgroundColor: "rgba(0,0,0,0.2)",
    },
    actionMenu: {
      minWidth: 210,
      overflow: "hidden",
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.panel,
      borderWidth: 1,
      borderColor: t.color.border.default,
    },
    menuRow: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.md },
    menuText: { color: t.color.text.foreground, ...t.typography.body },
    deleteText: { color: t.color.status.error, ...t.typography.body },
    stateWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: t.spacing.sm,
      padding: t.spacing.xl,
    },
    stateTitle: { color: t.color.text.foreground, ...t.typography.subheading },
    stateSub: { color: t.color.text.muted, textAlign: "center", ...t.typography.body },
    retryButton: {
      marginTop: t.spacing.sm,
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.sm,
      borderRadius: t.radii.pill,
      borderWidth: 1,
      borderColor: t.color.border.default,
    },
    retryText: { color: t.color.text.foreground, ...t.typography.label },
  });
}
