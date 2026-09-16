import { expect, test } from "bun:test";

test("the single global PIN modal fences stale completions and supports canonical enrollment", async () => {
  const source = await Bun.file(new URL("./pin-modal.tsx", import.meta.url)).text();
  expect(source).toContain("const activeChallengeRef = useRef(activeChallenge)");
  expect(source).toContain("const expected = activeChallenge");
  expect(source).toContain("resolveChallenge(expected, pin)");
  expect(source).toContain("denyChallenge(expected)");
  expect(source).toContain("activeChallengeRef.current !== expected");
  expect(source).toContain("/^\\d{6,8}$/.test(pin)");
  expect(source).toContain("maxLength={8}");
  expect(source).toContain('activeChallenge.event.mode === "enrollPin"');
  expect(source).toContain('"Set up PIN"');
  expect(source).toContain("!isEnrollPin");
  expect(source).not.toContain("<Modal visible={false}");
});

test("PIN modal has modal, input, error, and 44 point control semantics", async () => {
  const source = await Bun.file(new URL("./pin-modal.tsx", import.meta.url)).text();
  expect(source).toContain("accessibilityViewIsModal");
  expect(source).toContain('"aria-modal": true');
  expect(source).toContain('accessibilityLabel="PIN"');
  expect(source).toContain('accessibilityHint="Enter a 6 to 8 digit PIN."');
  expect(source).toContain('accessibilityRole="alert"');
  expect(source).toContain('minHeight: 44');
  expect(source).toContain('animationType={reducedMotion ? "none" : "fade"}');
});

test("PIN modal renders the first-class long shell execution intent without a preview crop", async () => {
  const source = await Bun.file(new URL("./pin-modal.tsx", import.meta.url)).text();
  expect(source).toContain("const runShellTimeouts = activeChallenge?.kind === \"prove_it\"");
  expect(source).toContain("tool.name === \"run_shell\" && tool.runShellTimeout");
  expect(source).toContain("<RunShellTimeoutChallengeDetail");
  expect(source).toContain("Execution intent");
  expect(source).toContain("<Text selectable style={styles.runShellTimeoutReason}>{reason}</Text>");
});
