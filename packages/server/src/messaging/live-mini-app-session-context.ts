import { getAppsRoot } from "@nautilo/config";
import type {
  LiveMiniAppSessionCapability,
  TrustedLiveMiniAppSessionContext,
} from "@nautilo/types";
import { parseLiveDocumentVersion } from "@nautilo/types";
import { scanInstalledApps } from "../apps/app-registry";
import {
  liveMiniAppSessionRegistry,
  type LiveMiniAppSessionRegistry,
} from "../apps/live-mini-app-session-registry";

function isCapability(raw: unknown): raw is LiveMiniAppSessionCapability {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  const documentVersion = parseLiveDocumentVersion(value["documentVersion"]);
  return (
    typeof value["sessionToken"] === "string" &&
    value["sessionToken"].length >= 32 &&
    typeof value["sessionId"] === "string" &&
    value["sessionId"].length > 0 &&
    documentVersion !== null
  );
}

/**
 * Converts a host-provided opaque session into the only prompt-eligible
 * context. App identity and instructions are derived from the registry and
 * installed manifest; neither can be supplied by an iframe or request body.
 */
export async function resolveTrustedLiveMiniAppSession(args: {
  raw: unknown;
  userId: string;
  appsRoot?: string;
  registry?: Pick<LiveMiniAppSessionRegistry, "validateForSubject">;
}): Promise<TrustedLiveMiniAppSessionContext | null> {
  if (!args.userId || !isCapability(args.raw)) return null;
  const documentVersion = parseLiveDocumentVersion(args.raw.documentVersion);
  if (!documentVersion) return null;
  const registry = args.registry ?? liveMiniAppSessionRegistry;
  const installed = await scanInstalledApps(args.appsRoot ?? getAppsRoot()).catch(() => []);

  // A token never selects its own app: use the installed manifest id only
  // after comparing every possible installed live-review app with registry
  // binding validation.
  for (const app of installed) {
    const manifest = app.status === "ready" && app.enabled ? app.manifest : null;
    if (!manifest?.liveReview?.enabled || !manifest.agent?.instructions) continue;
    const validated = registry.validateForSubject(args.raw.sessionToken, {
      appId: manifest.id,
      userId: args.userId,
      documentVersion,
    });
    if (!validated.ok || validated.sessionId !== args.raw.sessionId) continue;
    return {
      appId: manifest.id,
      sessionToken: args.raw.sessionToken,
      sessionId: validated.sessionId,
      documentVersion: validated.binding.documentVersion,
      instructions: manifest.agent.instructions,
    };
  }
  return null;
}
