import { isPreAdmissionRequest } from "@nautilo/types";
import { AdmissionResponse } from "./admission-response";
import {
  assertCryptoAdmissionAccess,
  getCryptoAdmissionSnapshot,
  isCryptoAdmissionAllowed,
  requestCryptoAdmissionRefresh,
  subscribeCryptoAdmissionAccess,
} from "./crypto-admission-access";

/** A paused read waits without clearing its caller's current projection. Writes
 * are never queued or replayed. Server admission remains authoritative. */
async function waitForReadAdmission(identity: string | null, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  if (getCryptoAdmissionSnapshot().identity !== identity) {
    throw new Error("The workspace identity changed during a request.");
  }
  if (isCryptoAdmissionAllowed()) return;
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = (): void => {};
    const finish = (error?: unknown): void => {
      unsubscribe();
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error instanceof Error ? error : new Error("The request was aborted."));
      else resolve();
    };
    const abort = (): void => finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    const check = (): void => {
      const next = getCryptoAdmissionSnapshot();
      if (next.identity !== identity || next.status === "blocked") {
        finish(new Error("Workspace access is no longer available."));
      } else if (isCryptoAdmissionAllowed()) finish();
    };
    unsubscribe = subscribeCryptoAdmissionAccess(check);
    signal?.addEventListener("abort", abort, { once: true });
    check();
  });
}

export function createAdmissionFetch(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, typeof window === "undefined" ? "http://localhost" : window.location.origin).pathname;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const signal = init?.signal ?? request?.signal;
    // Exact recovery/control inventory, shared with server admission. No broad
    // /admin or /protected bypass. Pre-gate sign-in pages remain unaffected.
    if (isPreAdmissionRequest(method, path)) return transport(input, init);
    const identity = getCryptoAdmissionSnapshot().identity;
    const read = method === "GET" || method === "HEAD";
    for (;;) {
      if (read) await waitForReadAdmission(identity, signal);
      assertCryptoAdmissionAccess();
      const generation = getCryptoAdmissionSnapshot().generation;
      const response = await transport(input, init);
      if (getCryptoAdmissionSnapshot().identity !== identity) {
        await response.body?.cancel();
        throw new Error("Workspace access changed while the request was in flight.");
      }
      if (!response.ok) {
        if (getCryptoAdmissionSnapshot().generation !== generation) {
          await response.body?.cancel();
          throw new Error("Workspace access changed while the request was in flight.");
        }
        // Direct product fetches and the API client share the same invalidation
        // owner. Never let a late denial invalidate a different installation.
        if ((response.status === 428 || response.status === 503)
          && getCryptoAdmissionSnapshot().generation === generation) {
          const body = await response.clone().json().catch(() => null) as { code?: unknown } | null;
          if (getCryptoAdmissionSnapshot().generation === generation
            && (body?.code === "device_admission_required"
              || body?.code === "device_admission_expired"
              || body?.code === "device_removed_or_stale"
              || body?.code === "device_admission_unavailable")) {
            requestCryptoAdmissionRefresh(body.code);
            // Keep only the typed, content-free denial after access is closed.
            // No stale server body is exposed through this recovery signal.
            await response.body?.cancel();
            return Response.json({ code: body.code }, { status: response.status });
          }
        }
        if (getCryptoAdmissionSnapshot().identity !== identity) {
          await response.body?.cancel();
          throw new Error("Workspace access changed while the request was in flight.");
        }
        return new AdmissionResponse(response, generation);
      }
      const current = getCryptoAdmissionSnapshot();
      if (current.generation === generation && isCryptoAdmissionAllowed()) return new AdmissionResponse(response, generation);
      await response.body?.cancel();
      if (!read || current.identity !== identity || current.status === "blocked") {
        throw new Error("Workspace access changed while the request was in flight.");
      }
      // A discarded read is safely reselected after current admission; never
      // release old confidential bytes across a refresh/security generation.
    }
  };
}

export const workbenchFetch = createAdmissionFetch((input, init) => fetch(input, init));
