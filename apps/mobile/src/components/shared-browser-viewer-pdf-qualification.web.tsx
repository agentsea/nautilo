import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import {
  buildSharedBrowserViewerPdfFixture,
  SHARED_BROWSER_VIEWER_PDF_FIXTURE_ID,
  SHARED_BROWSER_VIEWER_PDF_FIXTURE_PAGE_COUNT,
  SHARED_BROWSER_VIEWER_PDF_FIXTURE_SHA256,
} from "@/lib/shared-browser-viewer-pdf-fixture";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

import type { SharedBrowserViewerPdfQualificationProps } from "./shared-browser-viewer-pdf-qualification";

/** Instrumentation only, never a user-document or product support deadline. */
export const PDF_QUALIFICATION_RENDER_DEADLINE_MS = 15_000 as const;
/** Explicit observation settle window; this is qualification-only, not a product timeout. */
export const PDF_QUALIFICATION_POST_CLOSE_OBSERVATION_WAIT_MS = 100 as const;
export const SHARED_BROWSER_VIEWER_PDF_OBSERVATION_SCHEMA_VERSION =
  "nautilo.shared-browser-viewer-pdf-observation.v1" as const;

type ActiveQualification = {
  readonly close: () => void;
  readonly cleanupRuntime: () => void;
};

type PdfModules = Awaited<ReturnType<typeof loadPdfModules>>;

type MatrixRun = {
  readonly close: () => void;
  readonly cleanup: () => void;
  readonly done: Promise<{ readonly kind: "ready" | "error" | "closed"; readonly pageCount?: number }>;
};

function matrixRunOwner(run: MatrixRun): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    run.close();
    run.cleanup();
  };
}

type ObservationAsset = {
  readonly url: string;
  readonly contentType: string;
  readonly sha256: string;
};

function fixtureArrayBuffer(): ArrayBuffer {
  const fixture = buildSharedBrowserViewerPdfFixture();
  const copied = new Uint8Array(fixture.byteLength);
  copied.set(fixture);
  return copied.buffer;
}

function corruptFixtureArrayBuffer(): ArrayBuffer {
  const corrupted = new Uint8Array(buildSharedBrowserViewerPdfFixture().byteLength);
  corrupted.fill(0);
  return corrupted.buffer;
}

function safeDevicePixelRatio(): number {
  return Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
    ? window.devicePixelRatio
    : 1;
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function safeRuntimeLabel(value: string): string {
  return value.replace(/[\r\n]/g, " ").slice(0, 256);
}

function safeRelativeMobileAssetUrl(value: string): string | null {
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin || parsed.username || parsed.password
      || parsed.search || parsed.hash || !parsed.pathname.startsWith("/mobile/")) return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}

function memorySample(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: unknown } }).memory;
  return typeof memory?.usedJSHeapSize === "number" && Number.isSafeInteger(memory.usedJSHeapSize)
    && memory.usedJSHeapSize >= 0 ? memory.usedJSHeapSize : null;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) return "unknown";
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    return "unknown";
  }
}

async function observedMobileAssets(startIndex: number): Promise<readonly ObservationAsset[]> {
  const urls = [...new Set(performance.getEntriesByType("resource").slice(startIndex)
    .map((entry) => safeRelativeMobileAssetUrl(entry.name))
    .filter((value): value is string => value !== null)
    .filter((value) => /\.(?:js|mjs)$/i.test(value)))].sort();
  return Promise.all(urls.map(async (url) => {
    try {
      const response = await fetch(url, { credentials: "same-origin", redirect: "error" });
      if (!response.ok) return { url, contentType: "unknown", sha256: "unknown" };
      return {
        url,
        contentType: response.headers.get("content-type")?.split(";", 1)[0] ?? "unknown",
        sha256: await sha256(await response.arrayBuffer()),
      };
    } catch {
      return { url, contentType: "unknown", sha256: "unknown" };
    }
  }));
}

function canvasObservation(host: HTMLElement): {
  readonly count: number;
  readonly cssWidth: number | null;
  readonly cssHeight: number | null;
  readonly backingWidth: number | null;
  readonly backingHeight: number | null;
  readonly devicePixelRatio: number;
} {
  const canvases = host.querySelectorAll("canvas");
  const canvas = canvases.item(0);
  if (!canvas) {
    return { count: 0, cssWidth: null, cssHeight: null, backingWidth: null, backingHeight: null, devicePixelRatio: safeDevicePixelRatio() };
  }
  const box = canvas.getBoundingClientRect();
  return {
    count: canvases.length,
    cssWidth: Math.round(box.width),
    cssHeight: Math.round(box.height),
    backingWidth: canvas.width,
    backingHeight: canvas.height,
    devicePixelRatio: safeDevicePixelRatio(),
  };
}

/** Explicit, exported qualification-only post-close observation wait. */
export function waitForPdfQualificationPostCloseObservation(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, PDF_QUALIFICATION_POST_CLOSE_OBSERVATION_WAIT_MS));
}

async function loadPdfModules() {
  return Promise.all([
    import("@nautilo/browser-document-viewer/pdf/renderer"),
    import("@/lib/shared-browser-viewer-runtime/pdf-qualification.web"),
  ] as const);
}

function beginMatrixRun(
  modules: PdfModules,
  host: HTMLElement,
  options: {
    readonly bytes: ArrayBuffer;
    readonly scale: number;
    readonly rotation: number;
    readonly onRendering?: () => void;
    readonly onSafeError?: () => void;
  },
): MatrixRun {
  const [rendererModule, runtimeModule] = modules;
  const runtime = runtimeModule.createSharedBrowserViewerPdfQualificationRuntime();
  let runtimeCleaned = false;
  const cleanup = (): void => {
    if (runtimeCleaned) return;
    runtimeCleaned = true;
    runtime.cleanup();
  };
  const controller = new AbortController();
  const renderer = rendererModule.renderBrowserPdf({
    bytes: options.bytes,
    host,
    runtime: runtime.runtime as unknown as Parameters<typeof rendererModule.renderBrowserPdf>[0]["runtime"],
    configureWorker: () => runtime.configureWorker(),
    signal: controller.signal,
    deadlineAt: Date.now() + PDF_QUALIFICATION_RENDER_DEADLINE_MS,
    scale: options.scale,
    rotation: options.rotation,
    devicePixelRatio: safeDevicePixelRatio(),
    onStatus(status): void {
      if (status.kind === "rendering") options.onRendering?.();
      if (status.kind === "error") options.onSafeError?.();
    },
  });
  return {
    close: () => {
      controller.abort();
      renderer.close();
    },
    cleanup,
    done: renderer.done,
  };
}

/** A manual Web-only render of a known-safe local fixture plus raw diagnostics. */
export function SharedBrowserViewerPdfQualification({
  onBeforeRender,
  onRegisterCleanup,
}: SharedBrowserViewerPdfQualificationProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const host = useRef<HTMLElement | null>(null);
  const active = useRef<ActiveQualification | null>(null);
  const matrixClose = useRef<(() => void) | null>(null);
  const matrixRunning = useRef(false);
  const generation = useRef(0);
  const [outcome, setOutcome] = useState("No PDF fixture render has run.");
  const [observationJson, setObservationJson] = useState("");

  const releaseActiveQualification = useCallback((): void => {
    matrixClose.current?.();
    matrixClose.current = null;
    const current = active.current;
    active.current = null;
    current?.close();
    current?.cleanupRuntime();
  }, []);

  const cleanup = useCallback((message: string): void => {
    generation.current += 1;
    releaseActiveQualification();
    setObservationJson("");
    setOutcome(message);
  }, [releaseActiveQualification]);

  useEffect(() => {
    onRegisterCleanup?.(() => cleanup("PDF fixture qualification cleanup completed."));
    return () => onRegisterCleanup?.(undefined);
  }, [cleanup, onRegisterCleanup]);

  useEffect(() => () => {
    generation.current += 1;
    releaseActiveQualification();
  }, [releaseActiveQualification]);

  const renderFixture = async (): Promise<void> => {
    if (!host.current) {
      setOutcome("PDF qualification DOM host is unavailable.");
      return;
    }
    onBeforeRender?.();
    cleanup("Preparing PDF fixture qualification render…");
    const currentGeneration = generation.current;
    let cleanupRuntime: (() => void) | undefined;
    try {
      const modules = await loadPdfModules();
      if (currentGeneration !== generation.current || !host.current) return;
      const run = beginMatrixRun(modules, host.current, { bytes: fixtureArrayBuffer(), scale: 1, rotation: 0 });
      cleanupRuntime = run.cleanup;
      active.current = { close: run.close, cleanupRuntime };
      const rendered = await run.done;
      if (currentGeneration !== generation.current) return;
      if (rendered.kind === "ready") {
        setOutcome(`Ready: rendered ${SHARED_BROWSER_VIEWER_PDF_FIXTURE_ID} (${rendered.pageCount}/${SHARED_BROWSER_VIEWER_PDF_FIXTURE_PAGE_COUNT} page; diagnostic deadline ${PDF_QUALIFICATION_RENDER_DEADLINE_MS}ms).`);
      } else {
        active.current = null;
        cleanupRuntime();
        if (rendered.kind === "closed") setOutcome("PDF fixture qualification cleanup completed.");
      }
    } catch {
      cleanupRuntime?.();
      if (currentGeneration === generation.current) {
        active.current = null;
        setOutcome("PDF qualification render failed.");
      }
    }
  };

  const runChromiumObservation = async (): Promise<void> => {
    if (matrixRunning.current) return;
    if (!host.current) {
      setOutcome("PDF qualification DOM host is unavailable.");
      return;
    }
    matrixRunning.current = true;
    // A failed replacement must never leave a prior successful observation selectable.
    setObservationJson("");
    onBeforeRender?.();
    cleanup("Running raw Chromium PDF observation…");
    const currentGeneration = generation.current;
    const matrixHost = host.current;
    const startedAt = performance.now();
    const memoryBefore = memorySample();
    const assetEntryIndex = performance.getEntriesByType("resource").length;
    try {
      const modules = await loadPdfModules();
      if (currentGeneration !== generation.current) return;

      const baselineStartedAt = performance.now();
      const baseline = beginMatrixRun(modules, matrixHost, { bytes: fixtureArrayBuffer(), scale: 1, rotation: 0 });
      matrixClose.current = matrixRunOwner(baseline);
      const baselineResult = await baseline.done;
      baseline.cleanup();
      if (baselineResult.kind !== "ready" || baselineResult.pageCount !== SHARED_BROWSER_VIEWER_PDF_FIXTURE_PAGE_COUNT) throw new Error("baseline outcome");
      const baselineCanvas = canvasObservation(matrixHost);
      if (baselineCanvas.count !== 1) throw new Error("baseline canvas");
      const baselineElapsedMs = elapsedSince(baselineStartedAt);

      const replacement = { current: null as MatrixRun | null };
      let replacementStarted = false;
      const replacementStartedAt = performance.now();
      const replaced = beginMatrixRun(modules, matrixHost, {
        bytes: fixtureArrayBuffer(),
        scale: 1,
        rotation: 0,
        onRendering: () => {
          if (replacementStarted) return;
          replacementStarted = true;
          replacement.current = beginMatrixRun(modules, matrixHost, {
            bytes: fixtureArrayBuffer(), scale: 1.25, rotation: 90,
          });
          matrixClose.current = matrixRunOwner(replacement.current);
        },
      });
      matrixClose.current = matrixRunOwner(replaced);
      const replacedResult = await replaced.done;
      replaced.cleanup();
      if (!replacement.current || replacedResult.kind !== "closed") throw new Error("same-host replacement outcome");
      const replacementResult = await replacement.current.done;
      replacement.current.cleanup();
      if (replacementResult.kind !== "ready") throw new Error("replacement ready outcome");
      const replacementCanvas = canvasObservation(matrixHost);
      if (replacementCanvas.count !== 1) throw new Error("replacement canvas");
      const replacementElapsedMs = elapsedSince(replacementStartedAt);
      const memoryDuringMatrix = memorySample();

      let cancellationTriggeredAtRenderingStatus = false;
      let cancellation: MatrixRun | null = null;
      const cancellationStartedAt = performance.now();
      cancellation = beginMatrixRun(modules, matrixHost, {
        bytes: fixtureArrayBuffer(),
        scale: 1,
        rotation: 0,
        onRendering: () => {
          cancellationTriggeredAtRenderingStatus = true;
          cancellation?.close();
        },
      });
      matrixClose.current = matrixRunOwner(cancellation);
      const cancellationResult = await cancellation.done;
      cancellation.cleanup();
      if (!cancellationTriggeredAtRenderingStatus || cancellationResult.kind !== "closed") throw new Error("cancellation outcome");
      const cancellationElapsedMs = elapsedSince(cancellationStartedAt);

      const corruptStartedAt = performance.now();
      let corruptReportedSafeError = false;
      const corrupt = beginMatrixRun(modules, matrixHost, {
        bytes: corruptFixtureArrayBuffer(), scale: 1, rotation: 0,
        onSafeError: () => { corruptReportedSafeError = true; },
      });
      matrixClose.current = matrixRunOwner(corrupt);
      const corruptResult = await corrupt.done;
      corrupt.cleanup();
      if (corruptResult.kind !== "error" || !corruptReportedSafeError) throw new Error("corrupt fixture outcome");
      const corruptFixtureElapsedMs = elapsedSince(corruptStartedAt);

      const finalRun = beginMatrixRun(modules, matrixHost, { bytes: fixtureArrayBuffer(), scale: 1, rotation: 0 });
      matrixClose.current = matrixRunOwner(finalRun);
      const finalReady = await finalRun.done;
      if (finalReady.kind !== "ready") throw new Error("final ready outcome");
      const finalCloseStartedAt = performance.now();
      finalRun.close();
      finalRun.cleanup();
      matrixClose.current = null;
      await waitForPdfQualificationPostCloseObservation();
      const afterCloseCanvas = canvasObservation(matrixHost);
      if (afterCloseCanvas.count !== 0) throw new Error("post-close canvas");
      const finalCloseElapsedMs = elapsedSince(finalCloseStartedAt);

      const memoryAfterClose = memorySample();
      const observation = {
        schemaVersion: SHARED_BROWSER_VIEWER_PDF_OBSERVATION_SCHEMA_VERSION,
        physical: false,
        eligible: false,
        reasons: ["non-physical-runtime", "in-memory-fixture"],
        runtime: {
          userAgent: safeRuntimeLabel(navigator.userAgent),
          platform: safeRuntimeLabel(navigator.platform),
          viewport: { width: window.innerWidth, height: window.innerHeight },
          devicePixelRatio: safeDevicePixelRatio(),
        },
        fixture: {
          id: SHARED_BROWSER_VIEWER_PDF_FIXTURE_ID,
          sha256: SHARED_BROWSER_VIEWER_PDF_FIXTURE_SHA256,
          bytes: buildSharedBrowserViewerPdfFixture().byteLength,
          pages: SHARED_BROWSER_VIEWER_PDF_FIXTURE_PAGE_COUNT,
        },
        acquisition: { status: "not-observed", reason: "in-memory-fixture" },
        diagnostic: {
          deadlineMs: PDF_QUALIFICATION_RENDER_DEADLINE_MS,
          deadlineKind: "qualification-only-not-product-policy",
          elapsedMs: {
            baseline: baselineElapsedMs,
            replacement: replacementElapsedMs,
            cancellation: cancellationElapsedMs,
            corruptFixture: corruptFixtureElapsedMs,
            finalClose: finalCloseElapsedMs,
            total: elapsedSince(startedAt),
          },
        },
        scenarios: {
          baselineReady: true,
          sameHostReplacement: { observed: true, scale: 1.25, rotation: 90 },
          cancellationAtRenderingStatus: true,
          corruptFixtureParserFailure: true,
        },
        canvas: { baseline: baselineCanvas, replacement: replacementCanvas },
        lifecycle: {
          finalCloseObserved: true,
          canvasesAfterClose: afterCloseCanvas.count,
          postCloseObservationWaitMs: PDF_QUALIFICATION_POST_CLOSE_OBSERVATION_WAIT_MS,
        },
        memory: memoryBefore === null || memoryDuringMatrix === null || memoryAfterClose === null
          ? { status: "unknown", reason: "api-unavailable" }
          : { status: "observed", beforeBytes: memoryBefore, duringMatrixBytes: memoryDuringMatrix, afterCloseBytes: memoryAfterClose },
        assets: await observedMobileAssets(assetEntryIndex),
        expectedSafeErrors: ["Document preview failed."],
        errors: [],
      };
      if (currentGeneration !== generation.current) return;
      setObservationJson(JSON.stringify(observation, null, 2));
      setOutcome("Raw Chromium PDF observation completed. It is not product qualification or approval.");
    } catch {
      matrixClose.current?.();
      matrixClose.current = null;
      if (currentGeneration === generation.current) setOutcome("Raw Chromium PDF observation did not complete expected diagnostic outcomes.");
    } finally {
      matrixRunning.current = false;
    }
  };

  return (
    <View style={styles.root}>
      <Text style={styles.description}>
        Manual Web diagnostic. It renders one local, known-safe PDF fixture and never acquires a document or records approval.
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Render local PDF qualification fixture" onPress={() => void renderFixture()} style={styles.action}>
        <Text style={styles.actionText}>Render local PDF fixture</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Clear PDF qualification fixture" onPress={() => cleanup("PDF fixture qualification cleanup completed.")} style={styles.action}>
        <Text style={styles.actionText}>Clear fixture</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Run Chromium PDF observation" onPress={() => void runChromiumObservation()} style={styles.action}>
        <Text style={styles.actionText}>Run Chromium observation</Text>
      </Pressable>
      <View ref={(value) => { host.current = value as unknown as HTMLElement | null; }} style={styles.host} />
      <Text style={styles.outcome} testID="shared-browser-viewer-pdf-qualification-outcome">{outcome}</Text>
      <TextInput
        testID="shared-browser-viewer-pdf-observation-json"
        accessibilityLabel="Raw Chromium PDF observation JSON"
        value={observationJson}
        editable={false}
        multiline
        selectTextOnFocus
        style={styles.observation}
      />
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { gap: theme.spacing.sm },
    description: { ...theme.typography.caption, color: theme.color.text.muted },
    action: { borderColor: theme.color.border.default, borderRadius: theme.radii.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm },
    actionText: { ...theme.typography.bodyStrong, color: theme.color.text.foreground },
    host: { alignSelf: "stretch", overflow: "hidden" },
    outcome: { ...theme.typography.caption, color: theme.color.text.muted },
    observation: { borderColor: theme.color.border.default, borderRadius: theme.radii.sm, borderWidth: StyleSheet.hairlineWidth, color: theme.color.text.foreground, fontFamily: "monospace", minHeight: 160, padding: theme.spacing.sm },
  });
}
