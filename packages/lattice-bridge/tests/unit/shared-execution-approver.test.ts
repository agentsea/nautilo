import { describe, expect, test } from "bun:test";
import { sharedExecutionMatchesApprover } from "../../src/server/message/postgres-live-shadow-turn-plan.ts";

describe("shared execution approval identity", () => {
  const input = { authority: { humanActorId: "human-a", userId: "user-a" },
    clientDeviceId: "approving-device", clientActionSessionId: "current-browser" };
  const row = { invoking_human_id: "human-a", invoking_device_id: "original-device",
    authorization_device_id: "approving-device", client_action_session_id: "current-browser" };
  test("approves on a new device without replacing the original source device", () => {
    expect(sharedExecutionMatchesApprover(row, input)).toBe(true);
    expect(row.invoking_device_id).toBe("original-device");
  });
  test.each(["invoking_human_id", "authorization_device_id", "client_action_session_id"])(
    "rejects a mismatched %s", (field) => {
      expect(sharedExecutionMatchesApprover({ ...row, [field]: "foreign" }, input)).toBe(false);
    },
  );
  test("does not accept the original device as the currently authorized approver", () => {
    expect(sharedExecutionMatchesApprover(row, { ...input, clientDeviceId: "original-device" })).toBe(false);
  });
});
