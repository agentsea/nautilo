/**
 * Persistent desktop configuration (D057 2a.2).
 *
 * Stores the user's first-run choice: which deployment mode to use and,
 * for connect mode, which server URL. Lives alongside workspace.json in
 * the Electron userData directory.
 *
 * Missing file → first-run picker. Schema mismatch → first-run picker.
 * This is the single source of truth for "what mode is this install in?"
 * at boot.
 *
 * Schema + parser live in config-schema.ts (zero-dep, unit-testable).
 * This file owns the electron-specific path resolution + disk I/O.
 *
 * NOTE: don't import this from anywhere that runs before `app.whenReady`.
 * `app.getPath("userData")` is only reliable once the app has initialized.
 * Callers inside boot() or later are safe.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  clearDesktopConfigFile,
  configForActiveConnection,
  configForLegacyActiveConnection,
  configForVerifiedLegacyActiveConnection,
  CONFIG_VERSION,
  parseConfig,
  withCodexConnectionIntent,
  withHermesConnectionIntent,
  writeDesktopConfigAtomically,
  type DesktopConfig,
} from "./config-schema";
import { configFilePath } from "./paths";

// Re-export the one type main.ts needs for function signatures; tests
// and other callers that want the pure parser/version import from
// ./config-schema directly.
export type { DesktopConfig };

/**
 * Load the persisted config, or null if none exists / is malformed.
 * Callers should treat null as "run the first-run picker".
 */
export function loadConfig(): DesktopConfig | null {
  const p = configFilePath();
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseConfig(parsed);
}

/**
 * Write the config atomically: write to a temp sibling, then rename.
 * Guards against a torn file on crash mid-write — we either have the
 * old good config or the new good config, never a half-written JSON.
 */
export function saveConfig(cfg: DesktopConfig): void {
  if (cfg.version !== CONFIG_VERSION) {
    throw new Error(
      `saveConfig: version must be ${String(CONFIG_VERSION)}, got ${String((cfg as { version: unknown }).version)}`,
    );
  }
  if (cfg.mode !== "connect") {
    throw new Error(`saveConfig: only connect mode is supported`);
  }
  if (!cfg.serverUrl) {
    throw new Error(`saveConfig: connect mode requires serverUrl`);
  }
  const p = configFilePath();
  writeDesktopConfigAtomically({
    filePath: p,
    directoryPath: dirname(p),
    config: cfg,
    temporaryId: randomUUID(),
    fs: { mkdirSync, openSync, writeFileSync, closeSync, renameSync, unlinkSync },
  });
}

/**
 * Builds the sole durable active-pairing handoff snapshot. The revision source
 * is private to this authority owner, so a coordinator can name an attempt
 * but cannot smuggle in a URL-derived or reused revision.
 */
export function configForCommittedActiveConnection(
  current: DesktopConfig | null,
  input: Readonly<{ serverUrl: string; connectionAttemptId: string; serverFingerprint: string }>,
): DesktopConfig {
  return configForActiveConnection(current, input, { mintRevision: randomUUID });
}

/** Stamp markerless legacy A before network without claiming server identity. */
export function configForLegacyConnectionGuard(
  current: DesktopConfig,
): DesktopConfig {
  return configForLegacyActiveConnection(current, {
    connectionAttemptId: `legacy-${randomUUID()}`,
  }, { mintRevision: randomUUID });
}

/** Complete a legacy guard only from a freshly verified exact cold boot. */
export function configForVerifiedLegacyConnection(
  current: DesktopConfig,
  input: Readonly<{ serverUrl: string; serverFingerprint: string }>,
): DesktopConfig {
  return configForVerifiedLegacyActiveConnection(current, input);
}

/** Persist only the optional Codex connection intent in the existing config. */
export function saveCodexConnectionIntent(serverUrl: string, enabled: boolean): void {
  saveConfig(withCodexConnectionIntent(loadConfig(), serverUrl, enabled));
}

/** Persist only the Hermes connection owner choice in the existing config. */
export function saveHermesConnectionIntent(serverUrl: string, enabled: boolean): void {
  saveConfig(withHermesConnectionIntent(loadConfig(), serverUrl, enabled));
}

/**
 * Remove the persisted desktop connection choice. This is intentionally
 * narrower than resetting userData: it leaves installation identity, tokens,
 * relay state, and every other desktop preference untouched. Missing config is
 * a successful no-op so an explicit Forget can be retried safely.
 */
export function clearDesktopConfig(filePath = configFilePath()): void {
  clearDesktopConfigFile(filePath, { unlinkSync });
}

/**
 * D557 — non-secret, Electron-owned desired startup posture. It is adjacent
 * to config.json so it shares the installation/profile boundary without
 * overloading connection configuration or creating a renderer store.
 */
export function readyToWorkStateFilePath(): string {
  return join(dirname(configFilePath()), "ready-to-work.json");
}

export function readyToWorkProtectedReceiptFilePath(): string {
  return join(dirname(configFilePath()), "ready-to-work-workstation-receipt.bin");
}
