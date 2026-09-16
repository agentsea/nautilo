// D369 Phase 7 — in-room ApprovalCard. Renders the reason line + the
// tool list (`event.tools` → name + compact args summary) + one button
// per verb in `allowedVerbs`. Mirrors the desktop dock's approval
// dialog, RN-native. On tap → `useAttention().replyToApproval(...)`;
// spinner while in flight; recoverable error row on failure (the card
// stays mounted so the user can retry). On success the provider clears
// the approval → the card unmounts.
//
// Verb label mapping (per the phase-7 contract):
//   once   → "Once"
//   room   → "This room"
//   always → "Always"
//   deny   → "No"
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useAttention } from "@/providers/attention";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type {
  ApprovalAskEvent,
  ApprovalReplyVerb,
  LocalMcpInstallApproval,
  ShareMemoryApprovalPreview,
  StructuredSshApproval,
} from "@nautilo/types";

const VERB_LABELS: Record<ApprovalReplyVerb, string> = {
  once: "Once",
  room: "This room",
  always: "Always",
  deny: "No",
};

const DENY_VERB: ApprovalReplyVerb = "deny";

const VERB_ACCESSIBILITY_LABELS: Record<ApprovalReplyVerb, string> = {
  once: "Approve once",
  room: "Approve for this room",
  always: "Always approve",
  deny: "Deny",
};

type ApprovalCardProps = {
  approval: ApprovalAskEvent;
};

function ProjectionMemoryDetail({ preview }: { preview: ShareMemoryApprovalPreview }) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const projection = preview.projection;
  if (!projection) return null;

  return (
    <View
      style={styles.projection}
      accessibilityLabel="New Memory copy approval details"
    >
      <Text style={styles.projectionTitle}>A NEW Memory copy will be created</Text>
      <Text style={styles.projectionDestination}>
        Destination Room: {projection.roomLabel} · {projection.roomKind.replaceAll("_", " ")} · {projection.memberCount} visible {projection.memberCount === 1 ? "member" : "members"}
      </Text>
      <Text style={styles.projectionContentLabel}>Exact projected Memory content</Text>
      <ScrollView
        style={styles.projectionContentScroll}
        contentContainerStyle={styles.projectionContentContainer}
        nestedScrollEnabled
        accessibilityLabel="Exact projected Memory content"
      >
        <Text selectable style={styles.projectionContent}>{projection.content}</Text>
      </ScrollView>
      {projection.audienceWarning ? (
        <Text style={styles.projectionWarning} accessibilityLabel="Destination audience warning">
          {projection.audienceWarning}
        </Text>
      ) : null}
    </View>
  );
}

function LocalMcpInstallDetail({ approval }: { approval: LocalMcpInstallApproval }) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const preview = approval.preview;
  const argv = preview.transport.kind === "stdio"
    ? [preview.transport.command, ...preview.transport.args]
    : [preview.transport.url];
  return (
    <View style={styles.localMcp} accessibilityLabel="Exact local MCP install effect">
      <Text style={styles.localMcpTitle}>Exact local MCP effect: {preview.name}</Text>
      <Text style={styles.localMcpLine}>Human: {preview.human} · Machine: {preview.machine} · Relay: {preview.relayId}</Text>
      {preview.transport.kind === "stdio"
        ? argv.map((entry, index) => <Text key={`${index}:${entry}`} selectable style={styles.localMcpCode}>argv[{index}]={JSON.stringify(entry)}</Text>)
        : <Text selectable style={styles.localMcpCode}>streamableHttpUrl={JSON.stringify(argv[0])}</Text>}
      <Text selectable style={styles.localMcpLine}>Source: {preview.source.label}{preview.source.url ? ` (${preview.source.url})` : ""}</Text>
      <Text style={styles.localMcpLine}>Package evidence: {preview.package ? `${preview.package.name}@${preview.package.version ?? "unversioned"}` : "none"}</Text>
      {preview.mayDownloadOnFirstRun ? <Text style={styles.localMcpWarning}>First launch may download executable code.</Text> : null}
      {preview.unpinnedPackage ? <Text style={styles.localMcpWarning}>Package version is not pinned.</Text> : null}
      <Text style={styles.localMcpLine}>Environment names: {preview.environment.length ? preview.environment.map((env) => `${env.name}=${env.present ? "present" : "missing"}`).join(", ") : "none"}</Text>
      <Text style={styles.localMcpLine}>Availability: {preview.availabilitySummary}</Text>
      {preview.subprocessSandboxed === false
        ? <Text style={styles.localMcpWarning}>Subprocess sandbox: NOT sandboxed.</Text>
        : <Text style={styles.localMcpLine}>Local subprocess: none (HTTP transport).</Text>}
      <Text selectable style={styles.localMcpCode}>Approval digest: {approval.digest}</Text>
    </View>
  );
}

function StructuredSshDetail({ approval }: { approval: StructuredSshApproval }) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return (
    <View style={styles.localMcp} accessibilityLabel="Exact structured SSH approval">
      <Text style={styles.localMcpTitle}>Exact structured SSH operation</Text>
      <Text style={styles.localMcpLine}>Host: {approval.host}:{approval.port}</Text>
      <Text style={styles.localMcpLine}>Remote user: {approval.remoteUser}</Text>
      <Text selectable style={styles.localMcpCode}>Host key: {approval.hostKeyFingerprint}</Text>
      <Text style={styles.localMcpLine}>Host trust: {approval.hostTrust}</Text>
      {approval.previousHostKeyFingerprint
        ? <Text selectable style={styles.localMcpWarning}>Previous host key: {approval.previousHostKeyFingerprint}</Text>
        : null}
      <Text style={styles.localMcpLine}>Operation: {approval.operation}</Text>
      {approval.program
        ? <Text selectable style={styles.localMcpCode}>argv={JSON.stringify([approval.program, ...(approval.argv ?? [])])}</Text>
        : null}
      {approval.localPath
        ? <Text selectable style={styles.localMcpCode}>localPath={JSON.stringify(approval.localPath)}</Text>
        : null}
      {approval.remotePath
        ? <Text selectable style={styles.localMcpCode}>remotePath={JSON.stringify(approval.remotePath)}</Text>
        : null}
      <Text selectable style={styles.localMcpCode}>Request digest: {approval.approvedRequestDigest}</Text>
    </View>
  );
}

export function ApprovalCard({ approval }: ApprovalCardProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { replyToApproval } = useAttention();
  const [pendingVerb, setPendingVerb] = useState<ApprovalReplyVerb | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleReply = async (verb: ApprovalReplyVerb): Promise<void> => {
    if (pendingVerb) return;
    setPendingVerb(verb);
    setError(null);
    const res = await replyToApproval(approval, verb);
    if (!res.ok) {
      setError("Could not send response. Try again.");
      setPendingVerb(null);
    }
    // success → provider drops the approval → this card unmounts
  };

  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>Approval requested</Text>
      <Text style={styles.reason}>{approval.reason}</Text>

      {approval.requiresExplicitReview && approval.localMcpInstall
        ? <LocalMcpInstallDetail approval={approval.localMcpInstall} />
        : null}
      {approval.requiresExplicitReview && approval.structuredSsh
        ? <StructuredSshDetail approval={approval.structuredSsh} />
        : null}
      {approval.requiresExplicitReview && !approval.localMcpInstall && !approval.structuredSsh
        ? <Text style={styles.error} accessibilityRole="alert">Exact review details are unavailable. This action cannot be approved from this client.</Text>
        : null}

      {approval.tools.length > 0 ? (
        <View style={styles.tools}>
          {approval.tools.map((tool, i) => (
            tool.name === "share_memory" && tool.shareMemoryPreview?.projection ? (
              <ProjectionMemoryDetail
                key={`${tool.name}-${i}`}
                preview={tool.shareMemoryPreview}
              />
            ) : (
              <View key={`${tool.name}-${i}`} style={styles.toolRow}>
                <Text style={styles.toolName} numberOfLines={1}>
                  {tool.name}
                </Text>
                {Object.keys(tool.args).length > 0 ? (
                  <Text style={styles.toolArgs} numberOfLines={2}>
                    {formatArgs(tool.args)}
                  </Text>
                ) : null}
              </View>
            )
          ))}
        </View>
      ) : null}

      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}

      <View style={styles.actions}>
        {approval.allowedVerbs.map((verb) => {
          const isDeny = verb === DENY_VERB;
          const isPending = pendingVerb === verb;
          const anyPending = pendingVerb !== null;
          return (
            <Pressable
              key={verb}
              style={[
                styles.button,
                isDeny ? styles.denyButton : styles.approveButton,
              ]}
              disabled={anyPending}
              onPress={() => void handleReply(verb)}
              accessibilityRole="button"
              accessibilityLabel={isPending ? `${VERB_ACCESSIBILITY_LABELS[verb]}, sending` : VERB_ACCESSIBILITY_LABELS[verb]}
              accessibilityState={{ disabled: anyPending, busy: isPending }}
            >
              {isPending ? (
                <ActivityIndicator
                  size="small"
                  color={isDeny ? t.color.status.error : t.color.text.foreground}
                />
              ) : (
                <Text
                  style={[
                    styles.buttonText,
                    isDeny ? styles.denyText : styles.approveText,
                    anyPending ? styles.buttonTextMuted : null,
                  ]}
                >
                  {VERB_LABELS[verb]}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Compact `key=value` rendering; long values truncated per arg. */
function formatArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    let s: string;
    if (typeof v === "string") s = v;
    else if (v === null) s = "null";
    else if (v === undefined) s = "undefined";
    else {
      try {
        s = JSON.stringify(v) ?? "[unserializable]";
      } catch {
        s = "[unserializable]";
      }
    }
    if (s.length > 80) s = s.slice(0, 77) + "…";
    parts.push(`${k}=${s}`);
  }
  return parts.join("  ");
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    card: {
      marginHorizontal: t.spacing.md,
      marginBottom: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.md,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.element,
      borderWidth: 1,
      borderColor: t.color.status.warning,
    },
    eyebrow: {
      ...t.typography.caption,
      color: t.color.text.foreground,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.4,
    },
    reason: {
      marginTop: t.spacing.xs,
      ...t.typography.bodyStrong,
      color: t.color.text.foreground,
      lineHeight: 19,
    },
    tools: { marginTop: t.spacing.sm, gap: t.spacing.xs },
    localMcp: {
      marginTop: t.spacing.sm,
      paddingLeft: t.spacing.sm,
      borderLeftWidth: 2,
      borderLeftColor: t.color.status.warning,
      gap: t.spacing.xs,
    },
    localMcpTitle: { ...t.typography.label, color: t.color.text.foreground },
    localMcpLine: { ...t.typography.caption, color: t.color.text.muted, lineHeight: 18 },
    localMcpCode: { ...t.typography.caption, color: t.color.text.foreground, fontFamily: "monospace", lineHeight: 18 },
    localMcpWarning: { ...t.typography.caption, color: t.color.text.foreground, lineHeight: 18 },
    toolRow: {
      paddingLeft: t.spacing.sm,
      borderLeftWidth: 2,
      borderLeftColor: t.color.status.warning,
    },
    toolName: { ...t.typography.label, color: t.color.text.foreground },
    toolArgs: {
      ...t.typography.caption,
      color: t.color.text.muted,
      fontFamily: "monospace",
    },
    projection: {
      paddingLeft: t.spacing.sm,
      borderLeftWidth: 2,
      borderLeftColor: t.color.status.warning,
      gap: t.spacing.xs,
    },
    projectionTitle: { ...t.typography.label, color: t.color.text.foreground },
    projectionDestination: { ...t.typography.caption, color: t.color.text.muted, lineHeight: 18 },
    projectionContentLabel: { ...t.typography.caption, color: t.color.text.foreground, fontWeight: "700" },
    projectionContentScroll: {
      maxHeight: 180,
      borderRadius: t.radii.sm,
      backgroundColor: t.color.surface.subtle,
    },
    projectionContentContainer: { paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.sm },
    projectionContent: { ...t.typography.caption, color: t.color.text.foreground, lineHeight: 18 },
    projectionWarning: { ...t.typography.caption, color: t.color.text.foreground, lineHeight: 18 },
    error: {
      marginTop: t.spacing.sm,
      ...t.typography.caption,
      color: t.color.status.error,
    },
    actions: {
      marginTop: t.spacing.sm + 2,
      flexDirection: "row",
      flexWrap: "wrap",
      gap: t.spacing.sm,
    },
    button: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderRadius: t.radii.pill,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    approveButton: { backgroundColor: t.color.action.primaryMuted },
    denyButton: { backgroundColor: t.color.surface.subtle },
    buttonText: { ...t.typography.caption, fontWeight: "700" },
    approveText: { color: t.color.text.foreground },
    denyText: { color: t.color.status.error },
    buttonTextMuted: { opacity: 0.5 },
  });
}
