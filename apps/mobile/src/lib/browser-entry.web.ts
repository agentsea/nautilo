export function currentServingOrigin(locationLike: Pick<Location, "origin"> | null): string | null {
  if (!locationLike) return null;
  try {
    const parsed = new URL(locationLike.origin);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    const origin = parsed.origin;
    return origin.startsWith("https://") || /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)
      ? origin
      : null;
  } catch {
    return null;
  }
}

export function fullWorkbenchUrl(origin: string): string {
  return new URL("/?nautilo-interface=workbench", origin).href;
}

export function independentMobileWebUrl(raw: string): string | null {
  try {
    const candidate = new URL(raw.trim());
    if (candidate.username || candidate.password) return null;
    const origin = currentServingOrigin(candidate);
    return origin ? new URL("/mobile", origin).href : null;
  } catch {
    return null;
  }
}
