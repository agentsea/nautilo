import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import type { ServerFinishMode } from "./server-completion.ts";
import type { OwnerClaimTargetTransportPolicy } from "./owner-claim-target.ts";

const HANDOFF_TIMEOUT_MS = 2 * 60_000;
export type OwnerClaimHandoffFailure = "listener-unavailable";
export class OwnerClaimHandoffError extends Error {
  constructor(readonly failure: OwnerClaimHandoffFailure) {
    super(failure);
    this.name = "OwnerClaimHandoffError";
  }
}
export interface OwnerClaimBrowserHandoff { readonly localUrl: string; close(): Promise<void>; }
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Shared safe local redirect; the provider supplies only target-origin admission. */
export async function createOwnerClaimBrowserHandoff(input: {
  readonly targetUrl: string; readonly claim: string; readonly finish: ServerFinishMode; readonly nonce?: string;
  readonly transport: OwnerClaimTargetTransportPolicy;
}): Promise<OwnerClaimBrowserHandoff> {
  const target = input.transport.validateTargetUrl(input.targetUrl);
  if (!/^inv_[A-Za-z0-9_-]{32}$/.test(input.claim)) throw new Error("Owner claim handoff claim is invalid");
  const nonce = input.nonce ?? randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error("Owner claim handoff nonce is invalid");
  const destination = new URL("/claim", target);
  destination.hash = new URLSearchParams({ claim: input.claim, finish: input.finish }).toString();
  const path = `/handoff/${nonce}`;
  let consumed = false;
  const server = createServer((request, response) => {
    if (consumed || request.method !== "GET" || request.url !== path) {
      response.writeHead(404, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); response.end(); return;
    }
    consumed = true;
    response.writeHead(302, { Location: destination.toString(), "Cache-Control": "no-store, max-age=0",
      "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    response.end(); clearTimeout(timer); void closeServer(server);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server); throw new OwnerClaimHandoffError("listener-unavailable");
  }
  const timer = setTimeout(() => { void closeServer(server); }, HANDOFF_TIMEOUT_MS);
  timer.unref();
  return { localUrl: `http://127.0.0.1:${String(address.port)}${path}`, async close() {
    clearTimeout(timer); if (server.listening) await closeServer(server);
  } };
}
