import { router } from "expo-router";
import { Pressable, StyleSheet, Text } from "react-native";
import { useEffect, useState } from "react";

import { admitArtifactEditContent } from "./artifact-edit-admission";
import type { ArtifactEditLoadResult } from "./artifact-edit-loader";

type EditArtifact = { id: string; path: string; mimeType: string; size: number; canWrite: boolean };
export type ReadyArtifactEdit = {
  artifactId: string;
  admission: Exclude<ReturnType<typeof admitArtifactEditContent>, { kind: "view-only" }>;
};

export function shouldResolveArtifactEdit(input: {
  resultKind: "text" | "file" | "unsupported" | "other";
}): boolean {
  return input.resultKind === "text";
}

export function artifactEditTarget(id: string, roomId?: string) {
  return {
    pathname: "/files/artifact/edit/[id]" as const,
    params: { id, ...(roomId ? { roomId } : {}) },
  };
}

export function shouldMountArtifactDiscussion(artifactPresent: boolean, roomId?: string): boolean {
  return artifactPresent && roomId !== undefined && roomId.length > 0;
}

type ArtifactViewerActionAppearance = {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
};

export function artifactViewerActionButtonStyle(
  appearance: ArtifactViewerActionAppearance | undefined,
  pressed: boolean,
) {
  return [
    artifactViewerActionStyles.button,
    appearance ? {
      backgroundColor: appearance.backgroundColor,
      borderColor: appearance.borderColor,
    } : undefined,
    pressed && artifactViewerActionStyles.pressed,
  ];
}

export function artifactViewerActionLabelStyle(appearance?: ArtifactViewerActionAppearance) {
  return [
    artifactViewerActionStyles.label,
    appearance ? { color: appearance.textColor } : undefined,
  ];
}

export function ArtifactEditButton({ artifactId, roomId, appearance }: {
  artifactId: string;
  roomId?: string;
  appearance?: ArtifactViewerActionAppearance;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Edit file"
      hitSlop={4}
      style={({ pressed }) => artifactViewerActionButtonStyle(appearance, pressed)}
      onPress={() => router.push(artifactEditTarget(artifactId, roomId))}
    >
      <Text style={artifactViewerActionLabelStyle(appearance)}>
        Edit
      </Text>
    </Pressable>
  );
}

export function ArtifactEditActionView({ ready, roomId, appearance }: {
  ready?: ReadyArtifactEdit;
  roomId?: string;
  appearance?: ArtifactViewerActionAppearance;
}) {
  return ready ? <ArtifactEditButton artifactId={ready.artifactId} roomId={roomId} appearance={appearance} /> : null;
}

export function ArtifactEditAction({ artifactId, artifact, roomId, content, appearance, load }: {
  artifactId: string;
  artifact?: EditArtifact;
  roomId?: string;
  content?: string;
  appearance?: ArtifactViewerActionAppearance;
  load: (signal: AbortSignal) => Promise<ArtifactEditLoadResult>;
}) {
  const [ready, setReady] = useState<ReadyArtifactEdit>();
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setReady(undefined);
    if (artifact && content !== undefined) {
      const admission = admitArtifactEditContent(
        {
          path: artifact.path,
          mimeType: artifact.mimeType,
          size: artifact.size,
          writable: artifact.canWrite,
        },
        content,
      );
      if (admission.kind !== "view-only") setReady({ artifactId: artifact.id, admission });
    } else {
      void load(controller.signal).then((result) => {
        if (live && result.kind === "ready") {
          setReady({ artifactId: result.artifact.id, admission: result.admission });
        }
      }).catch(() => undefined);
    }
    return () => { live = false; controller.abort(); };
  }, [artifact, artifactId, content, load]);
  return <ArtifactEditActionView ready={ready} roomId={roomId} appearance={appearance} />;
}

const artifactViewerActionStyles = StyleSheet.create({
  button: {
    minWidth: 64,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
  },
  pressed: { opacity: 0.72 },
  label: { fontSize: 15, fontWeight: "600", lineHeight: 20 },
});
