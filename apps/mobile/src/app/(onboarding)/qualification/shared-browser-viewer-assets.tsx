import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { SharedBrowserViewerPdfQualification } from "@/components/shared-browser-viewer-pdf-qualification";
import {
  loadSharedBrowserViewerExportProbe,
  SHARED_BROWSER_VIEWER_PROBE_FORMATS,
  type SharedBrowserViewerExportProbe,
  type SharedBrowserViewerProbeFormat,
} from "@/lib/shared-browser-viewer-export-probe";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

const FORMAT_LABELS: Record<SharedBrowserViewerProbeFormat, string> = {
  pdf: "PDF worker",
  docx: "DOCX parser",
  xlsx: "XLSX parser",
  pptx: "PPTX parser",
};

/**
 * Non-product qualification surface. The format buttons select import closures
 * without bytes; the separate PDF control renders only its deterministic local
 * fixture. Neither path has auth state, a source URL, retry, or a support claim.
 */
export default function SharedBrowserViewerAssetsQualificationScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const activeProbe = useRef<SharedBrowserViewerExportProbe | null>(null);
  const activePdfQualificationCleanup = useRef<(() => void) | null>(null);
  const generation = useRef(0);
  const [outcome, setOutcome] = useState("No browser viewer import closure selected.");

  const cleanup = (): void => {
    const current = activeProbe.current;
    activeProbe.current = null;
    current?.cleanup();
  };

  const cleanupPdfQualification = useCallback((): void => {
    const current = activePdfQualificationCleanup.current;
    activePdfQualificationCleanup.current = null;
    current?.();
  }, []);

  const registerPdfQualificationCleanup = useCallback((cleanupHandler: (() => void) | undefined): void => {
    activePdfQualificationCleanup.current = cleanupHandler ?? null;
  }, []);

  useEffect(() => () => {
    generation.current += 1;
    cleanupPdfQualification();
    cleanup();
  }, [cleanupPdfQualification]);

  const load = async (format: SharedBrowserViewerProbeFormat): Promise<void> => {
    const currentGeneration = ++generation.current;
    cleanupPdfQualification();
    cleanup();
    setOutcome(`Importing ${FORMAT_LABELS[format]} closure…`);
    try {
      const probe = await loadSharedBrowserViewerExportProbe(format);
      if (currentGeneration !== generation.current) {
        probe.cleanup();
        return;
      }
      activeProbe.current = probe;
      setOutcome(`${FORMAT_LABELS[format]} closure imported: ${probe.identity}`);
    } catch {
      if (currentGeneration !== generation.current) return;
      setOutcome(`${FORMAT_LABELS[format]} closure could not be imported.`);
    }
  };

  return (
    <View style={styles.root}>
      <AppBar title="Browser viewer export closure" left={<AppBarBackButton onPress={() => router.back()} />} />
      <View style={styles.body}>
        <Text style={styles.description}>
          Diagnostic only. Select one Web import closure to inspect its emitted boundary, or use the separate local PDF fixture below.
        </Text>
        {SHARED_BROWSER_VIEWER_PROBE_FORMATS.map((format) => (
          <Pressable
            key={format}
            accessibilityRole="button"
            accessibilityLabel={`Load ${FORMAT_LABELS[format]} closure`}
            onPress={() => void load(format)}
            style={styles.action}
          >
            <Text style={styles.actionText}>{FORMAT_LABELS[format]}</Text>
          </Pressable>
        ))}
        <SharedBrowserViewerPdfQualification
          onBeforeRender={cleanup}
          onRegisterCleanup={registerPdfQualificationCleanup}
        />
        <Text style={styles.outcome} testID="shared-browser-viewer-assets-outcome">
          {outcome}
        </Text>
      </View>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.color.surface.background },
    body: { flex: 1, gap: theme.spacing.md, padding: theme.spacing.md },
    description: { ...theme.typography.body, color: theme.color.text.muted },
    action: {
      borderColor: theme.color.border.default,
      borderRadius: theme.radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    actionText: { ...theme.typography.bodyStrong, color: theme.color.text.foreground },
    outcome: { ...theme.typography.caption, color: theme.color.text.muted },
  });
}
