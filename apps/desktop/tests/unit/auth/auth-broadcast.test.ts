import { describe, expect, test } from "bun:test";
import { broadcastAuthState } from "../../../electron/auth/broadcast-auth-state";

describe("broadcastAuthState", () => {
  test("posts to every non-destroyed window", () => {
    const payloads: unknown[] = [];
    const w1 = {
      id: 1,
      isDestroyed: () => false,
      webContents: {
        send: (_ch: string, p: unknown) => {
          payloads.push(p);
        },
      },
    };
    const w2 = {
      id: 2,
      isDestroyed: () => true,
      webContents: {
        send: () => {
          throw new Error("should not send to destroyed window");
        },
      },
    };
    const w3 = {
      id: 3,
      isDestroyed: () => false,
      webContents: {
        send: (_ch: string, p: unknown) => {
          payloads.push(p);
        },
      },
    };
    broadcastAuthState({ getAllWindows: () => [w1, w2, w3] }, "signed-out");
    expect(payloads).toEqual([{ state: "signed-out" }, { state: "signed-out" }]);
  });
});
