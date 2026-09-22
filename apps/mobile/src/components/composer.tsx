import { Feather, Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAppTheme } from '@/providers/theme';
import type { AppTheme } from '@/theme/tokens';
import {
  activeCommandQuery,
  filterCommands,
  insertCommand,
} from '@/features/commands/command-discovery';
import { useCommandCatalogue } from '@/features/commands/use-command-catalogue';

// Drag the mic this far left (px) mid-hold to arm cancel; release past it discards.
const CANCEL_SLIDE_THRESHOLD = 80;

type ComposerProps = {
  onSend: (text: string) => void | Promise<boolean>;
  /** Optional controlled text for process-death-safe Room drafts. */
  value?: string;
  onChangeText?: (text: string) => void;
  onDiscardDraft?: () => void;
  /** Active server identity scopes the authoritative command catalogue. */
  serverUrl?: string;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Compact context control anchored at the start of the stable action row
   * (the screen passes the model selector here). Rendered as-is.
   */
  controls?: ReactNode;
  /** Leading action integrated into the message entry surface. */
  attachSlot?: ReactNode;
  attachmentsSlot?: ReactNode;
  hasAttachments?: boolean;
  /**
   * When true, a turn is in-flight and the spatially stable Stop control is
   * active; while idle the same control remains visible but disabled.
   */
  busy?: boolean;
  onStop?: () => void;
  /**
   * Push-to-talk voice input (Signal-style), SEPARATE from the send button
   * (send never morphs). Rendered only when `voiceInputAvailable`. The composer
   * owns the gesture + the recording overlay; the screen owns the recorder /
   * STT / send via these callbacks:
   *  - `onMicStart`   — press-in: begin recording.
   *  - `onMicRelease` — released without cancelling: transcribe + auto-send.
   *  - `onMicCancel`  — slid left past the cancel threshold (or interrupted): discard.
   */
  voiceInputAvailable?: boolean;
  onMicStart?: () => void;
  onMicRelease?: () => void;
  onMicCancel?: () => void;
  /** Canonical Room-member handles offered after a trailing `@` token. */
  mentionCandidates?: readonly ComposerMentionCandidate[];
};

export type ComposerMentionCandidate = {
  actorId: string;
  kind: "user" | "agent" | "audience";
  displayName: string;
  handle: string;
};

function activeMentionQuery(text: string): { start: number; query: string } | null {
  const match = /(^|\s)@([A-Za-z0-9_]*)$/.exec(text);
  if (!match) return null;
  return { start: text.length - (match[2]?.length ?? 0) - 1, query: match[2] ?? "" };
}

export function Composer({
  onSend,
  value,
  onChangeText,
  onDiscardDraft,
  serverUrl,
  placeholder = 'Message',
  disabled = false,
  controls,
  attachSlot,
  attachmentsSlot,
  hasAttachments = false,
  busy = false,
  onStop,
  voiceInputAvailable = false,
  onMicStart,
  onMicRelease,
  onMicCancel,
  mentionCandidates = [],
}: ComposerProps) {
  const [uncontrolledText, setUncontrolledText] = useState('');
  const text = value ?? uncontrolledText;
  const setText = useCallback((next: string) => {
    if (value === undefined) setUncontrolledText(next);
    onChangeText?.(next);
  }, [onChangeText, value]);
  const inputRef = useRef<TextInput>(null);
  const trimmed = text.trim();
  const canSend = !disabled && (trimmed.length > 0 || hasAttachments);
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const activeCommand = activeCommandQuery(text);
  const commandCatalogue = useCommandCatalogue(serverUrl);
  const commandMatches = useMemo(
    () => (activeCommand ? filterCommands(commandCatalogue.commands, activeCommand.query) : []),
    [activeCommand, commandCatalogue.commands],
  );
  const activeMention = activeMentionQuery(text);
  const mentionMatches = useMemo(() => {
    if (!activeMention) return [];
    const query = activeMention.query.toLowerCase();
    return mentionCandidates.filter((candidate) =>
      !query ||
      candidate.handle.startsWith(query) ||
      candidate.displayName.toLowerCase().includes(query),
    ).slice(0, 6);
  }, [activeMention?.query, mentionCandidates]);

  // ---- Push-to-talk (Signal-style hold / slide-to-cancel / release-to-send) ----
  const [recording, setRecording] = useState(false);
  const [cancelArmed, setCancelArmed] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const cancelArmedRef = useRef(false);
  cancelArmedRef.current = cancelArmed;
  // Latest callbacks in a ref so the once-created PanResponder never goes stale.
  const micCbRef = useRef({ onMicStart, onMicRelease, onMicCancel });
  micCbRef.current = { onMicStart, onMicRelease, onMicCancel };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      // Once the hold starts, keep the gesture — don't let a parent scroll /
      // drawer pan steal it mid-drag (that's what made the page slide sideways).
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: () => {
        setRecording(true);
        setCancelArmed(false);
        cancelArmedRef.current = false;
        setSeconds(0);
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
        micCbRef.current.onMicStart?.();
      },
      onPanResponderMove: (_e, g) => {
        const armed = g.dx < -CANCEL_SLIDE_THRESHOLD;
        if (armed !== cancelArmedRef.current) {
          cancelArmedRef.current = armed;
          setCancelArmed(armed);
        }
      },
      onPanResponderRelease: () => {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        setRecording(false);
        if (cancelArmedRef.current) micCbRef.current.onMicCancel?.();
        else micCbRef.current.onMicRelease?.();
      },
      onPanResponderTerminate: () => {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        setRecording(false);
        micCbRef.current.onMicCancel?.();
      },
    }),
  ).current;

  const submit = useCallback(async () => {
    if (!canSend) return;
    const sent = await onSend(trimmed);
    if (sent !== false && mountedRef.current) setText('');
  }, [canSend, onSend, trimmed]);

  const handleSubmitEditing = useCallback(
    async () => {
      const value = text.trim();
      if (disabled || value.length === 0) return;
      const sent = await onSend(value);
      if (sent !== false && mountedRef.current) setText('');
    },
    [disabled, onSend, text],
  );

  const handleStop = useCallback(() => {
    if (onStop) onStop();
  }, [onStop]);

  const chooseCommand = useCallback((name: string) => {
    setText(insertCommand(text, { name }));
    // Pressing a suggestion must not dismiss the native keyboard; command
    // arguments continue in the same shared composer, alongside voice input.
    inputRef.current?.focus();
  }, [setText, text]);

  const chooseMention = useCallback((candidate: ComposerMentionCandidate) => {
    const active = activeMentionQuery(text);
    if (!active) return;
    setText(`${text.slice(0, active.start)}@${candidate.handle} `);
    inputRef.current?.focus();
  }, [setText, text]);

  const timeLabel = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <View style={styles.container}>
      {attachmentsSlot}
      <View style={styles.inputSurface}>
        {attachSlot ? <View style={styles.inputLeadingAction}>{attachSlot}</View> : null}
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={t.color.text.dim}
          editable={!disabled}
          multiline
          returnKeyType="send"
          blurOnSubmit={false}
          onSubmitEditing={() => void handleSubmitEditing()}
        />
      </View>
      {text.length > 0 && onDiscardDraft ? <Pressable onPress={onDiscardDraft} accessibilityRole="button" accessibilityLabel="Discard draft"><Text style={styles.discardDraft}>Discard draft</Text></Pressable> : null}
      {activeCommand ? (
        <View style={styles.commandPicker} accessibilityLiveRegion="polite">
          {commandCatalogue.loading ? (
            <Text style={styles.commandStatus}>Loading commands…</Text>
          ) : commandCatalogue.error ? (
            <View style={styles.commandErrorRow}>
              <Text style={styles.commandStatus}>Couldn’t load commands.</Text>
              <Pressable
                onPress={commandCatalogue.retry}
                accessibilityRole="button"
                accessibilityLabel="Retry loading commands">
                <Text style={styles.commandRetry}>Retry</Text>
              </Pressable>
            </View>
          ) : commandMatches.length === 0 ? (
            <Text style={styles.commandStatus}>No enabled commands match.</Text>
          ) : (
            commandMatches.map((command) => (
              <Pressable
                key={command.name}
                style={styles.commandRow}
                onPress={() => chooseCommand(command.name)}
                accessibilityRole="button"
                accessibilityLabel={`Use command ${command.name}`}>
                <Text style={styles.commandName}>/{command.name}</Text>
                <Text style={styles.commandDescription} numberOfLines={1}>
                  {command.description}
                </Text>
              </Pressable>
            ))
          )}
        </View>
      ) : null}
      {activeMention ? (
        <View style={styles.mentionPicker} accessibilityLiveRegion="polite">
          {mentionMatches.length === 0 ? (
            <Text style={styles.mentionStatus}>No matching people in this conversation.</Text>
          ) : (
            mentionMatches.map((candidate) => (
              <Pressable
                key={candidate.actorId}
                style={styles.mentionRow}
                onPress={() => chooseMention(candidate)}
                accessibilityRole="button"
                accessibilityLabel={candidate.kind === "audience"
                  ? "Mention everyone — Notify everyone in this room"
                  : `Mention ${candidate.displayName} at ${candidate.handle}`}>
                <View style={styles.mentionAvatar}>
                  {candidate.kind === "audience" ? (
                    <Feather name="users" size={15} color={t.color.text.muted} />
                  ) : (
                    <Text style={styles.mentionInitial}>{candidate.displayName.trim().charAt(0).toUpperCase()}</Text>
                  )}
                </View>
                <View style={styles.mentionCopy}>
                  <Text style={styles.mentionName} numberOfLines={1}>
                    {candidate.kind === "audience" ? "@everyone" : candidate.displayName}
                  </Text>
                  <Text style={styles.mentionHandle} numberOfLines={1}>
                    {candidate.kind === "audience" ? "Notify everyone in this room" : `@${candidate.handle}`}
                  </Text>
                </View>
                {candidate.kind === "audience" ? null : (
                  <Text style={styles.mentionKind}>{candidate.kind === "user" ? "Person" : "Genie"}</Text>
                )}
              </Pressable>
            ))
          )}
        </View>
      ) : null}
      {recording ? (
        <View style={styles.controlRow}>
          {/* While recording, the control row IS the slide-to-cancel track:
            the cue extends left from the held mic (co-located with the finger,
            Signal-style), and the other buttons hide so nothing competes. */}
          <View style={styles.controlsCluster}>
            <View style={styles.recordingHintRow}>
              <View style={styles.recordingDot} />
              <Text style={styles.recordingTime}>{timeLabel}</Text>
              <Text
                style={[
                  styles.recordingHint,
                  cancelArmed && styles.recordingHintArmed,
                ]}
                numberOfLines={1}>
                {cancelArmed ? 'Release to cancel' : '‹ slide to cancel'}
              </Text>
            </View>
          </View>
          {voiceInputAvailable ? (
            <View
              {...panResponder.panHandlers}
              style={[
                styles.micButton,
                styles.micButtonRecording,
                cancelArmed && styles.micButtonCancel,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Hold to talk; slide left to cancel, release to send">
              <Feather name="mic" size={20} color={t.color.text.onPrimary} />
            </View>
          ) : null}
        </View>
      ) : (
        <>
          <View style={styles.actionRow}>
            {controls ? <View style={styles.metadataControl}>{controls}</View> : <View />}
            <View style={styles.rightCluster}>
              <Pressable
                style={[styles.stopButton, !busy && styles.stopButtonIdle]}
                onPress={handleStop}
                disabled={!busy}
                accessibilityRole="button"
                accessibilityLabel="Stop generation"
                accessibilityState={{ disabled: !busy }}>
                <Ionicons
                  name="stop"
                  size={18}
                  color={busy ? t.color.status.error : t.color.text.disabled}
                />
              </Pressable>
              {voiceInputAvailable ? (
                <View
                  {...panResponder.panHandlers}
                  style={styles.micButton}
                  accessibilityRole="button"
                  accessibilityLabel="Hold to talk; slide left to cancel, release to send">
                  <Feather name="mic" size={20} color={t.color.text.muted} />
                </View>
              ) : null}
              <Pressable
                style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
                onPress={() => void submit()}
                disabled={!canSend}
                accessibilityRole="button"
                accessibilityLabel="Send message">
                <Ionicons
                  name="send"
                  size={22}
                  color={canSend ? t.color.text.onPrimary : t.color.text.disabled}
                />
              </Pressable>
            </View>
          </View>
        </>
      )}
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: {
      flexDirection: 'column',
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.color.border.default,
      backgroundColor: t.color.surface.background,
    },
    inputSurface: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'flex-end',
      borderRadius: t.radii.lg,
      backgroundColor: t.color.surface.element,
      overflow: 'hidden',
    },
    inputLeadingAction: {
      minHeight: 48,
      justifyContent: 'flex-end',
    },
    input: {
      flex: 1,
      minHeight: 36,
      maxHeight: 120,
      paddingLeft: t.spacing.xs,
      paddingRight: t.spacing.md,
      paddingVertical: t.spacing.sm,
      ...t.typography.body,
      color: t.color.text.foreground,
    },
    commandPicker: {
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.element,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.border.default,
      overflow: 'hidden',
    },
    mentionPicker: {
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.element,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.border.default,
      overflow: "hidden",
    },
    mentionRow: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
    },
    mentionAvatar: {
      width: 28,
      height: 28,
      borderRadius: t.radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.color.surface.subtle,
    },
    mentionInitial: { ...t.typography.caption, color: t.color.text.muted, fontWeight: "600" },
    mentionCopy: { flex: 1, gap: 1 },
    mentionName: { ...t.typography.caption, color: t.color.text.foreground, fontWeight: "600" },
    mentionHandle: { ...t.typography.caption, color: t.color.text.muted },
    mentionKind: { ...t.typography.caption, color: t.color.text.dim },
    mentionStatus: {
      ...t.typography.caption,
      color: t.color.text.muted,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
    },
    discardDraft: { ...t.typography.caption, color: t.color.text.muted, textAlign: "right" },
    commandRow: {
      minHeight: 44,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      justifyContent: 'center',
      gap: 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
    },
    commandName: {
      ...t.typography.body,
      color: t.color.text.foreground,
      fontWeight: '600',
    },
    commandDescription: {
      ...t.typography.body,
      color: t.color.text.muted,
    },
    commandStatus: {
      ...t.typography.body,
      color: t.color.text.muted,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
    },
    commandErrorRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    commandRetry: {
      ...t.typography.body,
      color: t.color.brand.accent,
      fontWeight: '600',
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
    },
    recordingHintRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      flexShrink: 1,
    },
    recordingDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: t.color.status.error,
    },
    recordingTime: {
      ...t.typography.body,
      color: t.color.text.foreground,
      fontVariant: ['tabular-nums'],
    },
    recordingHint: {
      ...t.typography.body,
      color: t.color.text.muted,
      flexShrink: 1,
    },
    recordingHintArmed: {
      color: t.color.status.error,
    },
    controlRow: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.spacing.sm,
    },
    metadataControl: {
      flex: 1,
      minWidth: 0,
      maxWidth: 210,
      minHeight: 40,
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: t.radii.pill,
      backgroundColor: t.color.surface.element,
      overflow: 'hidden',
    },
    actionRow: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.spacing.sm,
    },
    controlsCluster: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.md,
      flexShrink: 1,
    },
    rightCluster: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
    },
    sendButton: {
      width: 44,
      height: 44,
      borderRadius: t.radii.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.color.action.primaryBg,
    },
    sendButtonDisabled: {
      backgroundColor: t.color.surface.subtle,
    },
    // Separate always-present hold-to-talk mic (does NOT replace send).
    micButton: {
      width: 44,
      height: 44,
      borderRadius: t.radii.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.color.surface.element,
      borderWidth: 1,
      borderColor: t.color.border.default,
    },
    micButtonRecording: {
      backgroundColor: t.color.status.error,
      borderColor: t.color.status.error,
    },
    micButtonCancel: {
      opacity: 0.6,
    },
    // Stop is spatially stable: muted while idle, active in the same position.
    stopButton: {
      width: 44,
      height: 44,
      borderRadius: t.radii.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.color.surface.element,
      borderWidth: 1,
      borderColor: t.color.status.error,
    },
    stopButtonIdle: {
      borderColor: t.color.border.default,
      opacity: 0.55,
    },
  });
}
