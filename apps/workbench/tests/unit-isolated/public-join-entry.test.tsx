import "../bun-dom-preload";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { AuthSessionState } from "../../src/hooks/use-auth-browser-state";

let sessionState: AuthSessionState = "unknown";
mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({ session: { state: sessionState } }),
}));
const { PublicJoinEntry } = await import("../../src/routes/public-join-entry");

function Destination() {
  const location = useLocation();
  return <p>{location.pathname}</p>;
}

function renderEntry(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/join/continue" element={<PublicJoinEntry />} />
        <Route path="/redeem/:token" element={<Destination />} />
        <Route path="/" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe("public join entry", () => {
  test("a signed-in visitor goes straight into the app even with no active invite", () => {
    sessionState = "signed-in";
    const view = renderEntry("/join/continue");
    expect(view.getByText("/")).toBeTruthy();
    expect(view.queryByText("Invitation unavailable")).toBeNull();
  });

  test("a signed-in visitor ignores the invitation and enters the app", () => {
    sessionState = "signed-in";
    const view = renderEntry(`/join/continue?invite=inv_${"a".repeat(32)}`);
    expect(view.getByText("/")).toBeTruthy();
    expect(view.queryByText(/^\/redeem/u)).toBeNull();
  });

  test("a signed-out visitor follows the selected invitation", () => {
    sessionState = "signed-out";
    const view = renderEntry(`/join/continue?invite=inv_${"a".repeat(32)}`);
    expect(view.getByText(`/redeem/inv_${"a".repeat(32)}`)).toBeTruthy();
  });

  test("a signed-out visitor sees an unavailable message when joins are closed", () => {
    sessionState = "signed-out";
    const view = renderEntry("/join/continue");
    expect(view.getByText("Invitation unavailable")).toBeTruthy();
  });

  test("auth hydration never sends an existing member to the invite wizard", () => {
    sessionState = "unknown";
    const view = renderEntry(`/join/continue?invite=inv_${"a".repeat(32)}`);
    expect(view.getByText("Checking your sign-in…")).toBeTruthy();
    sessionState = "signed-in";
    view.rerender(
      <MemoryRouter initialEntries={[`/join/continue?invite=inv_${"a".repeat(32)}`]}>
        <Routes>
          <Route path="/join/continue" element={<PublicJoinEntry />} />
          <Route path="/redeem/:token" element={<Destination />} />
          <Route path="/" element={<Destination />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(view.getByText("/")).toBeTruthy();
  });
});
