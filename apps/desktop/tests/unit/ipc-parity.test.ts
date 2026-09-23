/**
 * IPC channel-name parity (preload ⊆ main handlers).
 *
 * Static-text test that asserts: every channel name string passed to
 * `ipcRenderer.invoke("...")` (or `ipcRenderer.send("...")`) in the
 * preload sources has a matching `ipcMain.handle("...")` (or
 * `ipcMain.on("...")`) registration in the main process source. The
 * reverse direction is intentionally NOT enforced — `main.ts` may
 * register handlers for short-lived per-window IPC (first-run picker,
 * onboarding wizard) that the global preloads don't expose.
 *
 * The failure mode this catches:
 *   - Renderer calls `nautiloDesktop.foo.bar(...)` → preload calls
 *     `ipcRenderer.invoke("foo:bar", ...)` → no `ipcMain.handle("foo:bar")`
 *     ever ran. The renderer's promise hangs and the user sees a UI
 *     stall with no log line.
 *
 * Scope: read source files as text. `electron` cannot be imported under
 * `bun:test` outside an Electron runtime, so we don't try to actually
 * register handlers. Static-text scan is fast, runs in CI, and catches
 * the typo / drop-in-rename failure mode.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeStaticSource } from "./static-source";

const desktopRoot = join(import.meta.dir, "../..");

const PRELOAD_FILES = [
  "electron/preload.ts",
  "electron/preload-first-run.ts",
  "electron/preload-onboarding.ts",
] as const;

const MAIN_FILES = [
  "electron/main.ts",
  "electron/companion-window.ts",
  "electron/fs-structural-ipc.ts",
  "electron/terminal-host.ts",
  "electron/passwords/ipc.ts",
] as const;

const RENDERER_PATTERN = /ipcRenderer\.(?:invoke|send)\(\s*["']([a-zA-Z0-9:_\-.]+)["']/g;
const MAIN_PATTERN = /ipcMain\.(?:handle|on)\(\s*["']([a-zA-Z0-9:_\-.]+)["']/g;

const ONBOARDING_METHOD_CHANNELS = {
  getServerUrl: "onboarding:get-server-url",
  complete: "onboarding:complete",
  cancel: "onboarding:cancel",
  loadExistingProfile: "onboarding:load-existing-profile",
  getConfigFlags: "onboarding:get-config-flags",
  getStartAt: "onboarding:get-start-at",
  getVoices: "onboarding:get-voices",
  previewVoice: "onboarding:preview-voice",
  listVoiceCatalog: "onboarding:list-voice-catalog",
  generateSoul: "onboarding:generate-soul",
  generateAvatar: "onboarding:generate-avatar",
  putProfile: "onboarding:put-profile",
  upsertVoiceAssignment: "onboarding:upsert-voice",
} as const;

/** Handlers in `passwords/ipc.ts` register via `PASSWORDS_CHANNELS.*` refs. */
const PASSWORDS_CHANNEL_LITERAL_PATTERN = /:\s*"(passwords:[^"]+)"/g;

function extractChannels(file: string, pattern: RegExp): string[] {
  const source = readFileSync(join(desktopRoot, file), "utf-8");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // Reset lastIndex on the shared regex literal between calls.
  pattern.lastIndex = 0;
  while ((m = pattern.exec(source)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

describe("IPC channel-name parity", () => {
  const preloadChannels = new Set<string>();
  for (const f of PRELOAD_FILES) {
    for (const ch of extractChannels(f, RENDERER_PATTERN)) preloadChannels.add(ch);
  }

  const mainChannels = new Set<string>();
  for (const f of MAIN_FILES) {
    for (const ch of extractChannels(f, MAIN_PATTERN)) mainChannels.add(ch);
    if (f === "electron/passwords/ipc.ts") {
      for (const ch of extractChannels(f, PASSWORDS_CHANNEL_LITERAL_PATTERN)) mainChannels.add(ch);
    }
  }

  test("preloads register at least one channel (non-empty extraction)", () => {
    expect(preloadChannels.size).toBeGreaterThan(0);
  });

  test("main.ts registers at least one handler (non-empty extraction)", () => {
    expect(mainChannels.size).toBeGreaterThan(0);
  });

  test("every preload channel has a main handler", () => {
    const orphans = [...preloadChannels].filter((ch) => !mainChannels.has(ch));
    if (orphans.length > 0) {
      throw new Error(
        `IPC parity violation — ${orphans.length} preload channel(s) without a main handler:\n` +
          orphans.map((c) => `  - "${c}"`).join("\n") +
          `\n\nEither (a) the channel name diverged between preload and main (typo / rename), ` +
          `or (b) main.ts dropped the handler. Check both sides.`,
      );
    }
    expect(orphans).toEqual([]);
  });

  test("binary-read session channels remain a complete preload/main contract", () => {
    for (const channel of ["binaryRead:open", "binaryRead:read", "binaryRead:close"]) {
      expect(preloadChannels.has(channel)).toBe(true);
      expect(mainChannels.has(channel)).toBe(true);
    }
  });

  test("binary-read IPC returns typed result envelopes rather than cloned Errors", () => {
    const main = normalizeStaticSource(
      readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8"),
    );
    const preload = readFileSync(join(desktopRoot, "electron/preload.ts"), "utf-8");
    expect(main).toContain("asBinaryReadSessionResult");
    expect(main).toContain("bindBinaryReadSender(e.sender)");
    expect(main).toContain('sender.on("did-start-navigation", onDidStartNavigation)');
    expect(preload).toContain("type BinaryReadSessionResult<T>");
    expect(preload).toContain("error: { code: BinaryReadSessionErrorCode }");
  });

  test("onboarding preload is type-checked against the shared UI port", () => {
    const preload = readFileSync(join(desktopRoot, "electron/preload-onboarding.ts"), "utf-8");
    const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");

    expect(preload).toContain('from "@nautilo/genie-customization-ui/types"');
    expect(preload).toContain("OnboardingAPI,");
    expect(preload).toContain("const api: OnboardingAPI = {");
    expect(preload).not.toContain("interface OnboardingAPI {");
    expect(preload).not.toContain("interface ProfileWriteInput {");
    expect(main).toContain("ProfileSnapshot as WizardProfileSnapshot,");
    expect(main).toContain("IpcResult,");
    expect(main).not.toContain("interface WizardProfileSnapshot {");
  });

  test("every shared onboarding RPC has one reviewed preload channel and main handler", () => {
    const preload = readFileSync(join(desktopRoot, "electron/preload-onboarding.ts"), "utf-8");
    const main = normalizeStaticSource(
      readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8"),
    );

    for (const [method, channel] of Object.entries(ONBOARDING_METHOD_CHANNELS)) {
      expect(preload).toMatch(
        new RegExp(`${method}:\\s*[^\\n]*[\\s\\S]{0,180}?ipcRenderer\\.invoke\\("${channel}"`),
      );
      expect(main).toContain(`ipcMain.handle("${channel}"`);
    }
    expect(preload).toContain('ipcRenderer.on("onboarding:soul-generation-event", listener)');
    expect(preload).toContain('ipcRenderer.on("onboarding:avatar-generation-event", listener)');
  });

  test("malformed or unavailable onboarding inputs return structured envelopes", () => {
    const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");

    // main.ts is intentionally not imported in Bun unit tests because Electron
    // is unavailable there. These assertions exercise its reviewed handler
    // seams and prevent malformed IPC inputs from becoming thrown rejections.
    for (const expectedError of [
      "list-voice-catalog query must be an object",
      "preview-voice requires object",
      "voiceId must be a string",
      "put-profile requires object",
      "Invalid Agent photo selection",
      "upsert-voice requires object",
      "language is required",
      "ref is required",
      "ref.voiceId and ref.voiceName must be strings",
      "Sign in before generating an Agent photo",
    ]) {
      expect(main).toContain(`ipcErr("${expectedError}")`);
    }
    expect(main).toContain('return ipcErr("sender mismatch")');
    expect(main).toContain("return { ok: false, error: msg };");
  });

  test("companion owner handlers are registered and sender-gated in their narrow module", () => {
    const companion = normalizeStaticSource(
      readFileSync(join(desktopRoot, "electron/companion-window.ts"), "utf-8"),
    );
    for (const channel of ["enable", "pick-files", "disable", "publish"]) {
      const start = companion.indexOf(`ipcMain.handle("companion:${channel}"`);
      expect(start).toBeGreaterThan(-1);
      const next = companion.indexOf("ipcMain.handle(", start + 1);
      const handler = companion.slice(start, next === -1 ? undefined : next);
      expect(handler).toContain("this.requireOwner(event)");
    }
  });

  test("snapshot the preload channel set so renames surface in code review", () => {
    // Exact names catch additions, removals and same-count renames. This
    // reviewed fixture replaces the old count range, which could miss all
    // three. The quit guard adds register/unregister/result channels.
    const expected: unknown = JSON.parse(readFileSync(
      join(import.meta.dir, "ipc-parity.channels.json"), "utf-8",
    ));
    expect([...preloadChannels].sort()).toEqual(expected);
  });
});
