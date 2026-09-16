import type { DesktopConfig } from "./config-schema";

export type SwitchServerDecision =
  | { relaunch: false }
  | {
      relaunch: true;
      config: DesktopConfig;
      nextEnv: { NAUTILO_CONNECT_SERVER_URL: string };
    };

/**
 * Pure switch-server commit decision.
 *
 * Packaged builds read `config.json` on relaunch, but dev-from-source mode
 * defaults back to the local dev stack when no connect URL is present.
 * Carry the picked URL through the next process env so both modes land on
 * the same selected server after relaunch.
 */
export function decideSwitchServerCommit(
  picked: DesktopConfig | null,
): SwitchServerDecision {
  const serverUrl = picked?.serverUrl?.trim();
  if (!picked || picked.mode !== "connect" || !serverUrl) {
    return { relaunch: false };
  }
  return {
    relaunch: true,
    config: { ...picked, serverUrl },
    nextEnv: { NAUTILO_CONNECT_SERVER_URL: serverUrl },
  };
}
