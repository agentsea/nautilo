import { describe, expect, test } from "bun:test";
import type {
  RailwayGraphqlVariables,
  RailwayOperation,
  RailwayOperationData,
  RailwayOperationVariables,
  RailwayReconcileExecutorTransport,
  RailwayTransportResult,
} from "@nautilo/railway-hosting";

import {
  inspectRailwayPersonalProviderCredentialRecords,
  RailwayPersonalProviderCustodyAuthority,
} from "../../src/lib/railway-personal-provider-custody";

const canonical = JSON.stringify({
  formatVersion: 1,
  keyId: "00000000-0000-4000-8000-000000000001",
  keyHex: "ab".repeat(32),
});

class Transport implements RailwayReconcileExecutorTransport {
  readonly calls: unknown[] = [];
  constructor(readonly variables: Readonly<Record<string, string>>, readonly fail = false) {}

  execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    this.calls.push({ operation: operation.name, variables });
    if (this.fail) return Promise.resolve({ outcome: "failure", failure: { kind: "transport", retryable: true } } as never);
    return Promise.resolve({ outcome: "success", data: { variables: this.variables } } as never);
  }
}

function authority(transport: Transport, records?: "records-exist" | "no-records" | "unavailable") {
  return new RailwayPersonalProviderCustodyAuthority({
    transport,
    projectId: "project-1",
    environmentId: "environment-1",
    serviceId: "service-1",
    ...(records === undefined ? {} : { records: { inspect: async () => records } }),
  });
}

describe("Railway personal-provider custody authority", () => {
  test("recovers canonical live custody through the exact rendered service collection", async () => {
    const transport = new Transport({ NAUTILO_PERSONAL_PROVIDER_CUSTODY: canonical });
    expect(await authority(transport).inspect({ launchId: "launch-1", releaseId: "release-1" })).toEqual({
      outcome: "canonical-custody",
      serializedCustody: canonical,
    });
    expect(transport.calls).toEqual([{
      operation: "RailwayVariables",
      variables: { projectId: "project-1", environmentId: "environment-1", serviceId: "service-1", unrendered: false },
    }]);
  });

  test("requires explicit no-record evidence before authorizing initial custody", async () => {
    expect(await authority(new Transport({}), "no-records").inspect({ launchId: "launch-1", releaseId: "release-1" }))
      .toEqual({ outcome: "proven-no-existing-authority" });
    for (const evidence of [undefined, "records-exist", "unavailable"] as const) {
      expect(await authority(new Transport({}), evidence).inspect({ launchId: "launch-1", releaseId: "release-1" }))
        .toEqual({ outcome: "blocked" });
    }
  });

  test("fails closed without reflecting malformed custody or provider failures", async () => {
    expect(await authority(new Transport({ NAUTILO_PERSONAL_PROVIDER_CUSTODY: "malformed" })).inspect({
      launchId: "launch-1", releaseId: "release-1",
    })).toEqual({ outcome: "blocked" });
    expect(await authority(new Transport({}, true)).inspect({ launchId: "launch-1", releaseId: "release-1" }))
      .toEqual({ outcome: "blocked" });
  });
});

describe("Railway personal-provider custody diagnostic", () => {
  test("accepts only an authenticated false record-presence result", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const request: typeof fetch = Object.assign(async (value: string | URL | Request, init?: RequestInit) => {
      const url = typeof value === "string" ? value : value instanceof URL ? value.toString() : value.url;
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ status: "unavailable", recordsExist: false, code: "custody_unavailable" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }, { preconnect: fetch.preconnect });
    expect(await inspectRailwayPersonalProviderCredentialRecords({
      origin: "https://server.example.test",
      bearer: "human-session",
      fetch: request,
    })).toBe("no-records");
    expect(calls).toEqual([{
      url: "https://server.example.test/api/health/personal-provider-custody",
      authorization: "Bearer human-session",
    }]);
  });

  test("distinguishes existing records and fails closed on unknown evidence", async () => {
    const request = (body: unknown, status = 200): typeof fetch => Object.assign(
      async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
      { preconnect: fetch.preconnect },
    );
    expect(await inspectRailwayPersonalProviderCredentialRecords({
      origin: "https://server.example.test", bearer: "human-session",
      fetch: request({ status: "ready", recordsExist: true, keyId: "opaque" }),
    })).toBe("records-exist");
    for (const [body, status] of [
      [{ status: "unavailable", recordsExist: null }, 200],
      [{ status: "unavailable" }, 200],
      [{ status: "unavailable", recordsExist: false }, 403],
    ] as const) {
      expect(await inspectRailwayPersonalProviderCredentialRecords({
        origin: "https://server.example.test", bearer: "human-session", fetch: request(body, status),
      })).toBe("unavailable");
    }
  });

  test("rejects an empty bearer or non-origin target before dispatch", async () => {
    let calls = 0;
    const request: typeof fetch = Object.assign(async () => {
      calls += 1;
      return new Response("{}");
    }, { preconnect: fetch.preconnect });
    expect(await inspectRailwayPersonalProviderCredentialRecords({
      origin: "https://server.example.test", bearer: "", fetch: request,
    })).toBe("unavailable");
    expect(await inspectRailwayPersonalProviderCredentialRecords({
      origin: "https://server.example.test/untrusted", bearer: "human-session", fetch: request,
    })).toBe("unavailable");
    expect(calls).toBe(0);
  });
});
