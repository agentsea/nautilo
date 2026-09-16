import { describe, expect, test } from "bun:test";

import { resumeShareReview } from "./share-review-recovery";

describe("Share review process-death recovery", () => {
  test("checks durable custody when native staging has no new receipt", async () => {
    const calls: string[] = [];

    await resumeShareReview(
      async () => { calls.push("stage:none"); return false; },
      async () => { calls.push("open:durable"); },
    );

    expect(calls).toEqual(["stage:none", "open:durable"]);
  });

  test("commits native staging before opening the review", async () => {
    const calls: string[] = [];

    await resumeShareReview(
      async () => { calls.push("stage:new"); return true; },
      async () => { calls.push("open:durable"); },
    );

    expect(calls).toEqual(["stage:new", "open:durable"]);
  });
});
