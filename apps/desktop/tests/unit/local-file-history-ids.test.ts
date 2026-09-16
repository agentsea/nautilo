import { describe, expect, test } from "bun:test";
import {
  formatRevisionRef,
  newRevisionId,
  parseRevisionRef,
  validateRevisionRefForRelay,
} from "../../electron/local-file-history/ids";

describe("local revision refs", () => {
  test("format and parse round-trip", () => {
    const relayId = "relay-desktop-abc";
    const revisionId = newRevisionId();
    const ref = formatRevisionRef(relayId, revisionId);
    expect(parseRevisionRef(ref)).toEqual({ relayId, revisionId });
  });

  test("rejects non-local prefixes", () => {
    expect(parseRevisionRef("server:relay:uuid")).toBeNull();
    expect(parseRevisionRef("local:")).toBeNull();
  });

  test("rejects malformed uuid segment", () => {
    expect(parseRevisionRef("local:relay:not-a-uuid")).toBeNull();
  });

  test("relay ids may contain colons before the final separator", () => {
    const relayId = "desktop:instance:1";
    const revisionId = newRevisionId();
    const ref = formatRevisionRef(relayId, revisionId);
    expect(parseRevisionRef(ref)).toEqual({ relayId, revisionId });
  });

  test("validateRevisionRefForRelay accepts matching relay", () => {
    const relayId = "relay-a";
    const revisionId = newRevisionId();
    const ref = formatRevisionRef(relayId, revisionId);
    expect(validateRevisionRefForRelay(ref, relayId)).toEqual({
      ok: true,
      revisionId,
    });
  });

  test("validateRevisionRefForRelay rejects foreign relay binding", () => {
    const ref = formatRevisionRef("relay-a", newRevisionId());
    expect(validateRevisionRefForRelay(ref, "relay-b")).toEqual({
      ok: false,
      code: "relay_ownership_mismatch",
    });
  });
});
