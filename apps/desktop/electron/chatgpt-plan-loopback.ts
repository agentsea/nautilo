import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

// Same user-consent lifetime as the server ceremony. This bounds an abandoned
// listener; expiry never modifies a saved account or selects another payer.
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const failed = () => new Error("ChatGPT sign-in ended. Start again from Nautilo settings.");
function equal(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Captures only the loopback code. PKCE, exchange, custody and refresh belong
 * to the intended Server. The binding is supplied by Electron, never the UI. */
export async function createChatGPTDesktopListener(binding: { current: () => boolean; signal: AbortSignal }) {
  if (!binding.current() || binding.signal.aborted) throw failed();
  const id = randomUUID();
  const server = createServer();
  let authorization: URL | null = null;
  let consumed = false; let closed = false;
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const callback = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  // A listener can be cancelled before the renderer calls receive().
  void callback.catch(() => {});
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(timer);
    binding.signal.removeEventListener("abort", close);
    server.close(); server.closeAllConnections(); reject(failed());
  };
  const timer = setTimeout(close, SIGN_IN_TIMEOUT_MS); timer.unref();
  binding.signal.addEventListener("abort", close, { once: true });
  try {
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(0, "127.0.0.1", () => { server.off("error", no); yes(); });
    });
  } catch { close(); throw failed(); }
  const address = server.address();
  if (!address || typeof address === "string" || closed || !binding.current()) { close(); server.close(); throw failed(); }
  const port = address.port;
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  server.on("error", close);
  server.on("request", (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    response.setHeader("content-type", "text/plain; charset=utf-8");
    const denied = () => { response.statusCode = 400; response.end("This sign-in callback was not accepted. Return to Nautilo."); };
    if (closed || !binding.current() || !authorization || request.method !== "GET" || request.headers.host !== `127.0.0.1:${port}`) {
      denied(); return;
    }
    let url: URL;
    try { url = new URL(request.url ?? "", redirectUri); } catch { denied(); return; }
    if (url.origin !== new URL(redirectUri).origin || url.pathname !== "/auth/callback" || url.hash || url.username || url.password
      || url.searchParams.getAll("state").length !== 1 || !equal(url.searchParams.get("state") ?? "", authorization.searchParams.get("state")!)) {
      denied(); return;
    }
    resolve(url.toString());
    // Callback delivery is not token exchange success. Settings reports that
    // only after the Server verifies and stores the selected registration.
    response.end("Sign-in received. Return to Nautilo to finish connecting.");
    closed = true; clearTimeout(timer); binding.signal.removeEventListener("abort", close);
    server.close(); server.closeIdleConnections();
  });
  return {
    id, port, close,
    receive: (url: string): Promise<string> => {
      if (closed || consumed || !binding.current()) { close(); throw failed(); }
      let parsed: URL;
      try { parsed = new URL(url); } catch { close(); throw failed(); }
      if (parsed.origin !== "https://auth.openai.com" || parsed.pathname !== "/api/accounts/authorize" || parsed.username || parsed.password || parsed.hash
        || parsed.searchParams.getAll("redirect_uri").length !== 1 || parsed.searchParams.get("redirect_uri") !== redirectUri
        || parsed.searchParams.getAll("state").length !== 1 || !parsed.searchParams.get("state")
        || parsed.searchParams.get("code_challenge_method") !== "S256" || !parsed.searchParams.get("code_challenge")) {
        close(); throw failed();
      }
      authorization = parsed; consumed = true;
      return callback;
    },
  };
}
