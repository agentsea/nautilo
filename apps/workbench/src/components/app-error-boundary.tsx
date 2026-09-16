/**
 * App-level error boundary (D087 UX hotfix).
 *
 * Context: without any error boundary in the tree, a single throw from
 * any descendant (e.g. assistant-ui's MessageRepository rejecting a
 * duplicate message id, a rare render exception in a tool-card
 * renderer, …) bubbles all the way to React's default handler, which
 * UNMOUNTS the entire app and leaves the user staring at a blank
 * window. That was the "gray screen, have to ⌘R" bug we kept hitting
 * through D087 iteration — every stray exception was fatal.
 *
 * This boundary wraps the app's runtime provider subtree. When a
 * descendant throws, we catch, log the error, and render a small
 * recovery card with a "Reload" button. The user never sees a blank
 * screen; developers still see the error in devtools and in the
 * electron-debug console log stream (we re-emit via console.error so
 * the MCP-tailed log captures it).
 *
 * This is a class component because React's error-boundary API only
 * exists on class lifecycle methods (componentDidCatch / getDerivedStateFromError).
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Optional tag ("runtime", "conversation", …) to include in the
   *  log message so multiple boundaries in the tree are distinguishable. */
  label?: string;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Re-emit through console.error so the electron-debug MCP's log
    // tail picks it up alongside the React-thrown exception. The
    // stack in `info.componentStack` is the React subtree stack;
    // `error.stack` is the JS stack — keep both for triage.
    // Prefix the tag so multi-boundary trees are grep-able.
    const tag = this.props.label ?? "app";
     
    console.error(
      `[error-boundary:${tag}] caught render error:`,
      error,
      "component-stack:",
      info.componentStack,
    );
  }

  private handleReload = (): void => {
    // Full reload — safer than a partial reset because the runtime
    // provider owns WS connections, refs, and streams that can get
    // orphaned if we just retry the render. A reload flushes
    // everything consistently, the same recovery pattern the user
    // was manually invoking with ⌘R.
    window.location.reload();
  };

  private handleDismiss = (): void => {
    // Attempt a partial recovery — clear the error and let the tree
    // try to re-render. Useful when the error was transient (e.g.
    // duplicate-id throw that's unlikely to recur). If the throw
    // fires again, we'll land right back here and the Reload button
    // is still available.
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const err = this.state.error;
    const message = err.message || String(err);
    return (
      <div
        role="alert"
        className="flex h-full w-full items-center justify-center bg-background p-8 text-foreground"
      >
        <div className="max-w-md space-y-4 rounded-lg border border-border bg-background-panel p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="text-xl">⚠</span>
            <h2 className="text-base font-semibold">Something broke.</h2>
          </div>
          <p className="text-sm text-foreground-muted">
            A component crashed during render. The app stayed put so you
            don&apos;t have to force-quit. You can try dismissing (it might
            be transient) or reload fresh.
          </p>
          <pre className="max-h-40 overflow-auto rounded bg-background-element p-2 text-[11px] font-mono text-foreground-muted">
            {message}
          </pre>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={this.handleDismiss}
              className="rounded-md border border-border bg-background-element px-3 py-1.5 text-xs font-medium text-foreground hover:border-border-strong"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] hover:bg-primary-hover"
            >
              Reload window
            </button>
          </div>
        </div>
      </div>
    );
  }
}
