import { isServerFingerprint } from "./config-schema";
import type { ActiveAuthority } from "./pending-connection";

export type LogtoAuthDiagnosticSnapshot<Session> = Readonly<{
  session: Session;
  routingServerUrl: string;
  authority: ActiveAuthority;
}>;

export interface LogtoAuthDiagnosticPorts<Session> {
  timeoutMs: number;
  fetch: typeof globalThis.fetch;
  current(): LogtoAuthDiagnosticSnapshot<Session> | null;
  apply(session: Session, body: Record<string, unknown>): boolean;
}

function fingerprintFromBody(body: Record<string, unknown>): string | null {
  const explicit = body["serverIdentity"];
  const appId = body["logtoDesktopAppId"];
  const resource = body["logtoResource"];
  const candidate = typeof explicit === "string" && explicit
    ? explicit
    : typeof appId === "string" && appId && typeof resource === "string" && resource
      ? `${appId}|${resource}`
      : null;
  return isServerFingerprint(candidate) ? candidate : null;
}

function sameAuthority(left: ActiveAuthority, right: ActiveAuthority): boolean {
  return left.scope === right.scope && left.revision === right.revision &&
    left.connectionAttemptId === right.connectionAttemptId &&
    left.serverFingerprint === right.serverFingerprint;
}

/** Bounded, explicit diagnostic only. It never selects or mutates authority. */
export async function reprobeLogtoAuthDiagnostic<Session>(
  ports: LogtoAuthDiagnosticPorts<Session>,
): Promise<boolean> {
  try {
    const captured = ports.current();
    if (!captured || !captured.authority.scope || !captured.authority.serverFingerprint) return false;
    const expectedOrigin = new URL(captured.routingServerUrl).origin;
    if (expectedOrigin !== captured.authority.scope) return false;
    const healthUrl = `${captured.routingServerUrl.replace(/\/+$/, "")}/health`;
    const response = await ports.fetch(healthUrl, {
      signal: AbortSignal.timeout(ports.timeoutMs),
    });
    if (!response.ok || !response.url || new URL(response.url).origin !== expectedOrigin) return false;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const record = body as Record<string, unknown>;
    if (fingerprintFromBody(record) !== captured.authority.serverFingerprint) return false;
    const current = ports.current();
    if (!current || current.session !== captured.session ||
      current.routingServerUrl !== captured.routingServerUrl ||
      !sameAuthority(current.authority, captured.authority)) return false;
    return ports.apply(captured.session, record);
  } catch {
    return false;
  }
}
