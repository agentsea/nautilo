import { isPreAdmissionRequest } from "@nautilo/types";

const JOURNAL_KEY = "nautilo:live-mini-app-cleanup";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Entry = { appId: string; clientSessionId: string };
type Environment = {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  locks: {
    request(name: string, options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: object | null) => Promise<void>): Promise<void>;
  } | undefined;
  onPageHide: (callback: (persisted: boolean) => void) => void;
};
class CleanupResponseError extends Error {
  constructor(readonly response: Response) {
    super("Could not release the previous document editor. Retry when connected.");
  }
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
async function responseRecord(response: Response): Promise<Record<string, unknown> | null> {
  const body: unknown = await response.clone().json().catch(() => null);
  return record(body);
}
function requestRecord(body: BodyInit | null | undefined): Record<string, unknown> | null {
  if (typeof body !== "string") return null;
  try { const parsed: unknown = JSON.parse(body); return record(parsed); } catch { return null; }
}

/** API-client transport for exact editor cleanup. Persist cleanup IDs before
 * issuance, never session tokens, bearer credentials or document content.
 * A browser lock owns each live cleanup ID. Any replacement document can
 * recover abandoned IDs, while a duplicated tab cannot cancel its live opener.
 * The server binds cancellation to the authenticated user and app, and fences
 * creation that arrives after cancellation.
 */
export function createLiveSessionFetch(transport: typeof fetch, env: Environment): typeof fetch {
  const entries = new Map<string, Entry>();
  const pending = new Set<string>();
  const copied = new Set<string>();
  const headersById = new Map<string, Headers>();
  const idByToken = new Map<string, string>();
  const revocations = new Map<string, Promise<void>>();
  // Web Locks are scoped to this origin and automatically released when a
  // document is destroyed. Unlike NavigationTiming, they prove whether a
  // copied cleanup ID still belongs to a live document; no timeout guesses.
  const ownership = new Map<string, { ready: Promise<boolean>; release: () => void }>();
  const claim = (id: string): Promise<boolean> => {
    const existing = ownership.get(id);
    if (existing) return existing.ready;
    if (!env.locks) return Promise.reject(new Error("This browser cannot safely coordinate document editors. Enable Web Locks and try again."));
    let resolve!: (owned: boolean) => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
    let release!: () => void;
    const lifetime = new Promise<void>((done) => { release = done; });
    const owner = { ready, release: () => { ownership.delete(id); release(); } };
    ownership.set(id, owner);
    void env.locks.request(`${JOURNAL_KEY}:${id}`, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) { ownership.delete(id); resolve(false); return; }
      resolve(true);
      await lifetime;
    }).catch((error: unknown) => { ownership.delete(id); reject(error); });
    return ready;
  };
  let leaving = false;
  let recovery: Promise<void> | null = null;
  try {
    const saved: unknown = JSON.parse(env.storage.getItem(JOURNAL_KEY) ?? "[]");
    if (Array.isArray(saved)) {
      for (const value of saved as unknown[]) {
        const item = record(value);
        if (item && typeof item.appId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(item.appId)
          && typeof item.clientSessionId === "string" && UUID_V4.test(item.clientSessionId)) {
          entries.set(item.clientSessionId, { appId: item.appId, clientSessionId: item.clientSessionId });
          pending.add(item.clientSessionId);
        }
      }
    }
  } catch { /* Disabled storage still permits pagehide cleanup. */ }
  const persist = () => {
    try {
      if (entries.size) env.storage.setItem(JOURNAL_KEY, JSON.stringify([...entries.values()]));
      else env.storage.removeItem(JOURNAL_KEY);
    } catch { /* Do not copy cleanup state into another persistence surface. */ }
  };
  persist();
  const forget = (id: string) => {
    ownership.get(id)?.release();
    entries.delete(id);
    pending.delete(id);
    copied.delete(id);
    headersById.delete(id);
    for (const [token, entryId] of idByToken) if (entryId === id) idByToken.delete(token);
    persist();
  };
  const revoke = (entry: Entry, headers: Headers): Promise<void> => {
    const existing = revocations.get(entry.clientSessionId);
    if (existing) return existing;
    pending.add(entry.clientSessionId);
    const operation = (async () => {
      if (!(await claim(entry.clientSessionId))) {
        // This is copied sessionStorage owned by another live document.
        // Retain it for the next mutation: its owner may leave and fail
        // cleanup after this check. Do not block writes while it is live.
        pending.delete(entry.clientSessionId);
        copied.add(entry.clientSessionId);
        return;
      }
      const cleanupHeaders = new Headers(headers);
      cleanupHeaders.set("Content-Type", "application/json");
      const response = await transport(`/api/apps/${encodeURIComponent(entry.appId)}/live-session/revoke`, {
        method: "POST", headers: cleanupHeaders,
        body: JSON.stringify({ clientSessionId: entry.clientSessionId }), keepalive: true,
      });
      if (!response.ok) throw new CleanupResponseError(response);
      forget(entry.clientSessionId);
    })().finally(() => { revocations.delete(entry.clientSessionId); });
    revocations.set(entry.clientSessionId, operation);
    return operation;
  };
  env.onPageHide((persisted) => {
    if (persisted) return; // BFCache suspends an editor that can resume.
    leaving = true;
    for (const entry of entries.values()) {
      const headers = headersById.get(entry.clientSessionId);
      if (headers) void revoke(entry, headers).catch(() => {});
    }
    // The page has committed to leaving. Its successor may recover even if
    // the keepalive request fails or its response never reaches this realm.
    for (const owner of ownership.values()) owner.release();
  });
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, "http://localhost").pathname;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const match = /^\/api\/apps\/([^/]+)\/live-session(?:\/(refresh|revoke))?$/.exec(path);
    const cleanup = method === "POST" && match?.[2] === "revoke";
    // Fence API-client mutations (including agent messages) behind cleanup.
    // Reads and sign-in/admission recovery remain available; no write is replayed.
    if (!cleanup && method !== "GET" && method !== "HEAD"
      && !isPreAdmissionRequest(method, path) && headers.has("authorization")) {
      if (!recovery) for (const id of copied) pending.add(id);
      if (!recovery && pending.size) {
        recovery = (async () => {
          while (pending.size) {
            for (const id of [...pending]) {
              const entry = entries.get(id);
              if (entry) await revoke(entry, headers);
              else pending.delete(id);
            }
          }
        })().finally(() => { recovery = null; });
      }
      if (recovery) {
        try { await recovery; } catch (error) {
          // Let the API client's existing bearer-refresh owner retry cleanup;
          // the original mutation has not been dispatched.
          if (error instanceof CleanupResponseError && error.response.status === 401) return error.response;
          throw error;
        }
      }
    }
    const body = requestRecord(init?.body);
    const token = typeof body?.sessionToken === "string" ? body.sessionToken : undefined;
    const existingId = token ? idByToken.get(token) : undefined;
    if (cleanup && existingId) {
      const entry = entries.get(existingId);
      if (entry) {
        try { await revoke(entry, headers); } catch (error) {
          if (error instanceof CleanupResponseError) return error.response;
          throw error;
        }
        return Response.json({ ok: true });
      }
    }
    let issued: Entry | undefined;
    if (method === "POST" && match && !match[2] && body) {
      issued = { appId: decodeURIComponent(match[1]), clientSessionId: crypto.randomUUID() };
      if (!(await claim(issued.clientSessionId)) || leaving) {
        forget(issued.clientSessionId);
        return Response.json({ error: "session_closed" }, { status: 409 });
      }
      entries.set(issued.clientSessionId, issued);
      headersById.set(issued.clientSessionId, headers);
      persist(); // Before dispatch, so a destroyed realm need not see the response.
      // Preparation itself holds no document lock. If the realm disappears
      // before its response, no later issuance can be sent by this page.
      let prepared: Response;
      try {
        prepared = await transport(`${path}/prepare`, {
          method: "POST", headers,
          body: JSON.stringify({ clientSessionId: issued.clientSessionId }),
        });
      } catch (error) { pending.add(issued.clientSessionId); throw error; }
      if (!prepared.ok) {
        if ([400, 401, 403, 404].includes(prepared.status)) forget(issued.clientSessionId);
        else pending.add(issued.clientSessionId);
        return prepared;
      }
      const receipt = await responseRecord(prepared);
      if (leaving || typeof receipt?.issuanceToken !== "string") {
        await revoke(issued, headers);
        return Response.json({ error: "session_closed" }, { status: 409 });
      }
      init = { ...init, body: JSON.stringify({ ...body, clientSessionId: issued.clientSessionId, issuanceToken: receipt.issuanceToken }) };
    } else if (existingId) headersById.set(existingId, headers);
    let response: Response;
    try { response = await transport(input, cleanup ? { ...init, keepalive: true } : init); }
    catch (error) {
      if (issued) pending.add(issued.clientSessionId); // Unknown issuance outcome.
      throw error;
    }
    if (issued) {
      if (response.ok) {
        const capability = await responseRecord(response);
        if (typeof capability?.sessionToken === "string" && entries.has(issued.clientSessionId)) {
          idByToken.set(capability.sessionToken, issued.clientSessionId);
        }
        if (leaving) void revoke(issued, headers).catch(() => {});
      } else if ([400, 401, 403, 404, 409].includes(response.status)) forget(issued.clientSessionId);
      else pending.add(issued.clientSessionId);
    }
    return response;
  };
}

export function withLiveSessionCleanup(transport: typeof fetch): typeof fetch {
  if (typeof window === "undefined") return transport;
  try {
    return createLiveSessionFetch(transport, {
      storage: window.sessionStorage,
      locks: navigator.locks,
      onPageHide: (callback) => window.addEventListener("pagehide", (event) => callback(event.persisted)),
    });
  } catch { return transport; }
}
