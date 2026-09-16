import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("modal bottom sheets retain Android gesture dismissal", () => {
  const source = readFileSync(resolve(import.meta.dir, "bottom-sheet.tsx"), "utf8");

  expect(source).toContain("import { GestureHandlerRootView } from 'react-native-gesture-handler';");
  expect(source).toContain("<GestureHandlerRootView style={styles.modalSurface}>");
  expect(source).toContain("</GestureHandlerRootView>");
  expect(source).toContain("dismissible = true");
  expect(source).toContain("enablePanDownToClose={dismissible}");
  expect(source).toContain("pressBehavior={dismissible ? 'close' : 'none'}");
  expect(source).toContain("onRequestClose={dismissible ? onClose : undefined}");
  expect(source).toContain("onDismiss={onDismiss}");
  expect(source).toContain("if (Platform.OS !== 'ios' && wasVisible && !visible) onDismiss?.();");
});
