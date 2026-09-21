import { getKeyDefinition } from "./key-registry";

const TIMEOUT_MS = 5000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function checkProviderHealth(
  keyId: string,
  value: string,
): Promise<{ status: "verified" | "invalid_key" | "unreachable"; detail?: string }> {
  try {
    switch (keyId) {
      case "anthropic": {
        // GET /v1/models is the right liveness probe: no token billing, no
        // dependency on a hardcoded model name (Anthropic retired
        // claude-3-haiku-20240307 in Oct 2025; the previous /v1/messages
        // probe started returning 404 across the board for valid keys).
        // Auth failures still return 401 here (verified live).
        const res = await fetchWithTimeout("https://api.anthropic.com/v1/models", {
          method: "GET",
          headers: {
            "x-api-key": value,
            "anthropic-version": "2023-06-01",
          },
        });
        if (res.status === 401 || res.status === 403) {
          // Surface Anthropic's structured error message when present so
          // operators see "invalid x-api-key" / "credit_balance_too_low"
          // instead of just an HTTP code.
          let detail = `${res.status}`;
          try {
            const body = (await res.json()) as { error?: { message?: string } };
            const msg = body.error?.message?.trim();
            if (msg) detail = `${msg}`;
          } catch {
            /* response not JSON; keep numeric detail */
          }
          return { status: "invalid_key", detail };
        }
        if (res.ok) {
          return { status: "verified" };
        }
        return { status: "unreachable", detail: `HTTP ${res.status}` };
      }
      case "openai": {
        const res = await fetchWithTimeout("https://api.openai.com/v1/models", {
          headers: { authorization: `Bearer ${value}` },
        });
        if (res.status === 401 || res.status === 403) {
          return { status: "invalid_key", detail: `${res.status}` };
        }
        if (res.ok) {
          return { status: "verified" };
        }
        return { status: "unreachable", detail: `HTTP ${res.status}` };
      }
      case "google": {
        // List models — no billing, no hardcoded model id. Hardcoding
        // generateContent against gemini-2.5-flash (and earlier 2.0-flash)
        // returns 404 "no longer available to new users" for fresh AI Studio
        // auth keys (AQ.…), which we previously mis-mapped to unreachable.
        // Prefer x-goog-api-key (works for both classic AIzaSy… and AQ.…).
        const res = await fetchWithTimeout(
          "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
          {
            method: "GET",
            headers: { "x-goog-api-key": value },
          },
        );
        // Google returns 400 INVALID_ARGUMENT "API key not valid…" for bad
        // keys (not 401). Treat that as invalid_key, same as 401/403.
        if (res.status === 401 || res.status === 403 || res.status === 400) {
          let detail = `${res.status}`;
          try {
            const body = (await res.json()) as { error?: { message?: string } };
            const msg = body.error?.message?.trim();
            if (msg) detail = msg;
          } catch {
            /* response not JSON; keep numeric detail */
          }
          // A non-auth 400 (e.g. malformed query) would also land here — rare
          // for this fixed URL; still safer than calling a dead key "unreachable".
          return { status: "invalid_key", detail };
        }
        if (res.ok) {
          return { status: "verified" };
        }
        return { status: "unreachable", detail: `HTTP ${res.status}` };
      }
      case "elevenlabs": {
        const res = await fetchWithTimeout("https://api.elevenlabs.io/v1/voices", {
          headers: { "xi-api-key": value },
        });
        if (res.status === 401 || res.status === 403) {
          return { status: "invalid_key", detail: `${res.status}` };
        }
        if (res.ok) {
          return { status: "verified" };
        }
        return { status: "unreachable", detail: `HTTP ${res.status}` };
      }
      case "groq": {
        const res = await fetchWithTimeout("https://api.groq.com/openai/v1/models", {
          headers: { authorization: `Bearer ${value}` },
        });
        if (res.status === 401 || res.status === 403) {
          return { status: "invalid_key", detail: `${res.status}` };
        }
        if (res.ok) {
          return { status: "verified" };
        }
        return { status: "unreachable", detail: `HTTP ${res.status}` };
      }
      case "tavily": {
        const res = await fetchWithTimeout("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: value,
            query: "test",
            max_results: 1,
          }),
        });
        if (res.status === 401 || res.status === 403) {
          return { status: "invalid_key", detail: `${res.status}` };
        }
        if (res.ok) {
          return { status: "verified" };
        }
        return { status: "unreachable", detail: `HTTP ${res.status}` };
      }
      case "fireworks": {
        const res = await fetchWithTimeout("https://api.fireworks.ai/inference/v1/models", {
          headers: { authorization: `Bearer ${value}` },
        });
        if (res.status === 401 || res.status === 403) {
          return { status: "invalid_key", detail: `${res.status}` };
        }
        if (res.ok) {
          return { status: "verified" };
        }
        return { status: "unreachable", detail: `HTTP ${res.status}` };
      }
      case "openrouter": {
        const res = await fetchWithTimeout("https://openrouter.ai/api/v1/models", {
          headers: { authorization: `Bearer ${value}` },
        });
        if (res.status === 401 || res.status === 403) {
          return { status: "invalid_key", detail: `${res.status}` };
        }
        if (res.ok) {
          return { status: "verified" };
        }
        return { status: "unreachable", detail: `HTTP ${res.status}` };
      }
      case "typesafe": {
        const res = await fetchWithTimeout("https://api.typesafe.ai/v1/models", {
          method: "GET", redirect: "error",
          headers: { authorization: `Bearer ${value}` },
        });
        if (res.status === 401 || res.status === 403) return { status: "invalid_key", detail: `${res.status}` };
        return res.ok ? { status: "verified" } : { status: "unreachable", detail: `HTTP ${res.status}` };
      }
      case "venice": {
        // Venice's models endpoint is a non-billing authentication probe and
        // does not couple key health to any particular model identifier.
        const res = await fetchWithTimeout("https://api.venice.ai/api/v1/models", {
          method: "GET",
          headers: { authorization: `Bearer ${value}` },
        });
        if (res.status === 401 || res.status === 403) {
          return { status: "invalid_key", detail: `${res.status}` };
        }
        if (res.ok) {
          return { status: "verified" };
        }
        return { status: "unreachable", detail: `HTTP ${res.status}` };
      }
      case "cloudconvert": {
        // List jobs needs task.read — the same scope Nautilo's convert
        // adapter requires. Prefer this over /v2/users/me (user.read), which
        // rejects least-privilege task-only keys as 403.
        const res = await fetchWithTimeout(
          "https://api.cloudconvert.com/v2/jobs?per_page=1",
          {
            method: "GET",
            headers: {
              authorization: `Bearer ${value}`,
              accept: "application/json",
            },
          },
        );
        if (res.status === 401 || res.status === 403) {
          let detail = `${res.status}`;
          try {
            const body = (await res.json()) as { message?: string };
            const msg = body.message?.trim();
            if (msg) detail = msg;
          } catch {
            /* response not JSON; keep numeric detail */
          }
          // Common paste mistakes that produce Unauthenticated from a
          // otherwise-valid dashboard key.
          if (value.trimStart().startsWith("Bearer ")) {
            detail = `${detail} — paste the raw JWT without a 'Bearer ' prefix`;
          } else {
            const parts = value.trim().split(".");
            if (parts.length !== 3 || value.trim().length < 200) {
              detail =
                `${detail} — CloudConvert keys are long JWTs (three segments, ` +
                `often ~1000 chars); this value looks truncated`;
            }
          }
          return { status: "invalid_key", detail };
        }
        if (res.ok) {
          return { status: "verified" };
        }
        return { status: "unreachable", detail: `HTTP ${res.status}` };
      }
      default:
        return { status: "unreachable", detail: "unknown provider" };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "unreachable", detail: msg };
  }
}

export async function checkServerHealth(healthUrl: string): Promise<{
  ok: boolean;
  detail?: string;
}> {
  try {
    const res = await fetchWithTimeout(healthUrl, { method: "GET" });
    if (res.ok) {
      return { ok: true };
    }
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: msg };
  }
}

/** Run health checks for registry key ids that have a non-empty value. */
export async function checkKeysHealth(
  env: NodeJS.ProcessEnv,
  keyIds: string[],
): Promise<Record<string, { status: "verified" | "invalid_key" | "unreachable"; detail?: string }>> {
  const out: Record<string, { status: "verified" | "invalid_key" | "unreachable"; detail?: string }> =
    {};
  const tasks = keyIds.map(async (id) => {
    const def = getKeyDefinition(id);
    if (!def) {
      return;
    }
    if (def.healthCheck === "format_only") {
      return;
    }
    const v = env[def.envVar]?.trim();
    if (!v) {
      return;
    }
    out[id] = await checkProviderHealth(id, v);
  });
  await Promise.all(tasks);
  return out;
}
