import { describe, expect, test } from "bun:test";
import { formatCommittedContentMutation } from "../../electron/local-file-dispatch/commands";

const bytes = (value: string): Uint8Array => Buffer.from(value, "utf8");

describe("local file mutation diff statistics", () => {
  test("counts an inserted line without treating every shifted line as replaced", () => {
    const result = JSON.parse(formatCommittedContentMutation({
      revisionId: "revision-1",
      sha256: "sha",
      before: bytes("alpha\nbravo\ncharlie\ndelta\n"),
      after: bytes("alpha\ninserted\nbravo\ncharlie\ndelta\n"),
    }, {
      relayId: "relay-1",
      displayPath: "notes.md",
      zone: "current",
      command: "insert",
    })) as { stats: { additions: number; deletions: number } };

    expect(result.stats).toEqual({ additions: 1, deletions: 0 });
  });
});
