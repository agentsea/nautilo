/**
 * D120 A5 follow-up — `/api/setup/reload-env` first-gate contract.
 *
 * History: A5 widened this gate from `isLocalhostIp` to
 * `requestAllowsPrivilegedSetup` to allow remote bootstrap-token callers,
 * but the route ALSO requires `request.sessionUserId` from a session-bearer
 * decode — and a single `Authorization` header cannot carry both the
 * bootstrap token and a Logto session bearer. The remote path was therefore
 * unsatisfiable, so the gate was reverted to `requestAllowsLoopbackTrust`
 * (loopback IP + Unix-socket caller) pending the dual-auth contract design
 * tracked in ISSUE-D131.
 *
 * This test pins the back-out at the helper level: a non-loopback caller —
 * even one presenting a valid bootstrap token — must NOT pass the
 * `requestAllowsLoopbackTrust` first gate. Loopback and Unix-socket callers
 * (zero-length remoteAddress + zero-length ip is the canonical Bun shape
 * for an inbound socket request) must pass.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FastifyRequest } from "fastify";
import { requestAllowsLoopbackTrust } from "../../src/lib/request-trust";

const ORIG_TOKEN = process.env["NAUTILO_BOOTSTRAP_TOKEN"];

function fakeReq(opts: {
  ip?: string;
  remoteAddress?: string;
  auth?: string;
}): FastifyRequest {
  return {
    ip: opts.ip ?? "",
    socket: { remoteAddress: opts.remoteAddress ?? opts.ip ?? "" },
    headers: opts.auth ? { authorization: opts.auth } : {},
  } as unknown as FastifyRequest;
}

describe("POST /api/setup/reload-env first gate (D131 back-out)", () => {
  beforeEach(() => {
    delete process.env["NAUTILO_BOOTSTRAP_TOKEN"];
  });
  afterEach(() => {
    if (ORIG_TOKEN === undefined) delete process.env["NAUTILO_BOOTSTRAP_TOKEN"];
    else process.env["NAUTILO_BOOTSTRAP_TOKEN"] = ORIG_TOKEN;
  });

  test("loopback IPv4 → allowed", () => {
    expect(requestAllowsLoopbackTrust(fakeReq({ ip: "127.0.0.1" }))).toBe(true);
  });

  test("loopback IPv6 → allowed", () => {
    expect(requestAllowsLoopbackTrust(fakeReq({ ip: "::1" }))).toBe(true);
  });

  test("Unix-socket caller (empty ip + empty remoteAddress) → allowed", () => {
    // Bun's HTTP→Unix-socket forwarder presents a request with no IP.
    // requestAllowsLoopbackTrust treats this as the canonical socket caller.
    expect(
      requestAllowsLoopbackTrust(fakeReq({ ip: "", remoteAddress: "" })),
    ).toBe(true);
  });

  test("non-loopback IP, no bootstrap token → 403 (fail-closed)", () => {
    expect(requestAllowsLoopbackTrust(fakeReq({ ip: "10.0.0.5" }))).toBe(false);
  });

  test("non-loopback IP + valid bootstrap token → STILL 403 (back-out contract)", () => {
    // The whole point of the back-out: bootstrap-token does NOT widen the
    // first gate on this route, because the second gate (sessionUserId)
    // cannot be satisfied by the same Authorization header.
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "bootstrap-secret-123";
    expect(
      requestAllowsLoopbackTrust(
        fakeReq({ ip: "10.0.0.5", auth: "Bearer bootstrap-secret-123" }),
      ),
    ).toBe(false);
  });
});
