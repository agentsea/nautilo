import { describe, expect, test } from "bun:test";

import { decideArtifactListFocus, effectiveArtifactRoom, resetArtifactListFocus } from "./artifact-list-focus";

describe("artifact list focus lifecycle", () => {
  test("first focus in a scope blocks, while same-scope return focus refreshes", () => {
    const first = decideArtifactListFocus(resetArtifactListFocus(), "server-a:nautilo:all", true);
    expect(first).toMatchObject({ action: "blocking", scopeChanged: true });
    expect(decideArtifactListFocus(first.next, "server-a:nautilo:all", true)).toMatchObject({ action: "refresh", scopeChanged: false });
  });

  test("server, source, and room changes use a blocking current-scope load", () => {
    const state = { scope: "server-a:nautilo:room-a" };
    for (const scope of ["server-b:nautilo:all", "server-a:computer:all", "server-a:nautilo:room-b"]) {
      expect(decideArtifactListFocus(state, scope, true)).toMatchObject({ action: "blocking", scopeChanged: true, next: { scope } });
    }
  });

  test("a reset while unfocused yields exactly one blocking load at the current Nautilo scope", () => {
    const deferred = decideArtifactListFocus(resetArtifactListFocus(), "server-b:computer:all", false);
    expect(deferred).toMatchObject({ action: "none", next: { scope: "server-b:computer:all" } });
    const focused = decideArtifactListFocus(deferred.next, "server-b:nautilo:all", true);
    expect(focused).toMatchObject({ action: "blocking", scopeChanged: true });
    expect(decideArtifactListFocus(focused.next, "server-b:nautilo:all", true)).toMatchObject({ action: "refresh", scopeChanged: false });
  });

  test("a room selection from server A is immediately excluded from server B before reset commits", () => {
    const selected = { serverId: "server-a", room: { id: "room-a" } };
    expect(effectiveArtifactRoom(selected, "server-a")).toEqual({ id: "room-a" });
    expect(effectiveArtifactRoom(selected, "server-b")).toBeNull();
    expect(decideArtifactListFocus(resetArtifactListFocus(), "server-b:nautilo:all-contexts", true))
      .toMatchObject({ action: "blocking", next: { scope: "server-b:nautilo:all-contexts" } });
  });
});
