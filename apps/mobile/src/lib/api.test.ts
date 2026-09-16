/// <reference types="bun-types" />

import { expect, test } from "bun:test";

const source = await Bun.file(new URL("./api.ts", import.meta.url)).text();

test("mobile API client keeps the canonical fresh-token binding", () => {
  // This deliberately tests the binding seam without replacing server-store
  // at process scope. Other mobile suites import the real store and Bun's
  // module mocks are global, so a partial server-store mock makes a combined
  // authentication/push run order-dependent.
  expect(source).toContain('import { ensureValidToken } from "@/lib/auth"');
  expect(source).toContain('import { serverIdFromUrl } from "@/lib/server-store"');
  expect(source).toContain("client.setTokenProvider(async () => {");
  expect(source).toContain("const token = await ensureValidToken(id, normalized);");
  expect(source).toContain("if (!token) emitAuthDead(id);");
  expect(source).toContain("client.setUnauthorizedResponseHandler(async (response) => {");
  expect(source).toContain("const token = await ensureValidToken(id, normalized, { forceRefresh: true });");
});
