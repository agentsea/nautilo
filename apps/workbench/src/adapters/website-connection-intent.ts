/**
 * A deliberately transient seam between catalogue launchers and the protected
 * connection journey. It has no storage, fetch, or success state; the later
 * owner-scoped login flow can install the dispatcher without changing either
 * catalogue projection.
 */
export type WebsiteConnectionOutcome = "done" | "cancelled";
export type WebsiteConnectionCompletion = (outcome: WebsiteConnectionOutcome) => void;

export type WebsiteConnectionIntent =
  | Readonly<{ kind: "catalogue"; websiteId: string; createAnother?: boolean; onFinished?: WebsiteConnectionCompletion }>
  | Readonly<{ kind: "custom"; url: string; createAnother?: boolean; onFinished?: WebsiteConnectionCompletion }>
  | Readonly<{ kind: "reconnect"; accountId: string; onFinished?: WebsiteConnectionCompletion }>
  /** A transcript's opaque account reference; the server re-authorizes it. */
  | Readonly<{ kind: "view"; accountId: string; title: string }>;

type WebsiteConnectionIntentDispatcher = (intent: WebsiteConnectionIntent) => void;

let dispatcher: WebsiteConnectionIntentDispatcher | null = null;

export function setWebsiteConnectionIntentDispatcher(
  nextDispatcher: WebsiteConnectionIntentDispatcher | null,
): void {
  dispatcher = nextDispatcher;
}

export function requestWebsiteConnection(intent: WebsiteConnectionIntent): boolean {
  if (!dispatcher
    || (intent.kind === "catalogue" && intent.websiteId.length === 0)
    || ((intent.kind === "reconnect" || intent.kind === "view") && intent.accountId.length === 0)
    || (intent.kind === "view" && intent.title.trim().length === 0)) {
    return false;
  }
  dispatcher(intent);
  return true;
}
