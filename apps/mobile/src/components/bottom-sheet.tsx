import {
  default as GorhomBottomSheet,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { Modal, Platform, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '@/providers/theme';
import type { AppTheme } from '@/theme/tokens';

type BottomSheetProps = {
  /**
   * Controls sheet visibility. Prefer this over an imperative ref — keeps the
   * component prop-driven and easy to wire from parent state.
   */
  visible?: boolean;
  snapPoints?: (string | number)[];
  children: ReactNode;
  onClose?: () => void;
  /** Called after the native modal has left the screen. */
  onDismiss?: () => void;
  /** Give long sheet content its own gesture-aware scrolling surface. */
  scrollable?: boolean;
  /** Dim the underlying surface and allow an outside tap to dismiss. */
  backdrop?: boolean;
  /** Keep an in-flight form visible until its mutation settles. */
  dismissible?: boolean;
};

/**
 * Thin wrapper around `@gorhom/bottom-sheet`. Mount once in the tree; toggle
 * `visible` to open/close. The modal content also owns a gesture root because
 * Android renders React Native Modal content in a separate native window.
 */
export function BottomSheet({
  visible = false,
  snapPoints: snapPointsProp,
  children,
  onClose,
  onDismiss,
  scrollable = false,
  backdrop = false,
  dismissible = true,
}: BottomSheetProps) {
  const t = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(t), [t]);
  const sheetRef = useRef<GorhomBottomSheet>(null);
  const wasVisibleRef = useRef(visible);
  const snapPoints = useMemo(() => snapPointsProp ?? ['50%'], [snapPointsProp]);

  const handleChange = useCallback(
    (index: number) => {
      if (index === -1 && dismissible) {
        onClose?.();
      }
    },
    [dismissible, onClose],
  );
  const renderBackdrop = useCallback(
    (props: ComponentProps<typeof BottomSheetBackdrop>) =>
      backdrop ? (
        <BottomSheetBackdrop
          {...props}
          appearsOnIndex={0}
          disappearsOnIndex={-1}
          pressBehavior={dismissible ? 'close' : 'none'}
        />
      ) : null,
    [backdrop, dismissible],
  );

  // React Native only emits Modal.onDismiss on iOS. On Android, effects run
  // after the visible=false commit has removed the native modal, so complete
  // the same handoff there without a timing-dependent JS timer.
  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (Platform.OS !== 'ios' && wasVisible && !visible) onDismiss?.();
  }, [onDismiss, visible]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      presentationStyle="overFullScreen"
      onRequestClose={dismissible ? onClose : undefined}
      onDismiss={onDismiss}>
      <GestureHandlerRootView style={styles.modalSurface}>
        <GorhomBottomSheet
          ref={sheetRef}
          index={0}
          snapPoints={snapPoints}
          enableDynamicSizing={false}
          topInset={insets.top}
          enablePanDownToClose={dismissible}
          keyboardBehavior="interactive"
          keyboardBlurBehavior="restore"
          android_keyboardInputMode="adjustResize"
          backdropComponent={renderBackdrop}
          onChange={handleChange}
          backgroundStyle={styles.background}
          handleIndicatorStyle={styles.handle}>
          {scrollable ? (
            <BottomSheetScrollView contentContainerStyle={styles.content}>
              {children}
            </BottomSheetScrollView>
          ) : (
            <BottomSheetView style={styles.content}>{children}</BottomSheetView>
          )}
        </GorhomBottomSheet>
      </GestureHandlerRootView>
    </Modal>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    modalSurface: { flex: 1 },
    background: {
      backgroundColor: t.color.surface.panel,
      borderTopLeftRadius: t.radii.lg,
      borderTopRightRadius: t.radii.lg,
    },
    handle: {
      backgroundColor: t.color.border.strong,
    },
    content: {
      paddingHorizontal: t.spacing.lg,
      paddingBottom: t.spacing.xl,
    },
  });
}
