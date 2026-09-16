/* eslint-disable @typescript-eslint/await-thenable -- Bun promise matchers are awaited at runtime. */
import { expect, test } from "bun:test";
import type { SlidesRecoveryDraft } from "./slide-bridge";
import { parseSlidesRecoveryDraft, SlideRecovery } from "./slide-recovery";

const draft = (content: string): SlidesRecoveryDraft => ({ version: 1, content, exact: true, baseSha256: "base", baseRevision: 1 });

test("coalesces pending drafts behind one durable write without letting a queued clear win", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const submitted: Array<SlidesRecoveryDraft | null> = [];
  const expected: Array<string | null> = [];
  const journal = new SlideRecovery({
    async read() { return { revision: null, draft: null }; },
    async write(input) {
      submitted.push(input.draft); expected.push(input.expectedRevision);
      if (submitted.length === 1) await blocked;
      return { revision: String(submitted.length) };
    },
  });
  await journal.read();
  const first = journal.update(draft("first"));
  await Promise.resolve();
  void journal.update(null);
  void journal.update(draft("newer"));
  release();
  await first;
  expect(submitted).toEqual([draft("first"), draft("newer")]);
  expect(expected).toEqual([null, "1"]);
});

test("retrying after a conflict retains the old CAS receipt", async () => {
  const expected: Array<string | null> = [];
  const journal = new SlideRecovery({
    async read() { return { revision: "mine", draft: draft("old") }; },
    async write(input) { expected.push(input.expectedRevision); throw new Error("conflict"); },
  });
  await journal.read();
  await expect(journal.update(null)).rejects.toThrow("conflict");
  await expect(journal.update(draft("newer"))).rejects.toThrow("conflict");
  expect(expected).toEqual(["mine", "mine"]);
});

test("invalid recovery data is rejected rather than normalized into an empty draft", () => {
  for (const bad of [null, {}, { ...draft("x"), version: 2 }, { ...draft("x"), baseRevision: -1 }, { ...draft("x"), exact: "yes" }]) {
    expect(() => parseSlidesRecoveryDraft(bad)).toThrow();
  }
});
