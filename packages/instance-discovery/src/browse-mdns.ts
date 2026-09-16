import Bonjour, { type Browser, type Service } from "bonjour-service";
import type { BrowseLocalInstancesDeps, DiscoveredNautiloService } from "./types";

type BonjourLike = {
  find: (options: { type: string; protocol: "tcp" }, onUp: (service: Service) => void) => Browser;
  destroy: () => void;
};

type BonjourFactory = (onError: (error: unknown) => void) => BonjourLike;

function createBonjourWithErrorBridge(onError: (error: unknown) => void): BonjourLike {
  const bonjour = new Bonjour({}, onError);
  const mdns = (bonjour as unknown as {
    server?: { mdns?: { on?: (event: string, listener: (error: unknown) => void) => void } };
  }).server?.mdns;
  if (typeof mdns?.on !== "function") {
    bonjour.destroy();
    throw new Error("bonjour-service multicast error bridge is unavailable");
  }
  mdns.on("error", onError);
  return bonjour;
}

function txtRecordToPlain(txt: unknown): Record<string, string> {
  if (!txt || typeof txt !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(txt as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    } else if (v !== undefined && v !== null) {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}

function pickConnectHost(service: {
  host: string;
  addresses?: readonly string[] | undefined;
}): string {
  const addrs = service.addresses ?? [];
  const v4 = addrs.find((a) => !a.includes(":"));
  if (v4) return v4;
  if (addrs.length > 0) return addrs[0]!;
  return service.host.replace(/\.$/, "");
}

/** Wrap IPv6 literals for `http://` URL construction. */
function hostForHttpUrl(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }
  return host;
}

/**
 * Browse LAN for `_nautilo._tcp` services (same type the server publishes in
 * `packages/server/src/lib/mdns.ts`). Collects for `timeoutMs` then stops the
 * browser and destroys the Bonjour stack.
 *
 * **Platform**: requires multicast DNS (works on typical macOS/Linux
 * desktops; Windows depends on Bonjour Print Services / Apple Bonjour
 * being installed for some setups).
 */
export async function browseLocalInstances(
  deps: BrowseLocalInstancesDeps = {},
  createBonjour: BonjourFactory = createBonjourWithErrorBridge,
): Promise<DiscoveredNautiloService[]> {
  const timeoutMs = deps.timeoutMs ?? 2000;
  const out: DiscoveredNautiloService[] = [];
  const seen = new Set<string>();
  return await new Promise<DiscoveredNautiloService[]>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let browser: Browser | undefined;
    let bonjour: BonjourLike | undefined;
    let hasPendingError = false;
    let pendingError: unknown;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try { browser?.stop(); } catch { /* best-effort */ }
      try { bonjour?.destroy(); } catch { /* best-effort */ }
      if (error !== undefined) {
        reject(error instanceof Error ? error : new Error("mDNS browse failed", { cause: error }));
      }
      else resolve(out);
    };
    const onError = (error: unknown): void => {
      const reason = error ?? new Error("mDNS browse failed without error detail");
      if (bonjour === undefined) {
        hasPendingError = true;
        pendingError = reason;
      } else finish(reason);
    };
    try {
      bonjour = createBonjour(onError);
      if (hasPendingError) {
        finish(pendingError ?? new Error("mDNS browse failed without error detail"));
        return;
      }
      const foundBrowser = bonjour.find({ type: "nautilo", protocol: "tcp" }, (service) => {
        const key = `${service.name}\0${service.port}\0${service.host}`;
        if (seen.has(key)) return;
        seen.add(key);
        const host = hostForHttpUrl(pickConnectHost(service));
        const serverUrl = `http://${host}:${service.port}`;
        out.push({
          name: service.name,
          host: service.host,
          port: service.port,
          addresses: [...(service.addresses ?? [])],
          serverUrl,
          txt: txtRecordToPlain(service.txt),
        });
      });
      browser = foundBrowser;
      if (settled) {
        try { foundBrowser.stop(); } catch { /* best-effort */ }
        return;
      }
      timer = setTimeout(() => finish(), timeoutMs);
    } catch (error) {
      finish(error);
    }
  });
}
