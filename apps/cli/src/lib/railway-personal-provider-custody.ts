import {
  PERSONAL_PROVIDER_CUSTODY_ENV,
  parsePersonalProviderCustody,
  serializePersonalProviderCustody,
} from "@nautilo/operator-secrets";
import {
  railwayVariables,
  type RailwayReconcileExecutorTransport,
} from "@nautilo/railway-hosting";

import type {
  RailwayLegacyPersonalProviderCustodyAuthority,
  RailwayLegacyPersonalProviderCustodyInspection,
} from "./railway-launch-secret-store";

export type RailwayPersonalProviderCredentialRecordEvidence =
  | "records-exist"
  | "no-records"
  | "unavailable";

export interface RailwayPersonalProviderCredentialRecordInspector {
  inspect(): Promise<RailwayPersonalProviderCredentialRecordEvidence>;
}

export async function inspectRailwayPersonalProviderCredentialRecords(input: {
  readonly origin: string;
  readonly bearer: string;
  readonly fetch: typeof fetch;
}): Promise<RailwayPersonalProviderCredentialRecordEvidence> {
  if (input.bearer.length === 0) return "unavailable";
  let url: URL;
  try {
    url = new URL("/api/health/personal-provider-custody", input.origin);
    const origin = new URL(input.origin);
    if (url.origin !== origin.origin || origin.pathname !== "/" || origin.search || origin.hash) return "unavailable";
  } catch {
    return "unavailable";
  }
  try {
    const response = await input.fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.bearer}` },
    });
    if (!response.ok) return "unavailable";
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return "unavailable";
    const record = body as Record<string, unknown>;
    if ((record["status"] !== "ready" && record["status"] !== "unavailable")
      || (record["recordsExist"] !== true && record["recordsExist"] !== false && record["recordsExist"] !== null)) {
      return "unavailable";
    }
    return record["recordsExist"] === false
      ? "no-records"
      : record["recordsExist"] === true ? "records-exist" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * Reads only the exact active Nautilo service collection. The optional record
 * inspector is an authenticated operator/maintenance probe; without it,
 * absence of the environment variable remains inconclusive and cannot mint a
 * replacement key.
 */
export class RailwayPersonalProviderCustodyAuthority
implements RailwayLegacyPersonalProviderCustodyAuthority {
  readonly #transport: RailwayReconcileExecutorTransport;
  readonly #projectId: string;
  readonly #environmentId: string;
  readonly #serviceId: string;
  readonly #records: RailwayPersonalProviderCredentialRecordInspector | undefined;

  constructor(input: {
    readonly transport: RailwayReconcileExecutorTransport;
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly records?: RailwayPersonalProviderCredentialRecordInspector | undefined;
  }) {
    this.#transport = input.transport;
    this.#projectId = `${input.projectId}`;
    this.#environmentId = `${input.environmentId}`;
    this.#serviceId = `${input.serviceId}`;
    this.#records = input.records;
  }

  async inspect(_input: {
    readonly launchId: string;
    readonly releaseId: string;
  }): Promise<RailwayLegacyPersonalProviderCustodyInspection> {
    try {
      const result = await this.#transport.execute(railwayVariables, {
        projectId: this.#projectId,
        environmentId: this.#environmentId,
        serviceId: this.#serviceId,
        unrendered: false,
      });
      if (result.outcome !== "success") return { outcome: "blocked" };
      const raw = result.data.variables[PERSONAL_PROVIDER_CUSTODY_ENV];
      if (raw !== undefined) {
        return {
          outcome: "canonical-custody",
          serializedCustody: serializePersonalProviderCustody(parsePersonalProviderCustody(raw)),
        };
      }
      if (this.#records === undefined || await this.#records.inspect() !== "no-records") {
        return { outcome: "blocked" };
      }
      return { outcome: "proven-no-existing-authority" };
    } catch {
      return { outcome: "blocked" };
    }
  }
}
