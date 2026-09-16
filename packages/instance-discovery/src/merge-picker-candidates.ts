import type { DiscoveredNautiloService, LocalInstanceRow } from "./types";

export type PickerCandidate = {
  label: string;
  url: string;
  source: "layout" | "mdns";
};

export function normalizeServerUrlKey(url: string): string {
  return url.trim().replace(/\/$/, "").toLowerCase();
}

/**
 * Merge layout rows + mDNS hits into a de-duplicated, sorted list (D112 §12.0).
 */
export function mergePickerCandidates(
  layoutRows: LocalInstanceRow[],
  browseResults: DiscoveredNautiloService[],
  readUrlFromRoot: (root: string) => string | null,
): PickerCandidate[] {
  const map = new Map<string, PickerCandidate>();
  for (const row of layoutRows) {
    if (row.state !== "running") continue;
    const url = readUrlFromRoot(row.root);
    if (!url) continue;
    const k = normalizeServerUrlKey(url);
    if (!map.has(k)) {
      map.set(k, {
        label: `${row.projectName} — ${url}`,
        url,
        source: "layout",
      });
    }
  }
  for (const s of browseResults) {
    const url = s.serverUrl.replace(/\/$/, "");
    const k = normalizeServerUrlKey(url);
    if (!map.has(k)) {
      map.set(k, {
        label: `${s.name} — ${url}`,
        url,
        source: "mdns",
      });
    }
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}
