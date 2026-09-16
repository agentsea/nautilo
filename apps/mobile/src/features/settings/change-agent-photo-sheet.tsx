import * as ImagePicker from "expo-image-picker";
import { useMemo } from "react";
import { Alert, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

import type { PickedAgentImage } from "./agent-avatar-source";

interface ChangeAgentPhotoSheetProps {
  visible: boolean;
  onClose: () => void;
  onPick: (asset: PickedAgentImage) => void;
  subject?: "Agent" | "Human";
}

/** Native, labelled controls around Expo's system photo/camera pickers. */
export function ChangeAgentPhotoSheet({ visible, onClose, onPick, subject = "Agent" }: ChangeAgentPhotoSheetProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);

  const chooseFromLibrary = async (): Promise<void> => {
    // SDK 57 does not require a library permission request to launch the
    // system image chooser. Keeping this directly in the button press also
    // satisfies web's user-activation requirement.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
    });
    if (!result.canceled && result.assets[0]) {
      onPick(result.assets[0]);
      onClose();
    }
  };

  const takePhoto = async (): Promise<void> => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera permission needed", `Allow camera access to take a ${subject} photo.`);
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
    });
    if (!result.canceled && result.assets[0]) {
      onPick(result.assets[0]);
      onClose();
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel={`Close change ${subject} photo`} />
        <SafeAreaView edges={["bottom"]} style={styles.panel} accessibilityViewIsModal>
          <View accessibilityRole="menu" accessibilityLabel={`Change ${subject} photo`} style={styles.content}>
        <Text style={styles.title}>Change {subject} photo</Text>
        <Text style={styles.description}>Choose a PNG, JPEG, or WebP image under 5 MiB, or take a new photo.</Text>
        <Pressable
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          onPress={() => void chooseFromLibrary()}
          accessibilityRole="button"
          accessibilityLabel="Choose photo library image"
          accessibilityHint="Opens your phone's image picker."
        >
          <Text style={styles.actionText}>Choose from library</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          onPress={() => void takePhoto()}
          accessibilityRole="button"
          accessibilityLabel="Take photo"
          accessibilityHint="Opens your phone camera."
        >
          <Text style={styles.actionText}>Take a photo</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={`Close change ${subject} photo`}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.32)" },
    backdrop: { ...StyleSheet.absoluteFill },
    panel: { borderTopLeftRadius: t.radii.lg, borderTopRightRadius: t.radii.lg, backgroundColor: t.color.surface.panel, paddingHorizontal: t.spacing.lg },
    content: { gap: t.spacing.sm, paddingTop: t.spacing.sm },
    title: { ...t.typography.subheading, color: t.color.text.foreground },
    description: { ...t.typography.caption, color: t.color.text.muted, marginBottom: t.spacing.sm },
    action: { minHeight: 48, borderRadius: t.radii.sm, justifyContent: "center", paddingHorizontal: t.spacing.md, backgroundColor: t.color.surface.subtle },
    actionText: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    cancel: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: t.spacing.xs },
    cancelText: { ...t.typography.bodyStrong, color: t.color.brand.accent },
    pressed: { opacity: 0.7 },
  });
}
