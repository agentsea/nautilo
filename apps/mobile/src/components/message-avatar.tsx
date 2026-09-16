import { Image } from "expo-image";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { buildAgentAvatarPath, buildUserAvatarPath } from "@/lib/room-authors";
import { loadAssetBearer } from "@/lib/asset-bearer";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { AvatarRef } from "@nautilo/types";

export type MessageAvatarProps = {
  serverUrl: string;
  roomId: string;
  displayName: string;
  userId?: string;
  agentId?: string;
  agentAvatar?: AvatarRef | null;
  size?: number;
  /** D408 stub — agent-focus / member-info wiring is a later task. */
  onAvatarPress?: () => void;
};

function initialsFromName(displayName: string): string {
  const label = displayName.trim();
  if (label.length === 0) return "?";
  return label
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function colorFromUserId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 55% 45%)`;
}

export function MessageAvatar({
  serverUrl,
  roomId,
  displayName,
  userId,
  agentId,
  agentAvatar,
  size = 28,
  onAvatarPress,
}: MessageAvatarProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t, size), [t, size]);
  const [authHeaders, setAuthHeaders] = useState<Record<string, string> | undefined>();
  const [imageFailed, setImageFailed] = useState(false);

  const avatarPath = useMemo(() => {
    if (userId) return buildUserAvatarPath(userId);
    if (agentId) {
      return buildAgentAvatarPath({ roomId, agentId, avatar: agentAvatar });
    }
    return "";
  }, [userId, agentId, roomId, agentAvatar]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await loadAssetBearer(serverUrl);
      if (cancelled) return;
      setAuthHeaders(token ? { Authorization: `Bearer ${token}` } : undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  useEffect(() => {
    setImageFailed(false);
  }, [avatarPath, authHeaders]);

  const baseUrl = serverUrl.replace(/\/+$/, "");
  const uri = avatarPath.length > 0 ? `${baseUrl}${avatarPath}` : "";

  const fallbackId = userId ?? agentId ?? displayName;
  const showInitials = imageFailed || avatarPath.length === 0 || !authHeaders;

  const content = showInitials ? (
    <View style={[styles.initialsCircle, { backgroundColor: colorFromUserId(fallbackId) }]}>
      <Text style={styles.initialsText}>{initialsFromName(displayName)}</Text>
    </View>
  ) : (
    <Image
      source={{ uri, headers: authHeaders }}
      style={styles.image}
      contentFit="cover"
      onError={() => setImageFailed(true)}
    />
  );

  if (onAvatarPress) {
    return (
      <Pressable
        onPress={onAvatarPress}
        accessibilityRole="button"
        accessibilityLabel={displayName}
        style={styles.pressable}>
        {content}
      </Pressable>
    );
  }

  return <View style={styles.pressable}>{content}</View>;
}

function createStyles(t: AppTheme, size: number) {
  return StyleSheet.create({
    pressable: {
      width: size,
      height: size,
      borderRadius: t.radii.pill,
      overflow: "hidden",
      flexShrink: 0,
    },
    image: {
      width: size,
      height: size,
      borderRadius: t.radii.pill,
    },
    initialsCircle: {
      width: size,
      height: size,
      borderRadius: t.radii.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    initialsText: {
      color: "#fff",
      fontSize: Math.round(size * 0.4),
      fontWeight: "600",
      lineHeight: Math.round(size * 0.45),
    },
  });
}
