import { useNavigation } from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

import {
  canSaveArtifactEditor,
  createArtifactEditorExitCoordinator,
  initialArtifactEditorLifecycle,
  markArtifactEditorClean,
  markArtifactEditorDirty,
  type ArtifactEditorLifecycle,
  type ArtifactEditorPhase,
  type ArtifactEditorSaveState,
} from "./artifact-editor-lifecycle";

export type ArtifactEditorControls = {
  dirty: boolean;
  markDirty: () => void;
  markClean: () => void;
};

export type ArtifactEditorShellPhase =
  | { kind: "loading" }
  | { kind: "error"; message: string; onRetry: () => void }
  | { kind: "ready" };

type Slot = ReactNode | ((controls: ArtifactEditorControls) => ReactNode);

export type ArtifactEditorShellProps = {
  title: string;
  sessionKey: string;
  phase: ArtifactEditorShellPhase;
  saveState?: ArtifactEditorSaveState;
  onSave?: (controls: ArtifactEditorControls) => void;
  onBack: () => void;
  onDiscard?: () => void;
  saveNotice?: {
    message: string;
    onRetry?: () => void;
    actions?: Array<{ label: string; onPress: () => void; disabled?: boolean }>;
  };
  toolbar?: Slot;
  children?: Slot;
};

function lifecyclePhase(phase: ArtifactEditorShellPhase): ArtifactEditorPhase {
  return phase.kind;
}

function renderSlot(
  slot: Slot | undefined,
  controls: ArtifactEditorControls,
): ReactNode {
  return typeof slot === "function" ? slot(controls) : slot;
}

export function ArtifactEditorShell({
  title,
  sessionKey,
  phase,
  saveState = "unavailable",
  onSave,
  onBack,
  onDiscard,
  saveNotice,
  toolbar,
  children,
}: ArtifactEditorShellProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [lifecycle, setLifecycle] = useState<ArtifactEditorLifecycle>(
    initialArtifactEditorLifecycle,
  );
  const exitCoordinatorRef = useRef(createArtifactEditorExitCoordinator());

  useEffect(() => {
    setLifecycle({ phase: lifecyclePhase(phase), dirty: false });
    exitCoordinatorRef.current.reset();
  }, [phase.kind, sessionKey]);

  const markDirty = useCallback(() => {
    setLifecycle((current) => markArtifactEditorDirty(current));
  }, []);
  const markClean = useCallback(() => {
    setLifecycle((current) => markArtifactEditorClean(current));
  }, []);
  const controls = useMemo<ArtifactEditorControls>(
    () => ({
      dirty: lifecycle.dirty,
      markDirty,
      markClean,
    }),
    [lifecycle.dirty, markClean, markDirty],
  );

  const exitEffects = useMemo(
    () => ({
      present: ({
        keepEditing,
        discardChanges,
      }: {
        keepEditing: () => void;
        discardChanges: () => void;
      }) =>
        Alert.alert("Discard changes?", "Your unsaved changes will be lost.", [
          { text: "Keep editing", style: "cancel", onPress: keepEditing },
          {
            text: "Discard changes",
            style: "destructive",
            onPress: discardChanges,
          },
        ]),
      markClean,
      ...(onDiscard ? { onDiscard } : {}),
    }),
    [markClean, onDiscard],
  );

  const requestExit = useCallback(
    (proceed: () => void) => {
      exitCoordinatorRef.current.request(lifecycle, proceed, exitEffects);
    },
    [exitEffects, lifecycle],
  );

  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        exitCoordinatorRef.current.intercept(
          lifecycle,
          {
            preventDefault: () => event.preventDefault(),
            action: event.data.action,
          },
          (action) => navigation.dispatch(action as typeof event.data.action),
          exitEffects,
        );
      }),
    [exitEffects, lifecycle, navigation],
  );

  const saveEnabled = canSaveArtifactEditor(
    lifecycle,
    saveState,
    onSave !== undefined,
  );
  const saveAction = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Save file"
      accessibilityState={{
        disabled: !saveEnabled,
        busy: saveState === "saving",
      }}
      disabled={!saveEnabled}
      onPress={() => onSave?.(controls)}
      style={!saveEnabled ? styles.disabled : undefined}
    >
      <Text style={styles.actionText}>
        {saveState === "saving" ? "Saving…" : "Save"}
      </Text>
    </Pressable>
  );
  const appBar = (
    <AppBar
      title={title}
      left={<AppBarBackButton onPress={() => requestExit(onBack)} />}
      rightExtra={saveAction}
      showOverflow={false}
    />
  );

  if (phase.kind === "loading") {
    return (
      <View style={styles.root}>
        {appBar}
        <View style={styles.status} accessibilityLabel="Loading editor">
          <ActivityIndicator color={theme.color.brand.accent} />
          <Text style={styles.statusText}>Loading file…</Text>
        </View>
      </View>
    );
  }

  if (phase.kind === "error") {
    return (
      <View style={styles.root}>
        {appBar}
        <View style={styles.status} accessibilityLabel="Editor error">
          <Text style={styles.statusText}>{phase.message}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading file"
            onPress={phase.onRetry}
            style={styles.retry}
          >
            <Text style={styles.actionText}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.root}>
      {appBar}
      {saveNotice ? (
        <View
          accessibilityRole="alert"
          accessibilityLabel="Save status"
          style={styles.notice}
        >
          <Text style={styles.statusText}>{saveNotice.message}</Text>
          <View style={styles.noticeActions}>
            {saveNotice.onRetry ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry save"
                onPress={saveNotice.onRetry}
              >
                <Text style={styles.actionText}>Retry</Text>
              </Pressable>
            ) : null}
            {saveNotice.actions?.map((action) => (
              <Pressable
                key={action.label}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                accessibilityState={{ disabled: action.disabled === true }}
                disabled={action.disabled}
                onPress={action.onPress}
              >
                <Text style={styles.actionText}>{action.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      <View style={styles.frame} accessibilityLabel="Editor">
        {renderSlot(children, controls)}
      </View>
      {toolbar ? (
        <View accessibilityLabel="Editor toolbar">
          {renderSlot(toolbar, controls)}
        </View>
      ) : null}
      <View style={{ paddingBottom: insets.bottom }} />
    </KeyboardAvoidingView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      flex: 1,
      minHeight: 0,
      backgroundColor: theme.color.surface.background,
    },
    frame: { flex: 1, minHeight: 0 },
    status: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.md,
      padding: theme.spacing.xl,
    },
    statusText: {
      ...theme.typography.body,
      color: theme.color.text.muted,
      textAlign: "center",
    },
    actionText: {
      ...theme.typography.label,
      color: theme.color.text.foreground,
    },
    retry: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: theme.spacing.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.color.border.default,
      borderRadius: theme.radii.md,
    },
    disabled: { opacity: 0.5 },
    notice: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
      gap: theme.spacing.xs,
    },
    noticeActions: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.lg,
    },
  });
}
