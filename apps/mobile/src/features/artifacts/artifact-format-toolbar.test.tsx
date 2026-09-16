import { expect, test } from "bun:test";

test("shared toolbar is a compact themed modal with 48px actions and no hidden format commands", async () => {
  const source = await Bun.file(
    new URL("./artifact-format-toolbar.tsx", import.meta.url),
  ).text();
  expect(source).toContain(
    'import { KeyboardAvoidingView } from "react-native-keyboard-controller"',
  );
  expect(source).toMatch(
    /<Modal\s+visible=\{openSheet !== null\}\s+transparent\s+animationType="slide"/,
  );
  expect(source).toContain("onDismiss={returnToEditorIfPending}");
  expect(source).toContain('Platform.OS === "android" && openSheet === null');
  expect(source).toMatch(
    /<KeyboardAvoidingView\s+behavior=\{Platform\.OS === "ios" \? "padding" : "height"\}\s+style=\{styles\.modalRoot\}/,
  );
  expect(source).toContain("accessibilityViewIsModal");
  expect(source).toContain('accessibilityLabel="Dismiss formatting sheet"');
  expect(source).toContain("width: 48");
  expect(source).toContain("height: 48");
  expect(source).toContain("minHeight: 48");
  expect(source).not.toContain("ScrollView");
  expect(source).toContain('flexWrap: "wrap"');
  expect(source).toContain('width: "48%"');
  expect(source).toContain("adjustsFontSizeToFit");
  expect(source).toContain("minimumFontScale={0.8}");
  expect(source).toContain("numberOfLines={1}");
  expect(source).not.toContain("maxHeight");
  expect(source).toContain('accessibilityLabel="Cancel formatting"');
  expect(source).toContain('accessibilityLabel="Cancel link editing"');
  expect(source).toMatch(
    /<View style=\{styles\.linkActions\}>[\s\S]*accessibilityLabel="Cancel link editing"[\s\S]*link\.selected \? "Update link" : "Add link"/,
  );
  expect(source).toContain("minWidth: 72");
  expect(source).toContain(
    'if (openSheet === "link") linkInputRef.current?.focus()',
  );
  expect(source).toContain("disabled={!linkDraftValid}");
  expect(source).toContain(
    "accessibilityState={{ disabled: !linkDraftValid }}",
  );
  expect(source).toContain('Keyboard.addListener("keyboardDidHide"');
  expect(source).toContain('openSheet === "link" && Keyboard.isVisible()');
  expect(source).toContain(
    "const handledLinkOpenRequest = useRef(linkOpenRequest)",
  );
  expect(source).toContain("const nativeLinkSheetOpen = useRef(false)");
  expect(source).toContain("nativeLinkSheetOpen.current = true");
  expect(source).toContain('setOpenSheet("link")');
  expect(source).toMatch(
    /if \(openSheet === "link" && nativeLinkSheetOpen\.current\) \{[\s\S]*nativeLinkSheetOpen\.current = false;[\s\S]*onNativeLinkSheetClose\?\.\(\);/,
  );
  expect(source).toContain(
    "if (waitForKeyboardHide.current) Keyboard.dismiss()",
  );
  expect(source).toContain('backgroundColor: "transparent"');
  expect(source).toContain("backgroundColor: theme.color.action.primaryBg");
  expect(source).toContain("theme.color.surface.panel");
  expect(source).toContain("theme.color.text.foreground");
  expect(source).toMatch(
    /accessibilityState=\{\{\s*disabled: action\.disabled,\s*selected: action\.selected,?\s*\}\}/,
  );
  expect(source).toMatch(
    /formatSheet\?\.actions\.every\(\(action\) => action\.disabled === true\)/,
  );
});

test("focus restore is one-shot and platform-gated after a closed render", async () => {
  const source = await Bun.file(
    new URL("./artifact-format-toolbar.tsx", import.meta.url),
  ).text();
  expect(source).toMatch(
    /function consumePendingEditorFocus\([\s\S]*if \(!pending\.current\) return false;[\s\S]*pending\.current = false;[\s\S]*onReturnToEditor\?\.\(\);/,
  );
  expect(source).toContain("const restoreFocusPending = useRef(false)");
  expect(source).toContain("restoreFocusPending.current = true");
  expect(source).toContain("onDismiss={returnToEditorIfPending}");
  expect(source).toMatch(/Platform\.OS === "android" && openSheet === null/);
  expect(source).not.toContain("onDismiss={onReturnToEditor}");
});

test("an externally opened link sheet clears its frozen target once through every close route", async () => {
  const source = await Bun.file(
    new URL("./artifact-format-toolbar.tsx", import.meta.url),
  ).text();
  expect(source.match(/onNativeLinkSheetClose\?\.\(\)/g)?.length).toBe(1);
  expect(source).toMatch(
    /const closeSheet = \(\) => \{[\s\S]*if \(openSheet === "link" && nativeLinkSheetOpen\.current\) \{[\s\S]*nativeLinkSheetOpen\.current = false;[\s\S]*onNativeLinkSheetClose\?\.\(\);/,
  );
  expect(source).toContain("onRequestClose={closeSheet}");
  expect(source).toMatch(
    /accessibilityLabel="Dismiss formatting sheet"[\s\S]*onPress=\{closeSheet\}/,
  );
  expect(source).toMatch(
    /accessibilityLabel="Cancel link editing"[\s\S]*onPress=\{closeSheet\}/,
  );
  expect(source).toMatch(
    /const submitLink = \(\) => \{[\s\S]*link\.onSubmit\(linkDraft\);[\s\S]*closeSheet\(\);/,
  );
  expect(source).toMatch(/link\.onRemove\?\.\(\);[\s\S]*closeSheet\(\);/);
});

test("shared toolbar keeps link and block commands in focused sheets without editor ownership", async () => {
  const source = await Bun.file(
    new URL("./artifact-format-toolbar.tsx", import.meta.url),
  ).text();
  expect(source).toContain('accessibilityLabel="Link editing sheet"');
  expect(source).toContain('accessibilityLabel="Link address"');
  expect(source).toContain('accessibilityLabel="Remove link"');
  expect(source).toContain(
    "accessibilityLabel={`${formatSheet.title} options`}",
  );
  expect(source).toMatch(
    /accessibilityLabel=\{\s*link\.selected \? "Update link" : "Add link"\s*\}/,
  );
  expect(source).toContain("formatSheet.title} sheet");
  expect(source).toContain("afterLinkActions.map");
  expect(source).not.toContain("setSelection");
  expect(source).not.toContain("setNativeProps");
  expect(source).not.toContain("getHTML");
  expect(source).not.toContain("TextInputState");
  expect(source).not.toContain("requestAnimationFrame");
});
