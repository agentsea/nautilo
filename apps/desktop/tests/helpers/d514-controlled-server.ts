/** Deterministic local HTTP fixture for D514 desktop connection acceptance. */
export type D514Response = {
  delayMs?: number;
  status?: number;
  headers?: HeadersInit;
  /** When present this value is JSON encoded, including malformed shapes. */
  json?: unknown;
  /** Exact non-JSON response content, useful for parse failures. */
  text?: string;
};

export type D514Endpoint = "root" | "ready" | "health" | "setup" | "profile";

const paths: Record<D514Endpoint, string> = {
  root: "/",
  ready: "/health/ready",
  health: "/health",
  setup: "/api/setup/status",
  profile: "/api/profile/status",
};

export class D514ControlledServer {
  readonly marker = `d514-${crypto.randomUUID()}`;
  private readonly plans = new Map<D514Endpoint, D514Response[]>();
  private readonly counts = new Map<D514Endpoint, number>();
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  calls(endpoint: D514Endpoint): number {
    return this.counts.get(endpoint) ?? 0;
  }

  /** Replaces an endpoint's deterministic response sequence. Last response repeats. */
  set(endpoint: D514Endpoint, responses: readonly D514Response[]): void {
    this.plans.set(endpoint, [...responses]);
    this.counts.set(endpoint, 0);
  }

  stop(): void {
    this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    const endpoint = (Object.keys(paths) as D514Endpoint[]).find(
      (candidate) => new URL(request.url).pathname === paths[candidate],
    );
    if (!endpoint) return new Response("not found", { status: 404 });
    const plan = this.plans.get(endpoint) ?? [];
    const count = this.calls(endpoint);
    this.counts.set(endpoint, count + 1);
    const response = plan[Math.min(count, Math.max(0, plan.length - 1))] ??
      this.defaultResponse(endpoint);
    if (response.delayMs) await Bun.sleep(response.delayMs);
    const headers = new Headers(response.headers);
    if (response.text !== undefined) {
      return new Response(response.text, { status: response.status ?? 200, headers });
    }
    headers.set("content-type", headers.get("content-type") ?? "application/json");
    return new Response(JSON.stringify(response.json ?? {}), {
      status: response.status ?? 200,
      headers,
    });
  }

  private defaultResponse(endpoint: D514Endpoint): D514Response {
    if (endpoint === "root") {
      return {
        headers: { "x-d514-marker": this.marker, "content-type": "text/html; charset=utf-8" },
        text: `<!doctype html><title>${this.marker}</title><main data-d514-marker="${this.marker}">${this.marker}</main>`,
      };
    }
    if (endpoint === "ready") return { json: { status: "ready", components: {} } };
    return { status: 404, text: "not configured" };
  }
}
