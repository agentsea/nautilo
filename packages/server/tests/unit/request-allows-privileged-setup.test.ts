import { expect, test, afterEach, beforeEach, spyOn } from "bun:test";
import type { FastifyRequest } from "fastify";
import * as operatorSecrets from "@nautilo/operator-secrets";
import { requestAllowsPrivilegedSetup } from "../../src/lib/request-trust";
import {
  setBootstrapOwnerId,
  setBootstrapOwnerBound,
  _resetBootstrapStateCacheForTests,
  isBootstrapOwnerBound,
} from "@nautilo/trust";

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

// Save the operator's real token (if set) so the cleanup restores instead
// of deleting it -- otherwise running this suite in a shell with a real
// NAUTILO_BOOTSTRAP_TOKEN set would wipe it for the rest of the bun process.
const ORIG_TOKEN = process.env["NAUTILO_BOOTSTRAP_TOKEN"];
let bootstrapUsed = false;
let restoreBootstrapUsedSpy: () => void = () => {};

beforeEach(() => {
  // The test runner's retained test-cruft instance may legitimately have a
  // `.bootstrap/.used` marker. Keep the bearer protocol assertions hermetic;
  // the marker itself has a dedicated fail-closed case below.
  bootstrapUsed = false;
  const spy = spyOn(operatorSecrets, "isBootstrapUsed").mockImplementation(() => bootstrapUsed);
  restoreBootstrapUsedSpy = () => spy.mockRestore();
});

afterEach(() => {
  restoreBootstrapUsedSpy();
  if (ORIG_TOKEN === undefined) delete process.env["NAUTILO_BOOTSTRAP_TOKEN"];
  else process.env["NAUTILO_BOOTSTRAP_TOKEN"] = ORIG_TOKEN;
  _resetBootstrapStateCacheForTests();
});

test("loopback ip passes regardless of token state", () => {
  expect(requestAllowsPrivilegedSetup(fakeReq({ ip: "127.0.0.1" }))).toBe(true);
});

test("remote IP + valid bearer + token configured: passes", () => {
  process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "secret-abc";
  expect(
    requestAllowsPrivilegedSetup(
      fakeReq({ ip: "10.0.0.5", auth: "Bearer secret-abc" }),
    ),
  ).toBe(true);
});

test("fresh seed owner identity does not retire remote bearer before canonical claim", () => {
  process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "secret-abc";
  expect(isBootstrapOwnerBound()).toBe(false);
  setBootstrapOwnerId("00000000-0000-4000-8000-000000000001");
  expect(isBootstrapOwnerBound()).toBe(false);
  expect(
    requestAllowsPrivilegedSetup(
      fakeReq({ ip: "10.0.0.5", auth: "Bearer secret-abc" }),
    ),
  ).toBe(true);
});

test("remote bearer is retired as soon as canonical owner claim is bound", () => {
  process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "secret-abc";
  setBootstrapOwnerId("00000000-0000-4000-8000-000000000001");
  setBootstrapOwnerBound(true);
  expect(isBootstrapOwnerBound()).toBe(true);
  expect(
    requestAllowsPrivilegedSetup(
      fakeReq({ ip: "10.0.0.5", auth: "Bearer secret-abc" }),
    ),
  ).toBe(false);
  // Local Compose recovery retains its historical loopback authority.
  expect(requestAllowsPrivilegedSetup(fakeReq({ ip: "127.0.0.1" }))).toBe(true);
});

test("durable bootstrap marker retires remote bearer even without a cache refresh", () => {
  process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "secret-abc";
  bootstrapUsed = true;
  expect(
    requestAllowsPrivilegedSetup(
      fakeReq({ ip: "10.0.0.5", auth: "Bearer secret-abc" }),
    ),
  ).toBe(false);
  expect(requestAllowsPrivilegedSetup(fakeReq({ ip: "127.0.0.1" }))).toBe(true);
});

test("remote IP + invalid bearer: rejects", () => {
  process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "secret-abc";
  expect(
    requestAllowsPrivilegedSetup(fakeReq({ ip: "10.0.0.5", auth: "Bearer wrong" })),
  ).toBe(false);
});

test("remote IP + no bearer: rejects", () => {
  process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "secret-abc";
  expect(requestAllowsPrivilegedSetup(fakeReq({ ip: "10.0.0.5" }))).toBe(false);
});

test("remote IP + no token configured: rejects (fail-closed)", () => {
  delete process.env["NAUTILO_BOOTSTRAP_TOKEN"];
  expect(
    requestAllowsPrivilegedSetup(
      fakeReq({ ip: "10.0.0.5", auth: "Bearer anything" }),
    ),
  ).toBe(false);
});

test("constant-time guard: equal-length wrong token rejects", () => {
  process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "abcdefgh";
  expect(
    requestAllowsPrivilegedSetup(fakeReq({ ip: "10.0.0.5", auth: "Bearer 12345678" })),
  ).toBe(false);
});
