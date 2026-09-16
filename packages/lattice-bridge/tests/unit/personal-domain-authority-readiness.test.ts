import { describe, expect, test } from "bun:test";

import { ensurePersonalDomainAuthorityV2 } from
  "../../src/client/message/foreground-shadow-client-composition";
import type { DomainKeyAuthorityClientV2 } from
  "../../src/client/message/domain-key-authority-client";

describe("personal Domain authority readiness", () => {
  test("services waiting peers once the current device opens both key classes", async () => {
    const ensured: string[] = [];
    const serviced: string[] = [];
    const authority = {
      ensure: ({ keyClass }) => {
        ensured.push(keyClass);
        return Promise.resolve({ status: "ready" as const });
      },
      servicePending: ({ keyClass }) => {
        serviced.push(keyClass);
        return Promise.resolve({ status: "ready" as const, fulfilled: 1 });
      },
    } as DomainKeyAuthorityClientV2;

    expect(await ensurePersonalDomainAuthorityV2(authority, {
      roomId: "room-personal",
      namespaceId: "namespace-personal",
    })).toEqual({ status: "ready" });
    expect(ensured.sort()).toEqual(["ai", "human"]);
    expect(serviced.sort()).toEqual(["ai", "human"]);
  });

  test("does not service a key class that this device is still requesting", async () => {
    const serviced: string[] = [];
    let backlogCalls = 0;
    const authority = {
      ensure: ({ keyClass }) => Promise.resolve(keyClass === "human"
        ? { status: "ready" as const }
        : { status: "pending" as const, reason: "source_required" as const }),
      servicePending: ({ keyClass }) => {
        serviced.push(keyClass);
        return Promise.resolve({ status: "ready" as const, fulfilled: 0 });
      },
      serviceBacklog: () => {
        backlogCalls++;
        return Promise.resolve({
          status: "ready" as const,
          coordinates: 2,
          fulfilled: 2,
        });
      },
    } as DomainKeyAuthorityClientV2;

    expect(await ensurePersonalDomainAuthorityV2(authority, {
      roomId: "room-personal",
      namespaceId: "namespace-personal",
    })).toEqual({ status: "pending" });
    expect(serviced).toEqual(["human"]);
    // An eligible holder may service both requested classes from another
    // Namespace even while its unrelated personal AI authority is pending.
    expect(backlogCalls).toBe(1);
  });

  test("keeps no-key readiness fail-closed when backlog servicing is unavailable", async () => {
    const authority = {
      ensure: () => Promise.resolve({
        status: "pending" as const,
        reason: "source_required" as const,
      }),
      servicePending: () => Promise.resolve({
        status: "ready" as const,
        fulfilled: 0,
      }),
      serviceBacklog: () => Promise.resolve({
        status: "unavailable" as const,
        reason: "source_key_unavailable",
      }),
    } as unknown as DomainKeyAuthorityClientV2;

    expect(await ensurePersonalDomainAuthorityV2(authority, {
      roomId: "room-personal",
      namespaceId: "namespace-personal",
    })).toEqual({ status: "pending" });
  });
});
