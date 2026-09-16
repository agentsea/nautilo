import { expect, test } from "bun:test";
import {
  clearClientActionSession,
  installClientActionSession,
  withCurrentClientActionSession,
} from "./client-action-session";

test("mobile stamps only the current socket session and clears it before reuse", () => {
  clearClientActionSession();
  expect(withCurrentClientActionSession({ content: "first", clientActionSessionId: "forged" }))
    .toEqual({ content: "first" });

  installClientActionSession({
    type: "client.session.v1",
    clientActionSessionId: "A1b2C3d4E5f6G7h8I9j0K_",
  });
  expect(withCurrentClientActionSession({ content: "bound", clientActionSessionId: "forged" }))
    .toEqual({ content: "bound", clientActionSessionId: "A1b2C3d4E5f6G7h8I9j0K_" });

  clearClientActionSession();
  expect(withCurrentClientActionSession({ content: "after-close" }))
    .toEqual({ content: "after-close" });
});
