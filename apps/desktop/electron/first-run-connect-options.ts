import { homedir } from "node:os";
import { mergePickerCandidates, type PickerCandidate } from "@nautilo/instance-discovery";
import {
  browseLocalInstances,
  listLocalInstances,
  readPersistedTuiServerTarget,
  readServerUrlFromLayoutRoot,
} from "@nautilo/instance-discovery/node";
import { listRecentServers, type RecentServerEntry } from "./recent-servers";
import { recentServerDedupeKey } from "./recent-servers-schema";

export type FirstRunConnectTargets = {
  candidates: PickerCandidate[];
  recentServers: RecentServerEntry[];
  suggestedUrl: string | null;
  localDiscovery: LocalDiscoveryStatus;
};

/**
 * This is intentionally a narrow report of what the runtime actually tells
 * us. "completed" means only that the bounded browse finished; an empty result
 * is not evidence that macOS granted Local Network access. bonjour-service does
 * not expose TCC state, so failures are only "unavailable", never "denied".
 */
export type LocalDiscoveryStatus =
  | { readonly kind: "completed" }
  | { readonly kind: "unavailable" };

/**
 * D112 Phase 4.4 — layout + mDNS discovery for the Electron first-run
 * "Connect" flow without hardcoded ports.
 */
export async function getFirstRunConnectTargets(): Promise<FirstRunConnectTargets> {
  const home = homedir();
  const [layoutRowsResult, browseHitsResult] = await Promise.allSettled([
    Promise.resolve(listLocalInstances(home)),
    browseLocalInstances({ timeoutMs: 2000 }),
  ]);
  const layoutRows = layoutRowsResult.status === "fulfilled" ? layoutRowsResult.value : [];
  const browseHits = browseHitsResult.status === "fulfilled" ? browseHitsResult.value : [];
  const localDiscovery: LocalDiscoveryStatus = browseHitsResult.status === "fulfilled"
    ? { kind: "completed" }
    : { kind: "unavailable" };
  const recentServers = listRecentServers();
  const recentKeys = new Set(recentServers.map((s) => recentServerDedupeKey(s.url)));
  const candidates = mergePickerCandidates(
    layoutRows,
    browseHits,
    readServerUrlFromLayoutRoot,
  ).filter((c) => !recentKeys.has(recentServerDedupeKey(c.url)));
  return {
    candidates,
    recentServers,
    suggestedUrl: readPersistedTuiServerTarget(),
    localDiscovery,
  };
}
