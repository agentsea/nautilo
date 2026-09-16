import type { PublicMiniAppDto } from "./app-routes";
import { weakETagFromDigestInput } from "../http/conditional-http";

/** Stable JSON input for list hashing; does not mutate or reorder the live body. */
export function canonicalAppsListProjectionForHash(body: {
  apps: PublicMiniAppDto[];
}): { apps: PublicMiniAppDto[] } {
  return {
    apps: [...body.apps].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function appsListWeakETagFromProjection(
  registryGeneration: number,
  body: { apps: PublicMiniAppDto[] },
): string {
  const canonical = canonicalAppsListProjectionForHash(body);
  return weakETagFromDigestInput(`${registryGeneration}:${JSON.stringify(canonical)}`);
}

export function appsDetailWeakETagFromProjection(
  registryGeneration: number,
  app: PublicMiniAppDto,
): string {
  return weakETagFromDigestInput(`${registryGeneration}:${JSON.stringify(app)}`);
}
