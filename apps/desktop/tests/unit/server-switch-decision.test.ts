import { describe, expect, test } from "bun:test";
import { decideSwitchServerCommit } from "../../electron/server-switch-decision";

describe("decideSwitchServerCommit", () => {
  test("cancelled picker result does not relaunch", () => {
    expect(decideSwitchServerCommit(null)).toEqual({ relaunch: false });
  });

  test("invalid connect config without server URL does not relaunch", () => {
    expect(
      decideSwitchServerCommit({
        version: 1,
        mode: "connect",
      }),
    ).toEqual({ relaunch: false });
  });

  test("picked URL saves config and carries connect URL into relaunch env", () => {
    expect(
      decideSwitchServerCommit({
        version: 1,
        mode: "connect",
        serverUrl: "  http://localhost:3601/  ",
      }),
    ).toEqual({
      relaunch: true,
      config: {
        version: 1,
        mode: "connect",
        serverUrl: "http://localhost:3601/",
      },
      nextEnv: {
        NAUTILO_CONNECT_SERVER_URL: "http://localhost:3601/",
      },
    });
  });
});
