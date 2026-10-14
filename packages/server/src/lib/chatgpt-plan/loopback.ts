import { createServer } from "node:http";
import {
  ChatGPTOAuth, ChatGPTPlanError, createChatGPTAuthorization, parseChatGPTCallback,
  type ChatGPTPlanErrorCode, type ChatGPTRegistrationIdentity, type ChatGPTSession,
} from "./oauth";

export type ChatGPTAuthorizationResult =
  | { status: "connected" }
  | { status: "failed"; code: ChatGPTPlanErrorCode }
  | { status: "cancelled" };

/**
 * Runs only on the machine opening the browser. The caller binds the attempt
 * to its authenticated Human/instance and supplies its lifecycle signal.
 * The completion handler persists validated credentials before reporting success.
 */
export async function startChatGPTLoopback(input: {
  hostId: string;
  registration?: ChatGPTRegistrationIdentity;
  signal: AbortSignal;
  complete: (session: ChatGPTSession, signal: AbortSignal) => Promise<void>;
  oauth?: Pick<ChatGPTOAuth, "exchange">;
}): Promise<{ url: string; result: Promise<ChatGPTAuthorizationResult>; cancel: () => void }> {
  if (input.signal.aborted) throw new ChatGPTPlanError("authorization_expired");
  const oauth = input.oauth ?? new ChatGPTOAuth();
  const controller = new AbortController();
  let finish!: (result: ChatGPTAuthorizationResult) => void;
  const result = new Promise<ChatGPTAuthorizationResult>(resolve => { finish = resolve; });
  let settled = false;
  let claimed = false;
  const server = createServer();
  const settle = (value: ChatGPTAuthorizationResult) => {
    if (settled) return;
    settled = true;
    input.signal.removeEventListener("abort", expired);
    controller.abort();
    server.close();
    server.closeIdleConnections();
    if (value.status === "cancelled" || value.status === "failed" && value.code === "authorization_expired") server.closeAllConnections();
    finish(value);
  };
  const expired = () => settle({ status: "failed", code: "authorization_expired" });
  input.signal.addEventListener("abort", expired, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch {
    settle({ status: "failed", code: "provider_unavailable" });
    throw new ChatGPTPlanError("provider_unavailable");
  }
  if (settled || input.signal.aborted) {
    server.close();
    throw new ChatGPTPlanError("authorization_expired");
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    settle({ status: "failed", code: "authorization_invalid" });
    throw new ChatGPTPlanError("authorization_invalid");
  }
  let authorization: ReturnType<typeof createChatGPTAuthorization>;
  try {
    authorization = createChatGPTAuthorization({ hostId: input.hostId, port: address.port,
      ...(input.registration ? { registration: input.registration } : {}) });
  } catch (error) {
    settle({ status: "failed", code: "authorization_invalid" });
    throw error;
  }
  const { attempt, url } = authorization;
  server.on("error", () => settle({ status: "failed", code: "provider_unavailable" }));
  server.on("request", (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    response.setHeader("content-type", "text/plain; charset=utf-8");
    const reject = () => { response.statusCode = 400; response.end("This sign-in callback was not accepted. Return to Nautilo."); };
    if (claimed || settled || request.method !== "GET" || request.headers.host !== new URL(attempt.redirectUri).host) {
      reject(); return;
    }
    let callback: URL;
    try {
      callback = new URL(request.url ?? "", attempt.redirectUri);
      parseChatGPTCallback(attempt, callback);
    } catch (error) {
      reject();
      // Unrelated loopback traffic must not cancel a legitimate pending login.
      if (error instanceof ChatGPTPlanError && error.code !== "authorization_invalid") {
        settle({ status: "failed", code: error.code });
      }
      return;
    }
    claimed = true;
    void (async () => {
      try {
        const session = await oauth.exchange(attempt, callback, controller.signal);
        if (settled || controller.signal.aborted) return;
        await input.complete(session, controller.signal);
        if (settled || controller.signal.aborted) return;
        response.end("ChatGPT is connected. Return to Nautilo. You can close this tab.");
        settle({ status: "connected" });
      } catch (error) {
        reject();
        settle({ status: "failed", code: error instanceof ChatGPTPlanError ? error.code : "provider_unavailable" });
      } finally {
        if (!response.writableEnded) response.end("Sign-in ended. Return to Nautilo.");
      }
    })();
  });
  return { url, result, cancel: () => settle({ status: "cancelled" }) };
}
