/**
 * M128 TP2 — profile route two-gate (self vs cross-edit).
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test } from "bun:test";

describe("GET/PATCH /api/profile/:userId two-gate (TP2)", () => {
  // TODO(M128 follow-up): wire ?userId= / :userId cross-edit on profile routes
  // before enabling these assertions (Phase 5 partial per audit).
  test.todo("self-edit (caller == userId) allowed without manage_agents", () => {});
  test.todo("cross-edit requires manage_agents; member caller gets 403", () => {});
  test.todo("cross-edit succeeds for admin-rung caller with manage_agents", () => {});
});
