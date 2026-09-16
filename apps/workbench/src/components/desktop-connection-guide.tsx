import { useState } from "react";
import { copyTextToClipboard } from "../lib/copy-to-clipboard";

export function DesktopConnectionGuide({
  serverUrl,
  urlTestId = "server-guide-application-url",
}: {
  serverUrl: string | null;
  urlTestId?: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  let isLocalhost = false;
  if (serverUrl) {
    try {
      const hostname = new URL(serverUrl).hostname;
      isLocalhost =
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "[::1]";
    } catch {
      // The setup projection owns URL validation. Keep malformed values visible
      // for diagnosis without making claims about where they are reachable.
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-border bg-background-element p-4">
      <p className="text-sm font-medium text-foreground">
        Connect Desktop to this server
      </p>
      <p className="mt-1 text-sm leading-6 text-foreground-muted">
        Open Nautilo Desktop, enter this address in the{" "}
        <strong>Server URL</strong> field, choose <strong>Connect</strong>, then
        continue through secure sign-in.
      </p>
      {serverUrl ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code
            className="min-w-0 flex-1 select-all overflow-x-auto rounded-md bg-background px-3 py-2 text-sm text-foreground"
            data-testid={urlTestId}
          >
            {serverUrl}
          </code>
          <button
            type="button"
            className="rounded-md border border-border-strong px-3 py-2 text-sm text-primary hover:bg-background-muted"
            onClick={() => {
              void copyTextToClipboard(serverUrl).then((copied) => {
                setCopyState(copied ? "copied" : "failed");
              });
            }}
          >
            {copyState === "copied" ? "Copied" : "Copy URL"}
          </button>
          {copyState === "failed" ? (
            <span
              className="w-full text-xs text-foreground-muted"
              role="status"
            >
              Copy failed. Select the URL and copy it manually.
            </span>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-sm text-foreground-muted" role="status">
          The application URL is temporarily unavailable. Reload this guide
          before connecting Desktop.
        </p>
      )}
      {isLocalhost ? (
        <p className="mt-3 text-xs leading-5 text-foreground-muted">
          This localhost address works only when Desktop is on the computer
          running the server. On another computer, use the server&apos;s
          reachable address or ask your administrator.
        </p>
      ) : (
        <p className="mt-3 text-xs leading-5 text-foreground-muted">
          If Desktop is on another computer, this address must be reachable from
          that computer. Ask your administrator if it does not connect.
        </p>
      )}
    </div>
  );
}
