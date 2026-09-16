import "../../../../tests/bun-dom-preload";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { MessageBackfillProgress } from "@nautilo/api-client/browser";

import { MessageHistoryBackfillProgress } from "./message-history-backfill-progress";

afterEach(cleanup);

function progress(
  status: MessageBackfillProgress["status"],
  overrides: Partial<MessageBackfillProgress> = {},
): MessageBackfillProgress {
  return {
    status,
    snapshotAt: Date.UTC(2026, 8, 8, 12, 30),
    snapshotComplete: true,
    caughtUp: false,
    lastSweepAt: null,
    activeLease: status === "active",
    counts: {
      eligible: 12,
      alreadyAuthenticated: 4,
      independentlyParityVerified: 3,
      claimedRepairing: status === "active" ? 1 : 0,
      repairedAndVerified: 2,
      unsupported: 1,
      failed: 0,
    },
    waiting: {authorizedDevice: null, authority: null},
    ...overrides,
  };
}

describe("MessageHistoryBackfillProgress", () => {
  test("renders every canonical status without deriving a percentage", () => {
    const view = render(
      <MessageHistoryBackfillProgress progress={progress("active")} />,
    );

    for (const [status, label] of [
      ["active", "Active"],
      ["waiting", "Waiting"],
      ["failed", "Failed"],
      ["caught_up", "Caught up"],
      ["disabled", "Disabled"],
    ] as const) {
      view.rerender(
        <MessageHistoryBackfillProgress progress={progress(status)} />,
      );
      expect(view.getByText(label)).toBeTruthy();
    }

    expect(view.getByText(/Snapshot complete: Yes/u)).toBeTruthy();
    expect(view.getByText(/Caught up: No/u)).toBeTruthy();
    expect(view.getByText("Authenticated without independent parity")).toBeTruthy();
    expect(view.getByText("Independent parity verified")).toBeTruthy();
    expect(view.getAllByText("Unknown")).toHaveLength(2);
    expect(view.getByText(/authenticated ciphertext/u)).toBeTruthy();
    expect(view.getByText(/plaintext counterpart independently/u)).toBeTruthy();
    expect(view.container.textContent).not.toContain("%");
  });

  test("shows failure evidence and explicit unavailable state", () => {
    const view = render(
      <MessageHistoryBackfillProgress
        progress={progress("failed", {
          counts: {...progress("failed").counts, failed: 12},
        })}
      />,
    );
    expect(view.getByText("Failed messages: 12")).toBeTruthy();

    view.rerender(
      <MessageHistoryBackfillProgress progress={null} unavailable />,
    );
    expect(view.getByText(/temporarily unavailable/u)).toBeTruthy();
  });

  test("shows eligible authority-waiting work without unsupported or failure evidence", () => {
    const waiting = progress("waiting");
    const view = render(
      <MessageHistoryBackfillProgress
        progress={progress("waiting", {
          counts: {
            ...waiting.counts,
            eligible: 3,
            claimedRepairing: 0,
            unsupported: 0,
            failed: 0,
          },
          waiting: { authorizedDevice: 0, authority: 3 },
        })}
      />,
    );

    expect(view.getByText("Waiting")).toBeTruthy();
    expect(view.getByText("Eligible messages").nextElementSibling?.textContent).toBe("3");
    expect(view.getByText("Waiting for authority").nextElementSibling?.textContent).toBe("3");
    expect(view.getByText("Unsupported").nextElementSibling?.textContent).toBe("0");
    expect(view.queryByText(/Failed messages:/u)).toBeNull();
  });
});
