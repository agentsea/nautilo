import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue } from "react-native-reanimated";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAppTheme } from "@/providers/theme";
import { clampImageTransform, FIT_TRANSFORM, fitImageSize, zoomImageTransform, type ImageSize, type ImageTransform } from "./artifact-image-geometry";

type Props = Readonly<{ uri: string; sourceKey: string; accessibilityLabel?: string }>;

const AnimatedImage = Animated.createAnimatedComponent(Image);

export function ArtifactImageInspector({ uri, sourceKey, accessibilityLabel = "Image" }: Props) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const [visible, setVisible] = useState(false);
  const [viewport, setViewport] = useState<ImageSize>({ width: 0, height: 0 });
  const [image, setImage] = useState<ImageSize>({ width: 0, height: 0 });
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const renderKey = `${sourceKey}:${uri}:${retry}`;
  const activeRenderKey = useRef(renderKey);
  activeRenderKey.current = renderKey;
  const fitted = useMemo(() => fitImageSize(image, viewport), [image, viewport]);
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const pinchStart = useSharedValue(1);
  const panStartX = useSharedValue(0);
  const panStartY = useSharedValue(0);

  const apply = useCallback((next: ImageTransform) => {
    const clamped = clampImageTransform(next, fitted, viewport);
    scale.value = clamped.scale;
    x.value = clamped.x;
    y.value = clamped.y;
  }, [fitted, scale, viewport, x, y]);
  const fit = useCallback(() => apply(FIT_TRANSFORM), [apply]);

  useEffect(() => {
    setVisible(false);
    setImage({ width: 0, height: 0 });
    setLoadState("loading");
    scale.value = 1;
    x.value = 0;
    y.value = 0;
  }, [scale, sourceKey, uri, x, y]);

  // Layout changes (including permitted rotation) recalculate overflow from
  // rendered dimensions and keep an existing zoom/pan inside the new bounds.
  useEffect(() => {
    const next = clampImageTransform({ scale: scale.value, x: x.value, y: y.value }, fitted, viewport);
    scale.value = next.scale;
    x.value = next.x;
    y.value = next.y;
  }, [fitted, scale, viewport, x, y]);

  const onViewport = useCallback((event: LayoutChangeEvent) => setViewport(event.nativeEvent.layout), []);
  const onLoad = useCallback((key: string, event: { nativeEvent: { source: ImageSize } }) => {
    if (key !== activeRenderKey.current) return;
    setImage(event.nativeEvent.source);
    setLoadState("ready");
  }, []);
  const onError = useCallback((key: string) => {
    if (key !== activeRenderKey.current) return;
    setLoadState("error");
  }, []);
  const pinch = useMemo(() => Gesture.Pinch()
    .onBegin(() => { pinchStart.value = scale.value; })
    .onUpdate((event) => {
      scale.value = Math.max(1, pinchStart.value * event.scale);
      const next = clampImageTransform({ scale: scale.value, x: x.value, y: y.value }, fitted, viewport);
      scale.value = next.scale; x.value = next.x; y.value = next.y;
    }), [fitted, pinchStart, scale, viewport, x, y]);
  const pan = useMemo(() => Gesture.Pan()
    .onBegin(() => { panStartX.value = x.value; panStartY.value = y.value; })
    .onUpdate((event) => {
      const next = clampImageTransform({ scale: scale.value, x: panStartX.value + event.translationX, y: panStartY.value + event.translationY }, fitted, viewport);
      x.value = next.x; y.value = next.y;
    }), [fitted, panStartX, panStartY, scale, viewport, x, y]);
  const doubleTap = useMemo(() => Gesture.Tap().numberOfTaps(2).onEnd((_event, success) => {
    if (!success) return;
    // A twofold initial step is an interaction increment, not a zoom ceiling.
    const next = scale.value > 1 ? FIT_TRANSFORM : zoomImageTransform(FIT_TRANSFORM, 2, fitted, viewport);
    scale.value = next.scale; x.value = next.x; y.value = next.y;
  }), [fitted, scale, viewport, x, y]);
  const gestures = useMemo(() => Gesture.Simultaneous(pinch, pan, doubleTap), [doubleTap, pan, pinch]);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }));
  const close = useCallback(() => { setVisible(false); fit(); }, [fit]);
  const zoom = useCallback((multiplier: number) => apply(zoomImageTransform({ scale: scale.value, x: x.value, y: y.value }, multiplier, fitted, viewport)), [apply, fitted, scale, viewport, x, y]);

  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`Open full screen ${accessibilityLabel}`} onPress={() => setVisible(true)} style={styles.preview}>
      <Image key={renderKey} source={{ uri }} onLoad={(event) => onLoad(renderKey, event)} onError={() => onError(renderKey)} resizeMode="contain" style={styles.previewImage} accessibilityLabel={accessibilityLabel} />
      <Text style={[styles.open, { color: theme.color.brand.accent }]}>Open full screen</Text>
      {loadState === "loading" ? <ActivityIndicator accessibilityLabel="Loading image" color={theme.color.brand.accent} /> : null}
      {loadState === "error" ? <Text accessibilityRole="alert" style={[styles.previewError, { color: theme.color.status.error }]}>Image preview unavailable. Open full screen to retry.</Text> : null}
    </Pressable>
    <Modal visible={visible} animationType={reducedMotion ? "none" : "fade"} onRequestClose={close} presentationStyle="fullScreen">
      <GestureHandlerRootView style={styles.modal}>
      <SafeAreaView style={styles.modal} accessibilityViewIsModal>
        <View style={styles.canvas} onLayout={onViewport}>
          {loadState === "loading" ? <ActivityIndicator style={StyleSheet.absoluteFill} accessibilityLabel="Loading full screen image" color="#fff" /> : null}
          {loadState === "error" ? <View style={styles.error}><Text style={styles.errorText}>This image could not be loaded.</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry image" onPress={() => { setLoadState("loading"); setRetry((value) => value + 1); }} style={styles.control}><Text style={styles.controlText}>Retry</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Close full screen image" onPress={close} style={styles.control}><Text style={styles.controlText}>Close</Text></Pressable></View> :
            <GestureDetector gesture={gestures}>
              {/* Keep gesture recognition on a stable full-canvas host while only the image transforms. */}
              <View collapsable={false} pointerEvents="box-only" style={styles.gestureSurface}>
                <AnimatedImage key={renderKey} source={{ uri }} onLoad={(event) => onLoad(renderKey, event)} onError={() => onError(renderKey)} resizeMode="contain" accessibilityLabel={`${accessibilityLabel}, zoomable`} style={[styles.image, animatedStyle]} />
              </View>
            </GestureDetector>}
        </View>
        <View style={styles.controls}>
          <Pressable accessibilityRole="button" accessibilityLabel="Zoom out" onPress={() => zoom(0.8)} style={styles.control}><Text style={styles.controlText}>−</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Fit image" onPress={fit} style={styles.control}><Text style={styles.controlText}>Fit</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Zoom in" onPress={() => zoom(1.25)} style={styles.control}><Text style={styles.controlText}>+</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Close full screen image" onPress={close} style={styles.control}><Text style={styles.controlText}>Close</Text></Pressable>
        </View>
      </SafeAreaView>
      </GestureHandlerRootView>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  preview: { flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center", gap: 10 },
  previewImage: { width: "100%", height: 240 }, open: { fontWeight: "600" }, previewError: { textAlign: "center" },
  modal: { flex: 1, backgroundColor: "#000" }, canvas: { flex: 1, overflow: "hidden", justifyContent: "center", alignItems: "center" },
  gestureSurface: { width: "100%", height: "100%", justifyContent: "center", alignItems: "center" },
  error: { alignItems: "center", gap: 16, padding: 24 }, errorText: { color: "#fff", fontSize: 16, textAlign: "center" },
  image: { width: "100%", height: "100%" }, controls: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-around", padding: 16, gap: 8 },
  control: { paddingVertical: 12, paddingHorizontal: 16, backgroundColor: "#252525", borderRadius: 8 }, controlText: { color: "#fff", fontWeight: "600" },
});
