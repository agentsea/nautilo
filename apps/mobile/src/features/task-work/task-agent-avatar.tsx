import { Image } from "expo-image";
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { loadAssetBearer } from "@/lib/asset-bearer";
import { taskAgentAvatarPath } from "@/lib/task-agent-avatar";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

import {
  shouldRenderTaskAgentAvatarImage,
  taskAgentAvatarTokenLoaded,
  type TaskAgentAvatarRenderState,
} from "./task-work-strip-presentation";

type TaskAgentAvatarProps = {
  readonly serverUrl: string;
  readonly taskId: string;
  readonly size?: number;
  /** Server-authorized summary identity, used only to name this exact portrait. */
  readonly agentName?: string | null;
};

/**
 * The Task route resolves the exact assigned Genie, including orphan Tasks.
 * It deliberately does not reuse room/member avatar routing or initials.
 */
export function TaskAgentAvatar({ serverUrl, taskId, size = 32, agentName }: TaskAgentAvatarProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t, size), [size, t]);
  const scopeKey = `${serverUrl}\u0000${taskId}`;
  const latestScopeRef = useRef(scopeKey);
  latestScopeRef.current = scopeKey;
  const [renderState, setRenderState] = useState<TaskAgentAvatarRenderState>(() => ({
    scopeKey,
    headers: undefined,
    imageFailed: false,
  }));

  useEffect(() => {
    let cancelled = false;
    setRenderState({ scopeKey, headers: undefined, imageFailed: false });
    void loadAssetBearer(serverUrl).then((token) => {
      if (cancelled || latestScopeRef.current !== scopeKey) return;
      setRenderState((current) => taskAgentAvatarTokenLoaded(current, scopeKey, token));
    }).catch(() => {
      if (cancelled || latestScopeRef.current !== scopeKey) return;
      setRenderState((current) => current.scopeKey === scopeKey ? { ...current, imageFailed: true } : current);
    });
    return () => { cancelled = true; };
  }, [scopeKey, serverUrl]);

  if (!shouldRenderTaskAgentAvatarImage(renderState, scopeKey)) {
    return (
      <View accessible accessibilityRole="image" style={styles.shell} accessibilityLabel={`${agentName?.trim() || "Assigned Genie"} shell avatar`}>
        <Text accessible={false} allowFontScaling={false} style={styles.shellGlyph}>🐚</Text>
      </View>
    );
  }

  const baseUrl = serverUrl.replace(/\/+$/, "");
  return (
    <Image
      source={{ uri: `${baseUrl}${taskAgentAvatarPath(taskId)}`, headers: renderState.headers }}
      style={styles.image}
      contentFit="cover"
      cachePolicy="none"
      recyclingKey={scopeKey}
      accessible
      accessibilityRole="image"
      onError={() => {
        if (latestScopeRef.current === scopeKey) {
          setRenderState((current) => current.scopeKey === scopeKey ? { ...current, imageFailed: true } : current);
        }
      }}
      accessibilityLabel={`${agentName?.trim() || "Assigned Genie"} avatar`}
    />
  );
}

function createStyles(t: AppTheme, size: number) {
  return StyleSheet.create({
    image: { width: size, height: size, borderRadius: t.radii.pill, flexShrink: 0 },
    shell: {
      width: size,
      height: size,
      borderRadius: t.radii.pill,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.color.surface.element,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.border.default,
    },
    shellGlyph: { fontSize: Math.round(size * 0.55), lineHeight: Math.round(size * 0.7) },
  });
}
