import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { Window } from "happy-dom";
import { TaskFundingRecoveryNotice, taskFundingRecovery } from "./task-funding-recovery";

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};

beforeAll(() => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) {
    priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
  });
});

afterEach(cleanup);

afterAll(() => {
  cleanup();
  mock.restore();
  const globals = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

describe("Task funding recovery", () => {
  test("routes a missing personal key to its Settings section", () => {
    const view = render(<TaskFundingRecoveryNotice code="personal_credential_missing" />);
    expect(view.getByRole("status").textContent).toContain("Add the missing key");
    expect(view.getByRole("link", { name: "Personal API keys" }).getAttribute("href"))
      .toBe("/settings#personal-provider-keys");
  });

  test("requires a fresh task when the admitted credential revision changed", () => {
    const recovery = taskFundingRecovery("personal_credential_stale");
    expect(recovery.requiresFreshTask).toBe(true);
    expect(recovery.message).toContain("Start a fresh task");
    expect(recovery.message).toContain("cannot resume");
  });

  test("does not route server access failures to personal key management", () => {
    const view = render(<TaskFundingRecoveryNotice code="server_credentials_forbidden" />);
    expect(view.getByRole("status").textContent).toContain("administrator");
    expect(view.queryByRole("link")).toBeNull();
  });
});
