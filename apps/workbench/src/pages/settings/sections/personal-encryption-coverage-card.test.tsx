import "../../../../tests/bun-dom-preload";
import {
  act,
  cleanup,
  fireEvent,
  render,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";
import type { PersonalEncryptionCoverageV1 } from "@nautilo/api-client/browser";

let sessionUserId = "user-1";

mock.module("../../../hooks/use-auth", () => ({
  useAuth: () => ({
    viewer: {
      isVerified: true,
      staleWhoami: false,
      sessionUserId,
    },
  }),
}));

const { PersonalEncryptionCoverageCard } = await import(
  "./personal-encryption-coverage-card"
);
const { dispatchAuthTransition } = await import("../../../lib/auth-transition");

function measured(
  family: "message" | "memory" | "journal_event" | "reflection_record" | "artifact",
  accessible = "10",
  plaintextPresent = "8",
  encryptedCounterpart = "3",
) {
  return {
    family,
    measurement: "measured" as const,
    accessible,
    plaintextPresent,
    encryptedCounterpart,
  };
}

function activeSnapshot(
  overrides: Partial<PersonalEncryptionCoverageV1> = {},
): PersonalEncryptionCoverageV1 {
  return {
    dtoVersion: 1,
    policy: "shadow_encryption",
    computedAt: new Date(Date.now()).toISOString(),
    families: [
      measured("message", "4731", "4731", "127"),
      measured("memory", "0", "0", "0"),
      measured("journal_event"),
      measured("reflection_record"),
      measured("artifact"),
      {
        family: "task",
        measurement: "unsupported",
        accessible: "34",
        plaintextPresent: "34",
        encryptedCounterpart: null,
      },
    ],
    ...overrides,
  } as PersonalEncryptionCoverageV1;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setVisibility(value: "hidden" | "visible"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  cleanup();
  sessionUserId = "user-1";
  setVisibility("visible");
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

afterAll(() => mock.restore());

describe("PersonalEncryptionCoverageCard", () => {
  test("renders the stable accessible table, overlapping counts, percentages, and explicit measurement states", async () => {
    const snapshot = activeSnapshot({
      families: [
        measured("message", "4731", "4731", "127"),
        measured("memory", "0", "0", "0"),
        measured("journal_event"),
        {
          family: "reflection_record",
          measurement: "unavailable",
          accessible: null,
          plaintextPresent: null,
          encryptedCounterpart: null,
        },
        measured("artifact"),
        {
          family: "task",
          measurement: "unsupported",
          accessible: "34",
          plaintextPresent: "34",
          encryptedCounterpart: null,
        },
      ],
    });
    const getPersonal = mock(async () => snapshot);
    const view = render(
      <PersonalEncryptionCoverageCard coveragePort={{ getPersonal }} />,
    );
    await flush();

    expect(view.getByRole("table")).toBeTruthy();
    expect(view.getAllByRole("row")).toHaveLength(7);
    expect(view.getByText(/counts overlap/u)).toBeTruthy();
    expect(view.getByRole("row", { name: /Messages/u }).textContent)
      .toContain("4,731");
    expect(view.getByRole("row", { name: /Messages/u }).textContent)
      .toContain("2.7%");
    expect(view.getByRole("row", { name: /Memories/u }).textContent)
      .toContain("—");
    expect(view.getByRole("row", { name: /Reflection records/u }).textContent)
      .toContain("Temporarily unavailable");
    expect(view.getByRole("row", { name: /Tasks and subtasks/u }).textContent)
      .toContain("Not supported yet");
    expect(view.getByText("Last updated just now")).toBeTruthy();
    expect(view.getByText(/Whole-product and internal security coverage/u))
      .toBeTruthy();
  });

  test("fetches initially and every 60 seconds while visible", async () => {
    jest.useFakeTimers();
    const getPersonal = mock(async () => activeSnapshot());
    render(<PersonalEncryptionCoverageCard coveragePort={{ getPersonal }} />);
    await flush();
    expect(getPersonal).toHaveBeenCalledTimes(1);

    await act(async () => jest.advanceTimersByTime(59_999));
    expect(getPersonal).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(1));
    await flush();
    expect(getPersonal).toHaveBeenCalledTimes(2);
  });

  test("refreshes canonical Message repair progress with the coverage snapshot", async () => {
    jest.useFakeTimers();
    const getPersonal = mock(async () => activeSnapshot());
    const getMessageBackfillProgress = mock(async () => ({
      status: "waiting" as const,
      snapshotAt: Date.UTC(2026, 8, 8, 12, 30),
      snapshotComplete: true,
      caughtUp: false,
      lastSweepAt: null,
      activeLease: false,
      counts: {eligible: 9, alreadyAuthenticated: 2,
        independentlyParityVerified: 3, claimedRepairing: 0,
        repairedAndVerified: 1, unsupported: 1, failed: 3},
      waiting: {authorizedDevice: null, authority: null},
    }));
    const view = render(
      <PersonalEncryptionCoverageCard coveragePort={{
        getPersonal,
        getMessageBackfillProgress,
      }} />,
    );
    await flush();

    expect(getPersonal).toHaveBeenCalledTimes(1);
    expect(getMessageBackfillProgress).toHaveBeenCalledTimes(1);
    expect(view.getByText("Waiting")).toBeTruthy();
    expect(view.getByText("Failed messages: 3")).toBeTruthy();
    expect(view.getByText(/Snapshot complete: Yes/u)).toBeTruthy();
    expect(view.getByText(/Caught up: No/u)).toBeTruthy();

    setVisibility("hidden");
    await act(async () => jest.advanceTimersByTime(120_000));
    expect(getMessageBackfillProgress).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(getMessageBackfillProgress).toHaveBeenCalledTimes(2);
  });

  test("settles coverage independently of pending progress and aborts both across scope changes", async () => {
    const coverageSignals: AbortSignal[] = [];
    const progressSignals: AbortSignal[] = [];
    const getPersonal = mock((options?: { signal?: AbortSignal }) => {
      if (options?.signal) coverageSignals.push(options.signal);
      return Promise.resolve(activeSnapshot());
    });
    const getMessageBackfillProgress = mock(
      (options?: { signal?: AbortSignal }) => {
        if (options?.signal) progressSignals.push(options.signal);
        return new Promise<never>(() => {});
      },
    );
    const coveragePort = { getPersonal, getMessageBackfillProgress };
    const view = render(
      <PersonalEncryptionCoverageCard coveragePort={coveragePort} />,
    );
    await flush();

    expect(view.getByRole("table")).toBeTruthy();
    expect(view.getByRole("button", { name: "Refresh now" }).getAttribute("disabled"))
      .toBeNull();
    expect(coverageSignals).toHaveLength(1);
    expect(progressSignals).toHaveLength(1);
    expect(progressSignals[0]).toBe(coverageSignals[0]);

    sessionUserId = "user-2";
    view.rerender(
      <PersonalEncryptionCoverageCard coveragePort={coveragePort} />,
    );
    await flush();

    expect(coverageSignals[0]?.aborted).toBe(true);
    expect(getPersonal).toHaveBeenCalledTimes(2);
    expect(getMessageBackfillProgress).toHaveBeenCalledTimes(2);
    expect(progressSignals[1]).toBe(coverageSignals[1]);

    view.unmount();
    expect(coverageSignals[1]?.aborted).toBe(true);
  });

  test("does not periodically poll in plaintext-only mode", async () => {
    jest.useFakeTimers();
    const inactive: PersonalEncryptionCoverageV1 = {
      dtoVersion: 1,
      policy: "plaintext_only",
      computedAt: null,
      families: [],
    };
    const getPersonal = mock(async () => inactive);
    const view = render(
      <PersonalEncryptionCoverageCard coveragePort={{ getPersonal }} />,
    );
    await flush();
    await act(async () => jest.advanceTimersByTime(180_000));
    expect(getPersonal).toHaveBeenCalledTimes(1);
    expect(view.getByText(/coverage is not active while/u)).toBeTruthy();
    expect(view.queryByRole("table")).toBeNull();
    expect(view.queryByRole("button", { name: "Refresh now" })).toBeNull();
  });

  test("refreshes on return to visibility only when the snapshot is stale", async () => {
    jest.useFakeTimers();
    const getPersonal = mock(async () => activeSnapshot());
    render(<PersonalEncryptionCoverageCard coveragePort={{ getPersonal }} />);
    await flush();
    setVisibility("hidden");
    await act(async () => jest.advanceTimersByTime(120_000));
    expect(getPersonal).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(getPersonal).toHaveBeenCalledTimes(2);
  });

  test("waits to perform its initial request until Settings is visible", async () => {
    setVisibility("hidden");
    const getPersonal = mock(async () => activeSnapshot());
    render(<PersonalEncryptionCoverageCard coveragePort={{ getPersonal }} />);
    await flush();
    expect(getPersonal).not.toHaveBeenCalled();

    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(getPersonal).toHaveBeenCalledTimes(1);
  });

  test("coalesces refreshes and aborts the active request on unmount", async () => {
    jest.useFakeTimers();
    let resolve!: (value: PersonalEncryptionCoverageV1) => void;
    let observedSignal: AbortSignal | undefined;
    const getPersonal = mock((options?: { signal?: AbortSignal }) => {
      observedSignal = options?.signal;
      return new Promise<PersonalEncryptionCoverageV1>((done) => {
        resolve = done;
      });
    });
    const view = render(
      <PersonalEncryptionCoverageCard coveragePort={{ getPersonal }} />,
    );
    await flush();
    await act(async () => jest.advanceTimersByTime(60_000));
    expect(getPersonal).toHaveBeenCalledTimes(1);
    expect(view.getByRole("button", { name: "Refresh now" }).getAttribute("disabled"))
      .not.toBeNull();

    view.unmount();
    expect(observedSignal?.aborted).toBe(true);
    resolve(activeSnapshot());
    await flush();
  });

  test("cancels the prior account request and starts a fresh scoped request", async () => {
    const signals: AbortSignal[] = [];
    const getPersonal = mock((options?: { signal?: AbortSignal }) => {
      if (options?.signal) signals.push(options.signal);
      return new Promise<PersonalEncryptionCoverageV1>(() => {});
    });
    const view = render(
      <PersonalEncryptionCoverageCard coveragePort={{ getPersonal }} />,
    );
    await flush();
    sessionUserId = "user-2";
    view.rerender(
      <PersonalEncryptionCoverageCard coveragePort={{ getPersonal }} />,
    );
    await flush();

    expect(signals[0]?.aborted).toBe(true);
    expect(getPersonal).toHaveBeenCalledTimes(2);
  });

  test("cancels and re-scopes coverage when the connected server changes", async () => {
    const signals: AbortSignal[] = [];
    const getPersonal = mock((options?: { signal?: AbortSignal }) => {
      if (options?.signal) signals.push(options.signal);
      return new Promise<PersonalEncryptionCoverageV1>(() => {});
    });
    render(<PersonalEncryptionCoverageCard coveragePort={{ getPersonal }} />);
    await flush();
    act(() => dispatchAuthTransition({
      credentialGeneration: 2,
      viewerGeneration: 2,
      reason: "instance-switched",
    }));
    await flush();

    expect(signals[0]?.aborted).toBe(true);
    expect(getPersonal).toHaveBeenCalledTimes(2);
  });

  test("retains stale results after an error and recovers on manual refresh", async () => {
    const getPersonal = mock(async () => activeSnapshot());
    const view = render(
      <PersonalEncryptionCoverageCard coveragePort={{ getPersonal }} />,
    );
    await flush();
    getPersonal.mockImplementationOnce(async () => {
      throw new Error("private server detail");
    });
    fireEvent.click(view.getByRole("button", { name: "Refresh now" }));
    await flush();
    expect(view.getByRole("table")).toBeTruthy();
    expect(view.getByRole("alert").textContent).not.toContain("private server detail");
    expect(view.getByRole("status").textContent).toContain("refresh failed");

    fireEvent.click(view.getByRole("button", { name: "Refresh now" }));
    await flush();
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByRole("status").textContent).toContain("refreshed");
  });

  test("keeps the retained snapshot age moving after refresh failure", async () => {
    jest.useFakeTimers();
    const getPersonal = mock(async () => activeSnapshot());
    const view = render(
      <PersonalEncryptionCoverageCard coveragePort={{ getPersonal }} />,
    );
    await flush();
    getPersonal.mockImplementation(async () => {
      throw new Error("offline");
    });

    await act(async () => jest.advanceTimersByTime(60_000));
    await flush();
    expect(view.getByText("Last updated 1 minute ago")).toBeTruthy();
    expect(view.getByRole("table")).toBeTruthy();
  });
});
