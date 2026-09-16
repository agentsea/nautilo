import { VENICE_CHAT_COMPLETIONS_URL } from "./venice-api";

/** D086 Phase 5.2 — cheap default when caller omits `modelId`. */
export const DEFAULT_VENICE_SMOKE_MODEL_ID = "venice-uncensored-1-2";

const SMOKE_TIMEOUT_MS = 30_000;

export interface SmokeTestVeniceResult {
  ok: boolean;
  latencyMs?: number;
  balanceUsdRemaining?: number;
  error?: string;
}

export type VeniceSmokeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SmokeTestVeniceOptions {
  fetchImpl?: VeniceSmokeFetch;
  signal?: AbortSignal;
}

/** Map `venice:sku` Nautilo ids to Venice API `model` names. */
export function resolveVeniceSmokeModelId(modelId?: string): string {
  const trimmed = modelId?.trim();
  if (!trimmed) return DEFAULT_VENICE_SMOKE_MODEL_ID;
  if (trimmed.toLowerCase().startsWith("venice:")) {
    const rest = trimmed.slice("venice:".length).trim();
    return rest || DEFAULT_VENICE_SMOKE_MODEL_ID;
  }
  return trimmed;
}

function parseBalanceRemaining(headers: Headers): number | undefined {
  const raw =
    headers.get("X-Balance-Remaining") ??
    headers.get("x-balance-remaining") ??
    headers.get("X-Balance-remaining");
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * One-token completion against Venice — for D112 onboarding connectivity checks.
 * Never throws; failures return `{ ok: false, error }`.
 *
 * Security: `error` may include a snippet of Venice’s HTTP body on failure — do not
 * show raw `error` to end users without sanitizing (use `ok` + short status message).
 */
export async function smokeTestVenice(
  apiKey: string,
  modelId?: string,
  options?: SmokeTestVeniceOptions,
): Promise<SmokeTestVeniceResult> {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) {
    return { ok: false, error: "apiKey is empty" };
  }

  const model = resolveVeniceSmokeModelId(modelId);
  const fetchImpl: VeniceSmokeFetch = options?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SMOKE_TIMEOUT_MS);
  const userSignal = options?.signal;
  if (userSignal) {
    if (userSignal.aborted) controller.abort();
    else userSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const started = Date.now();
  try {
    const res = await fetchImpl(VENICE_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - started;
    const balanceUsdRemaining = parseBalanceRemaining(res.headers);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const snippet = body.length > 500 ? `${body.slice(0, 500)}…` : body;
      return {
        ok: false,
        latencyMs,
        ...(balanceUsdRemaining !== undefined ? { balanceUsdRemaining } : {}),
        error: `HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`,
      };
    }

    await res.json().catch(() => undefined);

    return {
      ok: true,
      latencyMs,
      ...(balanceUsdRemaining !== undefined ? { balanceUsdRemaining } : {}),
    };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const msg = e instanceof Error ? e.message : String(e);
    const aborted =
      controller.signal.aborted ||
      msg.toLowerCase().includes("abort") ||
      (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError");
    return {
      ok: false,
      latencyMs,
      error: aborted ? `Venice smoke aborted (${SMOKE_TIMEOUT_MS}ms timeout or caller abort)` : msg,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
