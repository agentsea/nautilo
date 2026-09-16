/**
 * Shared CLI URL resolution + setup-status human formatting (D112 Phase 9).
 */
import { resolveInstance } from "@nautilo/config";
import type { SetupStatusResponse } from "./schemas/setup-status";

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

export type ResolveCliServerUrlInput = {
  /** `--server` wins when set (after trim). */
  serverFlag?: string | undefined;
  /** Template `[serverUrl]` — between env and default instance URL. */
  templateServerUrl?: string | undefined;
};

/**
 * Precedence for `nautilo setup` / template flows (Phase 9 pre-flight):
 * `--server` > template `serverUrl` > `NAUTILO_SERVER_URL` >
 * `resolveInstance().server.url`.
 *
 * For other CLIs (e.g. `nautilo status` without a template), omit
 * `templateServerUrl` so env beats instance default as usual.
 */
export function resolveCliServerUrl(input?: ResolveCliServerUrlInput): string {
  const fromFlag = input?.serverFlag?.trim();
  if (fromFlag) return normalizeBaseUrl(fromFlag);
  const fromTemplate = input?.templateServerUrl?.trim();
  if (fromTemplate) return normalizeBaseUrl(fromTemplate);
  const fromEnv = process.env["NAUTILO_SERVER_URL"]?.trim();
  if (fromEnv) return normalizeBaseUrl(fromEnv);
  return normalizeBaseUrl(resolveInstance().server.url);
}

/** @deprecated Prefer {@link resolveCliServerUrl}; kept for dev-tool parity. */
export function getDevServerBaseUrl(): string {
  return resolveCliServerUrl();
}

export function formatSetupStatusHuman(
  baseUrl: string,
  body: SetupStatusResponse,
): string {
  const lines: string[] = [];
  lines.push(`Server:     ${baseUrl}`);
  lines.push(`Instance:   ${body.instanceId}`);
  lines.push(`Mode:       ${body.deploymentMode}`);
  lines.push(`setupState: ${body.setupState}`);
  lines.push(`claimReq:   ${body.claimRequired}`);
  if (body.viewer) {
    lines.push(
      `viewer:     canManageServerSettings=${body.viewer.canManageServerSettings} genieCustomized=${body.viewer.genieCustomized} byok=${body.viewer.byokConfigured}`,
    );
  } else {
    lines.push("viewer:     (omitted — unauthenticated guest snapshot)");
  }
  if (body.providers) {
    lines.push(
      `providers:  hasLlm=${body.providers.hasLlm} managedByCloud=${body.providers.managedByCloud}`,
    );
  }
  if (body.recommendedSetupSurface) {
    lines.push(
      `surface:    ${body.recommendedSetupSurface.kind} → ${body.recommendedSetupSurface.url ?? "null"}`,
    );
  }
  if (body.claimInvitePathHint != null) {
    lines.push(`claimHint:  ${body.claimInvitePathHint}`);
  }
  return `${lines.join("\n")}\n`;
}
