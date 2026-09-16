/**
 * M128 TP3 — profile avatar route two-gate (self vs cross-edit).
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test } from "bun:test";

describe("POST /api/profile/avatar two-gate (TP3)", () => {
  // TODO(M128 follow-up): wire cross-user avatar upload target before enabling.
  test.todo("self-upload allowed without manage_agents", () => {});
  test.todo("cross-upload requires manage_agents; member caller gets 403", () => {});
  test.todo("cross-upload succeeds for admin-rung caller with manage_agents", () => {});
});
