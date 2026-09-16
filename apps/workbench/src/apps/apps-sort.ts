/**
 * D344 — pure search + sort helpers for the full Apps page. Kept side-effect
 * free so the filtering/ordering is unit-testable without rendering the grid.
 */

import type { PublicMiniAppDto } from "@nautilo/api-client/browser";

export type AppSortKey = "name-asc" | "name-desc" | "newest" | "oldest";

export const APP_SORT_OPTIONS: ReadonlyArray<{ key: AppSortKey; label: string }> = [
  { key: "name-asc", label: "Name A–Z" },
  { key: "name-desc", label: "Name Z–A" },
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
];

export const DEFAULT_APP_SORT: AppSortKey = "name-asc";

function displayName(app: PublicMiniAppDto): string {
  return (app.name?.trim() || app.id).toLowerCase();
}

function installedTime(app: PublicMiniAppDto): number {
  if (!app.installedAt) return 0;
  const t = Date.parse(app.installedAt);
  return Number.isNaN(t) ? 0 : t;
}

export function filterApps(apps: PublicMiniAppDto[], query: string): PublicMiniAppDto[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return apps;
  return apps.filter((app) => {
    const name = (app.name ?? app.id).toLowerCase();
    const desc = (app.description ?? "").toLowerCase();
    return name.includes(q) || desc.includes(q) || app.id.toLowerCase().includes(q);
  });
}

export function sortApps(apps: PublicMiniAppDto[], sort: AppSortKey): PublicMiniAppDto[] {
  const copy = [...apps];
  switch (sort) {
    case "name-asc":
      return copy.sort((a, b) => displayName(a).localeCompare(displayName(b)));
    case "name-desc":
      return copy.sort((a, b) => displayName(b).localeCompare(displayName(a)));
    case "newest":
      return copy.sort((a, b) => installedTime(b) - installedTime(a));
    case "oldest":
      return copy.sort((a, b) => installedTime(a) - installedTime(b));
  }
}

export function filterAndSortApps(
  apps: PublicMiniAppDto[],
  query: string,
  sort: AppSortKey,
): PublicMiniAppDto[] {
  return sortApps(filterApps(apps, query), sort);
}
