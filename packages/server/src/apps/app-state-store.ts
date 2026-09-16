import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeMiniAppId } from "./app-manifest";
import { invalidateInstalledAppRegistry } from "./installed-app-registry";

/**
 * D343 — persisted per-instance disabled-app set.
 *
 * State file: `<appsRoot>/.app-state.json`, shape `{ "disabled": string[] }`.
 * Lives next to the `.nautilo-seed.json` markers under appsRoot. Read calls
 * are best-effort: a missing or unparseable file yields an empty set rather
 * than throwing, so a corrupt state file can never break app scanning.
 */

const STATE_FILE = ".app-state.json";

interface AppStateJson {
  disabled?: unknown;
}

function statePath(appsRoot: string): string {
  return join(appsRoot, STATE_FILE);
}

async function readDisabledArray(appsRoot: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(statePath(appsRoot), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    // Unreadable file: treat as empty rather than crashing scan/registration.
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const disabled = (parsed as AppStateJson).disabled;
  if (!Array.isArray(disabled)) return [];

  const safe: string[] = [];
  for (const entry of disabled) {
    if (typeof entry === "string" && isSafeMiniAppId(entry) && !safe.includes(entry)) {
      safe.push(entry);
    }
  }
  return safe;
}

export async function getDisabledAppIds(appsRoot: string): Promise<Set<string>> {
  return new Set(await readDisabledArray(appsRoot));
}

export async function isAppDisabled(appsRoot: string, appId: string): Promise<boolean> {
  const disabled = await getDisabledAppIds(appsRoot);
  return disabled.has(appId);
}

export async function setAppDisabled(
  appsRoot: string,
  appId: string,
  disabled: boolean,
): Promise<void> {
  if (!isSafeMiniAppId(appId)) {
    throw new Error(`invalid app id: ${appId}`);
  }

  const current = await readDisabledArray(appsRoot);
  const has = current.includes(appId);

  if (disabled && !has) {
    current.push(appId);
  } else if (!disabled && has) {
    const idx = current.indexOf(appId);
    if (idx >= 0) current.splice(idx, 1);
  } else {
    return; // already in desired state — idempotent no-op
  }

  await mkdir(appsRoot, { recursive: true });
  await writeFile(
    statePath(appsRoot),
    `${JSON.stringify({ disabled: current }, null, 2)}\n`,
    "utf8",
  );
  invalidateInstalledAppRegistry();
}
