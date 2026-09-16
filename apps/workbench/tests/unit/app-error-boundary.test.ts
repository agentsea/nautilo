/**
 * Regression lock — AppErrorBoundary behavior.
 *
 * Context: without this boundary, a single uncaught throw anywhere in
 * the descendant tree unmounts the whole app and leaves the user with
 * a blank viewport. That's the second half of today's gray-screen
 * post-mortem — the first half was the duplicate message id (see
 * message-id.test.ts); this half is the missing safety net that made
 * every transient throw catastrophic.
 *
 * Testing strategy: we don't render anything (the workbench test
 * harness doesn't have RTL). Instead we instantiate the class
 * directly and exercise its React lifecycle methods — that's the
 * contract the framework calls, and the contract we want pinned.
 */

import { describe, test, expect } from "bun:test";
import type { ErrorInfo } from "react";

import { AppErrorBoundary } from "../../src/components/app-error-boundary";

function makeBoundary(): AppErrorBoundary {
  // The class is a React component but its lifecycle methods are
  // plain TS. We construct it with a minimal props object — the tree
  // isn't going to be rendered anyway.
  return new AppErrorBoundary({ children: null, label: "test" });
}

describe("AppErrorBoundary — lifecycle contract (do not remove)", () => {
  test("initial state has no error", () => {
    const b = makeBoundary();
    expect(b.state).toEqual({ error: null });
  });

  test("getDerivedStateFromError promotes the thrown error into state", () => {
    const err = new Error("boom");
    const next = AppErrorBoundary.getDerivedStateFromError(err);
    expect(next).toEqual({ error: err });
  });

  test("componentDidCatch logs via console.error with the label prefix", () => {
    // Patch console.error briefly; capture invocations.
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const b = makeBoundary();
      const err = new Error("boom");
      const info: ErrorInfo = { componentStack: "\n  at SomeComponent" };
      b.componentDidCatch(err, info);
      expect(calls.length).toBe(1);
      // The first arg should carry the "[error-boundary:test]"
      // prefix — that's what makes multi-boundary logs grep-able.
      expect(String(calls[0]![0])).toContain("[error-boundary:test]");
    } finally {
      console.error = original;
    }
  });

  test("componentDidCatch uses 'app' as the label fallback when none provided", () => {
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const b = new AppErrorBoundary({ children: null });
      b.componentDidCatch(new Error("boom"), { componentStack: "" });
      expect(String(calls[0]![0])).toContain("[error-boundary:app]");
    } finally {
      console.error = original;
    }
  });

  test("the component exposes the React class-component error-boundary API", () => {
    // Belt-and-suspenders: React keys off these exact static/method
    // names to decide a component IS an error boundary. If a refactor
    // ever breaks either, React silently bypasses the boundary and
    // we're back to "throw = unmount the whole app".
    expect(typeof AppErrorBoundary.getDerivedStateFromError).toBe("function");
    expect(typeof AppErrorBoundary.prototype.componentDidCatch).toBe("function");
    expect(typeof AppErrorBoundary.prototype.render).toBe("function");
  });
});
