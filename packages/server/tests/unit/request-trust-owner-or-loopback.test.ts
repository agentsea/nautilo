import { describe, expect, test } from "bun:test";
import type { FastifyRequest } from "fastify";
import { requestAllowsOwnerOrLoopback } from "../../src/lib/request-trust";

function fakeReq(opts: {
  ip?: string;
  remoteAddress?: string;
  policyContext?: { actorRole: string } | null;
}): FastifyRequest {
  return {
    ip: opts.ip ?? "",
    socket: { remoteAddress: opts.remoteAddress ?? opts.ip ?? "" },
    headers: {},
    policyContext: opts.policyContext ?? null,
  } as unknown as FastifyRequest;
}

describe("requestAllowsOwnerOrLoopback (M115)", () => {
  test("loopback IPv4 → allowed", () => {
    expect(requestAllowsOwnerOrLoopback(fakeReq({ ip: "127.0.0.1" }))).toBe(true);
  });

  test("non-loopback with owner policyContext → allowed", () => {
    expect(
      requestAllowsOwnerOrLoopback(
        fakeReq({ ip: "10.0.0.5", policyContext: { actorRole: "owner" } }),
      ),
    ).toBe(true);
  });

  test("non-loopback with guest policyContext → denied", () => {
    expect(
      requestAllowsOwnerOrLoopback(
        fakeReq({ ip: "10.0.0.5", policyContext: { actorRole: "guest" } }),
      ),
    ).toBe(false);
  });

  test("non-loopback with no policyContext → denied", () => {
    expect(requestAllowsOwnerOrLoopback(fakeReq({ ip: "10.0.0.5" }))).toBe(false);
  });
});
